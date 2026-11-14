import { FORBIDDEN_AGENT_TOOLS } from './campaign';

/**
 * Phase N22: the executive orchestrator's agents. They read authorized data and produce decision proposals.
 * None can change a price, issue a refund, charge a payment, spend on advertising, publish or message a customer.
 */
export const EXECUTIVE_AGENTS = ['MARKETING', 'SALES', 'MARKET_ANALYST', 'FINANCE_ANALYST', 'CUSTOMER_INTELLIGENCE', 'OPTIMIZATION'] as const;
export type ExecutiveAgentId = (typeof EXECUTIVE_AGENTS)[number];

export const EXECUTIVE_FORBIDDEN_TOOLS = [...FORBIDDEN_AGENT_TOOLS, 'pricing.write', 'refund.issue', 'orders.write', 'payments.charge', 'ads.budget.write', 'catalog.write'] as const;

export interface ExecutiveContract {
  id: ExecutiveAgentId;
  responsibility: string;
  allowedTools: readonly string[];
  dataScope: readonly string[];
  timeoutMs: number;
  /** Estimated cost per run in USD millionths. Deterministic agents cost 0. */
  costMicros: number;
}
const t = 5_000;
export const EXECUTIVE_CONTRACTS: Readonly<Record<ExecutiveAgentId, ExecutiveContract>> = {
  MARKETING: { id: 'MARKETING', responsibility: 'Summarize campaign status and measured performance, keeping real, simulated and unavailable data apart.', allowedTools: ['campaigns.read', 'analytics.read'], dataScope: ['campaign', 'analytics'], timeoutMs: t, costMicros: 0 },
  SALES: { id: 'SALES', responsibility: 'Report the sales data that exists. Order and revenue figures are not collected by TOUMA, so this is usually "missing".', allowedTools: ['sales.read'], dataScope: ['sales'], timeoutMs: t, costMicros: 0 },
  MARKET_ANALYST: { id: 'MARKET_ANALYST', responsibility: 'Report market data held in the workspace. Never estimate market sizes or competitor figures.', allowedTools: ['market.read'], dataScope: ['market'], timeoutMs: t, costMicros: 0 },
  FINANCE_ANALYST: { id: 'FINANCE_ANALYST', responsibility: 'Compute unit economics from merchant-entered costs. A missing cost stays missing.', allowedTools: ['catalog.read', 'finance.read'], dataScope: ['product', 'finance'], timeoutMs: t, costMicros: 0 },
  CUSTOMER_INTELLIGENCE: { id: 'CUSTOMER_INTELLIGENCE', responsibility: 'Summarize minimized customer-question themes. No text, names or identifiers leave this agent.', allowedTools: ['comments.read.minimized', 'knowledge.read'], dataScope: ['comment_topics', 'knowledge'], timeoutMs: t, costMicros: 0 },
  OPTIMIZATION: { id: 'OPTIMIZATION', responsibility: 'Turn the other agents\' findings into decision proposals for the merchant. Proposes only.', allowedTools: ['recommendations.propose'], dataScope: ['findings'], timeoutMs: t, costMicros: 0 },
};

export function assertExecutiveContracts(contracts: Readonly<Record<string, ExecutiveContract>> = EXECUTIVE_CONTRACTS): void {
  for (const c of Object.values(contracts)) {
    const bad = c.allowedTools.find((x) => (EXECUTIVE_FORBIDDEN_TOOLS as readonly string[]).includes(x));
    if (bad) throw new Error(`Executive agent ${c.id} holds forbidden tool ${bad}`);
    if (!(c.timeoutMs > 0 && c.timeoutMs <= 30_000)) throw new Error(`Executive agent ${c.id} has an invalid timeout`);
    if (c.costMicros < 0) throw new Error(`Executive agent ${c.id} has a negative cost`);
  }
}
