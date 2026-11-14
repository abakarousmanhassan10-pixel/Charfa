/**
 * Phase N20: multi-agent marketing contracts shared by the API and the web app.
 * Agents are plain, typed, bounded units. None of them can publish, send a message, or spend money: those powers do not
 * exist in this vocabulary. Publishing stays in the N18 individual approval; customer replies stay in N16/N19 (AUTO only).
 */
export const CAMPAIGN_STATUSES = ['DRAFT', 'PLANNED', 'CONTENT_READY', 'AWAITING_APPROVAL', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type CampaignStatusId = (typeof CAMPAIGN_STATUSES)[number];

const FORWARD: Readonly<Record<CampaignStatusId, readonly CampaignStatusId[]>> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['CONTENT_READY', 'PLANNED', 'CANCELLED'],
  CONTENT_READY: ['AWAITING_APPROVAL', 'CONTENT_READY', 'CANCELLED'],
  AWAITING_APPROVAL: ['ACTIVE', 'CONTENT_READY', 'CANCELLED'],
  ACTIVE: ['COMPLETED', 'AWAITING_APPROVAL', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
export const canMoveCampaign = (from: CampaignStatusId, to: CampaignStatusId): boolean => from === to || FORWARD[from].includes(to);

export const CAMPAIGN_GOALS = ['AWARENESS', 'ENGAGEMENT', 'TRAFFIC', 'LAUNCH'] as const;
export type CampaignGoalType = (typeof CAMPAIGN_GOALS)[number];

export const CAMPAIGN_AGENTS = [
  'PRODUCT_INTELLIGENCE',
  'MARKET_RESEARCH',
  'CREATIVE_STRATEGY',
  'AUDIENCE_STRATEGY',
  'CAMPAIGN_PLANNING',
  'PERFORMANCE_ANALYSIS',
  'CUSTOMER_SERVICE',
] as const;
export type CampaignAgentId = (typeof CAMPAIGN_AGENTS)[number];

/** Powers no agent may ever hold. A contract containing one is rejected at start-up. */
export const FORBIDDEN_AGENT_TOOLS = ['social.publish', 'social.schedule', 'messages.send', 'ads.spend', 'billing.write', 'network.fetch', 'agents.invoke'] as const;

export interface AgentContract {
  id: CampaignAgentId;
  responsibility: string;
  /** Read-only data tools. Publishing, sending, spending and calling other agents are not in the vocabulary. */
  allowedTools: readonly string[];
  /** The tenant data this agent may read, always scoped to one business. */
  dataScope: readonly string[];
  /** Hard limits per campaign. */
  maxExecutionsPerCampaign: number;
  maxAttemptsPerKey: number;
  timeoutMs: number;
  /** Estimated cost per execution in USD millionths. Mock providers cost 0. */
  costMicros: number;
  /** True only for the agent that triages customer messages; it still cannot send anything by itself. */
  touchesCustomers: boolean;
}

const base = { maxAttemptsPerKey: 2, timeoutMs: 5_000, costMicros: 0, touchesCustomers: false } as const;

export const AGENT_CONTRACTS: Readonly<Record<CampaignAgentId, AgentContract>> = {
  PRODUCT_INTELLIGENCE: { ...base, id: 'PRODUCT_INTELLIGENCE', responsibility: 'Summarize each selected product from verified catalog data only.', allowedTools: ['catalog.read', 'knowledge.read'], dataScope: ['product', 'knowledge'], maxExecutionsPerCampaign: 3 },
  MARKET_RESEARCH: { ...base, id: 'MARKET_RESEARCH', responsibility: 'Report market data that exists in the merchant workspace; say "unavailable" otherwise. Never invent statistics.', allowedTools: ['market.read'], dataScope: ['market'], maxExecutionsPerCampaign: 2 },
  CREATIVE_STRATEGY: { ...base, id: 'CREATIVE_STRATEGY', responsibility: 'Propose content ideas and drafts that restate verified product facts.', allowedTools: ['catalog.read', 'brand.read'], dataScope: ['product', 'brand'], maxExecutionsPerCampaign: 4 },
  AUDIENCE_STRATEGY: { ...base, id: 'AUDIENCE_STRATEGY', responsibility: 'Propose audience segments from non-sensitive product and merchant data.', allowedTools: ['catalog.read'], dataScope: ['product'], maxExecutionsPerCampaign: 2 },
  CAMPAIGN_PLANNING: { ...base, id: 'CAMPAIGN_PLANNING', responsibility: 'Build the channel mix, publication calendar proposal and operational cost estimate.', allowedTools: ['catalog.read', 'social.accounts.read'], dataScope: ['product', 'social_accounts'], maxExecutionsPerCampaign: 3 },
  PERFORMANCE_ANALYSIS: { ...base, id: 'PERFORMANCE_ANALYSIS', responsibility: 'Evaluate imported metrics, separating real, simulated and unavailable data; recommend follow-up drafts.', allowedTools: ['analytics.read'], dataScope: ['analytics'], maxExecutionsPerCampaign: 5 },
  CUSTOMER_SERVICE: { ...base, id: 'CUSTOMER_SERVICE', responsibility: 'Triage a customer comment: reply draft, human escalation, or nothing. Sends nothing itself.', allowedTools: ['knowledge.read'], dataScope: ['knowledge', 'comment'], maxExecutionsPerCampaign: 20, touchesCustomers: true },
};

/** Throws when a contract holds a forbidden power or an unbounded limit. Run at start-up and in tests. */
export function assertAgentContracts(contracts: Readonly<Record<string, AgentContract>> = AGENT_CONTRACTS): void {
  for (const c of Object.values(contracts)) {
    const bad = c.allowedTools.find((t) => (FORBIDDEN_AGENT_TOOLS as readonly string[]).includes(t));
    if (bad) throw new Error(`Agent ${c.id} holds forbidden tool ${bad}`);
    if (!(c.timeoutMs > 0 && c.timeoutMs <= 30_000)) throw new Error(`Agent ${c.id} has an invalid timeout`);
    if (!(c.maxExecutionsPerCampaign > 0 && c.maxExecutionsPerCampaign <= 50) || !(c.maxAttemptsPerKey >= 1 && c.maxAttemptsPerKey <= 3)) throw new Error(`Agent ${c.id} has unbounded limits`);
    if (c.costMicros < 0) throw new Error(`Agent ${c.id} has a negative cost`);
  }
}

export const CAMPAIGN_LIMITS = { productsMax: 5, nameMax: 120, goalTextMax: 500, entriesMax: 10, daysMax: 30 } as const;

/** Where a metric comes from, always shown to the merchant. Unavailable is never turned into zero. */
export type MetricOrigin = 'REAL' | 'SIMULATED' | 'UNAVAILABLE';
