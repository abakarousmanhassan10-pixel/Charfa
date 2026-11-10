/**
 * AI engine contract (Phase 3 implements the orchestrator and the specialised agents).
 *
 * Guarantees the implementation must uphold:
 *  - Every agent produces structured output validated against a schema; invalid output is rejected.
 *  - Agents receive ONLY verified business knowledge (KnowledgeEntry.verified = true, catalog data).
 *    They must not invent prices, stock, delivery promises or policies; unknown facts are returned
 *    as explicit gaps for the user to fill.
 *  - User/customer-provided text is treated as untrusted data, delimited, and never as instructions.
 *  - Tools are allow-listed per agent; side-effecting tools require human approval.
 *  - Every call records AIUsage (tokens, cost, latency) for quotas and billing.
 */
export type AgentName =
  | 'BUSINESS_ANALYST'
  | 'PRODUCT_ANALYST'
  | 'MARKETING_STRATEGIST'
  | 'CONTENT_CREATOR'
  | 'VISUAL_CREATOR'
  | 'VIDEO_CREATOR'
  | 'SCHEDULER'
  | 'CUSTOMER_SUPPORT'
  | 'PERFORMANCE_ANALYST';

export interface AgentContext {
  businessId: string;
  userId: string;
  locale: string;
  knowledge: Array<{ id: string; title: string; body: string }>;
}

export interface AgentResult<T> {
  output: T;
  usage: { provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number };
  /** Facts the agent needed but could not verify; must be surfaced to the user, never guessed. */
  missingInformation: string[];
}

export interface TextModelProvider {
  readonly name: string;
  isConfigured(): boolean;
  generateStructured<T>(args: {
    system: string;
    input: string;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    model?: string;
  }): Promise<{ data: T; inputTokens: number; outputTokens: number; model: string }>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string, envVar: string) {
    super(`${provider} is not configured (set ${envVar}).`);
    this.name = 'ProviderNotConfiguredError';
  }
}
