import { EXECUTIVE_AGENTS, EXECUTIVE_CONTRACTS, EXECUTIVE_FORBIDDEN_TOOLS, assertExecutiveContracts, type ExecutiveContract } from './executive';

describe('executive contracts', () => {
  it('has a bounded read-only contract per agent', () => {
    expect(Object.keys(EXECUTIVE_CONTRACTS).sort()).toEqual([...EXECUTIVE_AGENTS].sort());
    expect(() => assertExecutiveContracts()).not.toThrow();
    for (const c of Object.values(EXECUTIVE_CONTRACTS)) for (const f of EXECUTIVE_FORBIDDEN_TOOLS) expect(c.allowedTools).not.toContain(f);
  });
  it('rejects price, refund, payment and ad-budget powers', () => {
    for (const tool of ['pricing.write', 'refund.issue', 'payments.charge', 'ads.budget.write', 'social.publish', 'messages.send']) {
      expect(() => assertExecutiveContracts({ x: { ...EXECUTIVE_CONTRACTS.OPTIMIZATION, allowedTools: [tool] } as ExecutiveContract })).toThrow(/forbidden/);
    }
    expect(() => assertExecutiveContracts({ x: { ...EXECUTIVE_CONTRACTS.OPTIMIZATION, timeoutMs: 99_999 } as ExecutiveContract })).toThrow(/timeout/);
  });
});
