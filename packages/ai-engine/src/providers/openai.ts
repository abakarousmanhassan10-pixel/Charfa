import OpenAI from 'openai';
import { ProviderError, ProviderNotConfiguredError } from '../errors';
import type { GenerateRequest, GenerateResult, TextModelProvider } from '../provider';

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  /** Test seam: the SDK sends its HTTP requests through this function (used with a mock, so no network is involved). */
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI through the official SDK and the Responses API, with Structured Outputs (json_schema, strict).
 *
 * - The model comes from the request (configuration), never from this class.
 * - `store: false`: OpenAI is asked not to keep the conversation.
 * - Retries are done by the engine (bounded, with feedback), so the SDK's own retries are off.
 * - No tools are sent: an agent cannot act outside TOUMA.
 * - Error messages are written here, never copied from the SDK or the API, because those can echo request fragments or a partial key.
 */
export class OpenAIProvider implements TextModelProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;

  constructor(private readonly opts: OpenAIProviderOptions) {}

  isConfigured() {
    return Boolean(this.opts.apiKey);
  }

  private sdk(): OpenAI {
    this.client ??= new OpenAI({
      apiKey: this.opts.apiKey,
      ...(this.opts.baseUrl ? { baseURL: this.opts.baseUrl.replace(/\/+$/, '') } : {}),
      ...(this.opts.organization ? { organization: this.opts.organization } : {}),
      ...(this.opts.fetchImpl ? { fetch: this.opts.fetchImpl } : {}),
      maxRetries: 0,
    });
    return this.client;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.opts.apiKey) throw new ProviderNotConfiguredError('OpenAI', 'OPENAI_API_KEY');
    let res: OpenAI.Responses.Response;
    try {
      res = await this.sdk().responses.create(
        {
          model: req.model,
          instructions: req.system,
          input: req.user,
          text: { format: { type: 'json_schema', name: req.schemaName, strict: true, schema: req.jsonSchema } },
          max_output_tokens: req.maxOutputTokens,
          store: false,
          ...(req.temperature !== undefined && req.temperature !== null ? { temperature: req.temperature } : {}),
          ...(req.safetyId ? { safety_identifier: req.safetyId } : {}),
        },
        { timeout: req.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      throw mapOpenAIError(err, req.timeoutMs);
    }

    for (const item of res.output ?? []) {
      if (item.type !== 'message') continue;
      for (const part of item.content) if (part.type === 'refusal') throw new ProviderError('refusal', 'The model refused the request');
    }
    if (res.status === 'incomplete') {
      const reason = res.incomplete_details?.reason;
      if (reason === 'content_filter') throw new ProviderError('refusal', 'The answer was blocked by the provider content filter');
      throw new ProviderError('truncated', 'The answer was cut off (max output tokens reached)');
    }
    if (res.status === 'failed') throw new ProviderError('server', `OpenAI could not complete the response ${String(res.error?.code ?? '').slice(0, 40)}`.trim());
    const text = res.output_text;
    if (typeof text !== 'string' || text.length === 0) throw new ProviderError('server', 'OpenAI returned an empty answer');
    return { text, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, model: res.model ?? req.model };
  }
}

/** Maps SDK errors to provider errors with fixed, safe messages (a short error code at most). */
export function mapOpenAIError(err: unknown, timeoutMs: number): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError || (err as { name?: string })?.name === 'AbortError') return new ProviderError('timeout', `OpenAI request timed out after ${timeoutMs} ms`);
  if (err instanceof OpenAI.APIUserAbortError) return new ProviderError('timeout', `OpenAI request timed out after ${timeoutMs} ms`);
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError('network', 'Could not reach OpenAI');
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const code = String(err.code ?? err.type ?? '').replace(/[^\w.-]/g, '').slice(0, 60);
    if (status === 401 || status === 403) return new ProviderError('auth', `OpenAI rejected the credentials (${status})`, status);
    // "insufficient_quota" means the account has no credit left: retrying cannot help, unlike a momentary rate limit.
    if (status === 429 && code === 'insufficient_quota') return new ProviderError('quota', 'The OpenAI account has no remaining credit or quota', 429);
    if (status === 429) return new ProviderError('rate_limit', `OpenAI rate limit reached ${code}`.trim(), 429);
    if (status !== undefined && status >= 500) return new ProviderError('server', `OpenAI server error ${status}`, status);
    return new ProviderError('bad_request', `OpenAI rejected the request (${status ?? '?'}) ${code}`.trim(), status);
  }
  return new ProviderError('network', 'Could not reach OpenAI');
}
