import { BUILD_BLOCKS_LIVE_PAYMENTS, PLAN_AGENTS, evaluateProductionGate, hasAgent, hasFeature, parseEntitlements } from './entitlements';

describe('plan entitlements', () => {
  it('reads agents, features and quotas; an absent key means not restricted', () => {
    const e = parseEntitlements({ agents: ['CONTENT_CREATOR', 'NOT_AN_AGENT'], features: ['ai', 'sales', 'bogus'], aiCreditsPerMonth: 200, salesInteractionsPerMonth: 100 });
    expect(e).toMatchObject({ agents: ['CONTENT_CREATOR'], maxAgents: 1, features: ['ai', 'sales'], aiGenerationsPerMonth: 200, salesInteractionsPerMonth: 100, aiTokensPerMonth: null });
    expect(hasAgent(e, 'CONTENT_CREATOR')).toBe(true);
    expect(hasAgent(e, 'VIDEO_CREATOR')).toBe(false);
    expect(hasFeature(e, 'sales')).toBe(true);
    expect(hasFeature(e, 'autopilot')).toBe(false);
    const open = parseEntitlements({});
    expect(open).toMatchObject({ agents: null, features: null, maxAgents: null, maxAgentInstances: null, agentCallsPerMonth: null });
    expect(parseEntitlements({ maxAgentInstances: 5, agentCallsPerMonth: 1000, agentBudgetMicrosPerMonth: 25_000_000 })).toMatchObject({ maxAgentInstances: 5, agentCallsPerMonth: 1000, agentBudgetMicrosPerMonth: 25_000_000 });
    expect(hasAgent(open, 'VIDEO_CREATOR')).toBe(true);
    expect(hasFeature(open, 'autopilot')).toBe(true);
    expect(parseEntitlements(null).agents).toBeNull();
    expect(parseEntitlements({ aiGenerationsPerMonth: -1, salesInteractionsPerMonth: 1.5 })).toMatchObject({ aiGenerationsPerMonth: null, salesInteractionsPerMonth: null });
    expect(PLAN_AGENTS).not.toContain('ORCHESTRATOR');
  });
});

describe('production gate', () => {
  const ready = { environment: 'live' as const, approvalStatus: 'APPROVED' as const, approvalReference: 'ticket-123', adapterLive: true, adapterVerified: true };
  it('blocks real payments by default, listing every reason', () => {
    expect(evaluateProductionGate({ environment: 'sandbox', approvalStatus: 'NOT_SUBMITTED', approvalReference: null, adapterLive: false, adapterVerified: false })).toEqual({
      allowed: false, reasons: ['BUILD_BLOCKS_LIVE_PAYMENTS', 'ENVIRONMENT_NOT_LIVE', 'PROVIDER_NOT_APPROVED', 'ADAPTER_NOT_LIVE_CAPABLE', 'ADAPTER_NOT_VERIFIED'],
    });
  });
  it('an approval without a written reference, a pending or rejected provider never counts', () => {
    for (const approvalStatus of ['PENDING_REVIEW', 'REJECTED', 'NOT_SUBMITTED'] as const) expect(evaluateProductionGate({ ...ready, approvalStatus }).reasons).toContain('PROVIDER_NOT_APPROVED');
    expect(evaluateProductionGate({ ...ready, approvalReference: null }).reasons).toContain('PROVIDER_NOT_APPROVED');
  });
  it('even with every other condition met, this build blocks live payments', () => {
    expect(BUILD_BLOCKS_LIVE_PAYMENTS).toBe(true);
    expect(evaluateProductionGate(ready)).toEqual({ allowed: false, reasons: ['BUILD_BLOCKS_LIVE_PAYMENTS'] });
  });
});
