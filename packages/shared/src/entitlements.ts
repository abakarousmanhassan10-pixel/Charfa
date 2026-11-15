/**
 * What a plan gives (N27): which agents and features a business may use and its monthly quotas. Pure functions; the server enforces them
 * (a browser cannot grant itself anything). Entitlements live in Plan.limits (JSON). A key that is absent means "not restricted by this plan"
 * (custom or legacy plans keep working); the founder gets the highest plan's entitlements.
 */

export const PLAN_FEATURES = ['ai', 'calendar', 'sales', 'creative', 'market', 'campaigns', 'workflows', 'intelligence', 'autopilot'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];
/** The agents a customer can use (the AIAgent values minus the internal orchestrator). */
export const PLAN_AGENTS = ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'MARKETING_STRATEGIST', 'CONTENT_CREATOR', 'VISUAL_CREATOR', 'VIDEO_CREATOR', 'SCHEDULER', 'CUSTOMER_SUPPORT', 'PERFORMANCE_ANALYST'] as const;
export type PlanAgent = (typeof PLAN_AGENTS)[number];

export interface PlanEntitlements {
  /** null = not restricted by the plan */
  agents: string[] | null;
  features: string[] | null;
  maxAgents: number | null;
  aiGenerationsPerMonth: number | null;
  aiTokensPerMonth: number | null;
  salesInteractionsPerMonth: number | null;
  aiImagesPerMonth: number | null;
  aiVideoSecondsPerMonth: number | null;
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const names = (v: unknown, allowed: readonly string[]): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && allowed.includes(x)) : null);

export function parseEntitlements(limits: unknown): PlanEntitlements {
  const l = (limits && typeof limits === 'object' ? limits : {}) as Record<string, unknown>;
  const agents = names(l.agents, PLAN_AGENTS);
  return {
    agents,
    features: names(l.features, PLAN_FEATURES),
    maxAgents: agents ? agents.length : null,
    aiGenerationsPerMonth: int(l.aiGenerationsPerMonth) ?? int(l.aiCreditsPerMonth),
    aiTokensPerMonth: int(l.aiTokensPerMonth),
    salesInteractionsPerMonth: int(l.salesInteractionsPerMonth),
    aiImagesPerMonth: int(l.aiImagesPerMonth),
    aiVideoSecondsPerMonth: int(l.aiVideoSecondsPerMonth),
  };
}

export const hasFeature = (e: PlanEntitlements, f: PlanFeature) => e.features === null || e.features.includes(f);
export const hasAgent = (e: PlanEntitlements, a: string) => e.agents === null || e.agents.includes(a);

// ─── Production gate ───────────────────────────────────────────────────────

export const PROVIDER_APPROVAL_STATUSES = ['NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type ProviderApprovalStatusName = (typeof PROVIDER_APPROVAL_STATUSES)[number];

/**
 * Live payments are blocked in this build. Lifting this constant is a reviewed code change that needs the founder's explicit authorization
 * AFTER the provider has accepted TOUMA's real activities in writing; no configuration, database value or request can lift it.
 */
export const BUILD_BLOCKS_LIVE_PAYMENTS = true;

export type ProductionBlockReason = 'BUILD_BLOCKS_LIVE_PAYMENTS' | 'ENVIRONMENT_NOT_LIVE' | 'PROVIDER_NOT_APPROVED' | 'ADAPTER_NOT_LIVE_CAPABLE' | 'ADAPTER_NOT_VERIFIED';

export interface ProductionGateInput {
  environment: 'sandbox' | 'live';
  approvalStatus: ProviderApprovalStatusName;
  /** The recorded reference of the provider's written decision. */
  approvalReference: string | null;
  adapterLive: boolean;
  adapterVerified: boolean;
}

/** Every reason that blocks real payments for a provider. `allowed` is true only when the list is empty. Never automatic. */
export function evaluateProductionGate(i: ProductionGateInput): { allowed: boolean; reasons: ProductionBlockReason[] } {
  const reasons: ProductionBlockReason[] = [];
  if (BUILD_BLOCKS_LIVE_PAYMENTS) reasons.push('BUILD_BLOCKS_LIVE_PAYMENTS');
  if (i.environment !== 'live') reasons.push('ENVIRONMENT_NOT_LIVE');
  if (i.approvalStatus !== 'APPROVED' || !i.approvalReference) reasons.push('PROVIDER_NOT_APPROVED');
  if (!i.adapterLive) reasons.push('ADAPTER_NOT_LIVE_CAPABLE');
  if (!i.adapterVerified) reasons.push('ADAPTER_NOT_VERIFIED');
  return { allowed: reasons.length === 0, reasons };
}
