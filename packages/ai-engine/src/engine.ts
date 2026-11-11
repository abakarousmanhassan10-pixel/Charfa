import type { z, ZodTypeAny } from 'zod';
import type { AgentDefinition } from './agents/types';
import type { BusinessContext } from './context';
import { OutputValidationError, ProviderError, ProviderNotConfiguredError } from './errors';
import type { TextModelProvider } from './provider';
import { buildUserMessage, GUARDRAILS } from './safety';
import { toStrictJsonSchema } from './strict-schema';
import { checkGrounding } from './grounding';

export interface EngineConfig {
  model: string;
  /** null = do not send a temperature (some models reject it). */
  temperature?: number | null;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Retries for transient provider errors (rate limit, timeout, 5xx, network). */
  maxProviderRetries: number;
  /** Extra calls that send validation feedback to the model to repair its answer. */
  maxRepairAttempts: number;
}

export interface AttemptRecord {
  attempt: number;
  kind: 'initial' | 'provider-retry' | 'repair';
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  issues?: string[];
}

export interface AgentRunResult<T> {
  output: T;
  attempts: AttemptRecord[];
  model: string;
}

export class AgentRunError extends Error {
  constructor(
    readonly error: Error,
    readonly attempts: AttemptRecord[],
  ) {
    super(error.message);
    this.name = 'AgentRunError';
  }
}

const sleepDefault = (ms: number) => new Promise((r) => setTimeout(r, ms));
const schemaCache = new WeakMap<ZodTypeAny, Record<string, unknown>>();

/**
 * Runs one agent: builds the delimited prompt, calls the provider with transient-error retries,
 * parses and validates (schema + grounding + agent rules) and, if needed, asks the model to repair
 * its answer with the validation feedback. Every provider call is reported in `attempts` for usage
 * accounting, including failed ones.
 */
export async function runAgent<I, S extends ZodTypeAny>(
  agent: AgentDefinition<I, S>,
  args: {
    provider: TextModelProvider;
    context: BusinessContext;
    input: I;
    instructions?: string | null;
    config: EngineConfig;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<AgentRunResult<z.infer<S>>> {
  const { provider, context, input, config } = args;
  const sleep = args.sleep ?? sleepDefault;
  if (!provider.isConfigured()) throw new AgentRunError(new ProviderNotConfiguredError(provider.name, 'provider credentials'), []);

  let jsonSchema = schemaCache.get(agent.schema);
  if (!jsonSchema) schemaCache.set(agent.schema, (jsonSchema = toStrictJsonSchema(agent.schema)));
  const system = `${agent.system(input)}\n\n${GUARDRAILS}`;
  const scoped = agent.scopeContext ? agent.scopeContext(context, input) : context;
  const attempts: AttemptRecord[] = [];
  let feedback: string[] = [];

  for (let repair = 0; repair <= config.maxRepairAttempts; repair++) {
    const user = buildUserMessage({ context: scoped, task: agent.taskParams(input), instructions: args.instructions, feedback });
    let raw: string | null = null;
    for (let retry = 0; ; retry++) {
      const started = Date.now();
      const kind: AttemptRecord['kind'] = retry > 0 ? 'provider-retry' : repair > 0 ? 'repair' : 'initial';
      try {
        const res = await provider.generate({
          system,
          user,
          schemaName: agent.schemaName,
          jsonSchema,
          model: config.model,
          temperature: config.temperature === null ? undefined : (config.temperature ?? agent.defaultTemperature),
          maxOutputTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
        });
        attempts.push({ attempt: attempts.length + 1, kind, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, latencyMs: Date.now() - started, success: true });
        raw = res.text;
        break;
      } catch (err) {
        attempts.push({ attempt: attempts.length + 1, kind, model: config.model, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, success: false, error: (err as Error).message });
        const retryable = err instanceof ProviderError && err.retryable && retry < config.maxProviderRetries;
        if (!retryable) throw new AgentRunError(err as Error, attempts);
        await sleep(Math.min(8000, 500 * 2 ** retry) + Math.floor(Math.random() * 250));
      }
    }

    const issues: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw!);
    } catch {
      issues.push('The answer was not valid JSON');
    }
    let value: z.infer<S> | undefined;
    if (issues.length === 0) {
      const result = agent.schema.safeParse(parsed);
      if (!result.success) {
        issues.push(...result.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
      } else {
        value = result.data;
        issues.push(...checkGrounding(value, context), ...agent.validate(value!, context, input));
      }
    }
    if (issues.length === 0) return { output: value!, attempts, model: attempts[attempts.length - 1]!.model };
    attempts[attempts.length - 1]!.success = false;
    attempts[attempts.length - 1]!.issues = issues;
    feedback = issues;
  }
  throw new AgentRunError(new OutputValidationError(feedback), attempts);
}
