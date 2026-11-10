export interface GenerateRequest {
  /** Trusted instructions written by TOUMA (never contains user or business text). */
  system: string;
  /** Delimited, sanitised business data + task. Treated by the model as data. */
  user: string;
  schemaName: string;
  /** Strict JSON Schema for structured output. */
  jsonSchema: Record<string, unknown>;
  model: string;
  temperature?: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface GenerateResult {
  /** Raw JSON text returned by the model (parsed and validated by the engine, never trusted). */
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Text model provider contract. Implementations must:
 *  - read credentials from configuration only (never hardcoded, never logged);
 *  - request schema-constrained JSON output;
 *  - map failures to ProviderError kinds so the engine can decide on retries.
 * No tools/function calling are exposed: agents cannot take external actions.
 */
export interface TextModelProvider {
  readonly name: string;
  isConfigured(): boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export interface ModelPricing {
  /** USD per 1M input tokens. 0 = not configured (costs reported as unknown). */
  inputPerMillion: number;
  outputPerMillion: number;
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  return (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000;
}
