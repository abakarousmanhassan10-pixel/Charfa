import { AGENT_CONTRACTS, CAMPAIGN_AGENTS, FORBIDDEN_AGENT_TOOLS, assertAgentContracts, canMoveCampaign, type AgentContract } from './campaign';

describe('campaign contracts', () => {
  it('has a bounded contract for every agent and none can publish, send, spend or call another agent', () => {
    expect(Object.keys(AGENT_CONTRACTS).sort()).toEqual([...CAMPAIGN_AGENTS].sort());
    expect(() => assertAgentContracts()).not.toThrow();
    for (const c of Object.values(AGENT_CONTRACTS)) for (const t of FORBIDDEN_AGENT_TOOLS) expect(c.allowedTools).not.toContain(t);
  });
  it('rejects a contract with a forbidden tool or an unbounded limit', () => {
    const c = { ...AGENT_CONTRACTS.CREATIVE_STRATEGY, allowedTools: ['social.publish'] } as AgentContract;
    expect(() => assertAgentContracts({ x: c })).toThrow(/forbidden/);
    expect(() => assertAgentContracts({ x: { ...c, allowedTools: [], timeoutMs: 600_000 } })).toThrow(/timeout/);
    expect(() => assertAgentContracts({ x: { ...c, allowedTools: [], maxExecutionsPerCampaign: 9999 } })).toThrow(/unbounded/);
  });
  it('only the customer-service agent touches customers', () => {
    expect(Object.values(AGENT_CONTRACTS).filter((c) => c.touchesCustomers).map((c) => c.id)).toEqual(['CUSTOMER_SERVICE']);
  });
  it('moves forward through the campaign lifecycle and never leaves a terminal state', () => {
    expect(canMoveCampaign('DRAFT', 'PLANNED')).toBe(true);
    expect(canMoveCampaign('DRAFT', 'ACTIVE')).toBe(false);
    expect(canMoveCampaign('AWAITING_APPROVAL', 'ACTIVE')).toBe(true);
    expect(canMoveCampaign('COMPLETED', 'ACTIVE')).toBe(false);
    expect(canMoveCampaign('CANCELLED', 'DRAFT')).toBe(false);
  });
});
