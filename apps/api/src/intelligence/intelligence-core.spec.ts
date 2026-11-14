import { detectRegression, evalApprovalCompliance, evalDuplicates, evalExecutionCost, evalQuality, evalResponseSafety, evalToolAuthorization, summarize } from './evaluators';
import { AGENT_CONTRACTS, type AgentContract } from '@touma/shared';
import { interpretExperiment, requiredSamplePerArm } from './experiment-stats';

describe('evaluators (deterministic)', () => {
  const good = { title: 't', caption: 'Discover Sahel Sandal. Hand-made leather strap. Message us to order.', hashtags: ['#Sandal', '#Footwear'], productId: 'p' };
  it('quality passes a clean post and fails measurable defects', () => {
    expect(evalQuality('q1', good).pass).toBe(true);
    expect(evalQuality('q2', { ...good, caption: 'BUY NOW BEST SHOES EVER!!! HURRY UP TODAY' }).pass).toBe(false);
    expect(evalQuality('q3', { ...good, hashtags: ['#a', '#A'] }).detail).toMatch(/duplicate/);
    expect(evalQuality('q4', { ...good, caption: 'x'.repeat(901) + '.' }).pass).toBe(false);
    expect(evalQuality('q5', { ...good, caption: 'x'.repeat(901) + '.' }, { maxCaption: 1000 }).pass).toBe(true);
  });
  it('approval compliance fails when a publication has no individual authorization', () => {
    expect(evalApprovalCompliance('a', [{ publicationId: 'p1', authorizedHash: 'h', approvedVersion: 1 }]).pass).toBe(true);
    expect(evalApprovalCompliance('a', [{ publicationId: 'p1', authorizedHash: null, approvedVersion: 1 }]).pass).toBe(false);
    expect(evalApprovalCompliance('a', []).pass).toBe(true);
  });
  it('response safety: sensitive never automatic, safe only in AUTO', () => {
    expect(evalResponseSafety('r', { text: 'I want a refund', mode: 'AUTO', knowledgeMatches: 1, expect: 'ESCALATE' }).pass).toBe(true);
    expect(evalResponseSafety('r', { text: 'What colours?', mode: 'MANUAL', knowledgeMatches: 1, expect: 'DRAFT_REPLY' }).pass).toBe(true);
    expect(evalResponseSafety('r', { text: 'What colours?', mode: 'AUTO', knowledgeMatches: 1, expect: 'ESCALATE' }).pass).toBe(false);
  });
  it('cost, tool authorization and duplicates', () => {
    expect(evalExecutionCost('c', { costUsedMicros: 0, costLimitMicros: 0, executionsUsed: 3, executionLimit: 20 }).pass).toBe(true);
    expect(evalExecutionCost('c', { costUsedMicros: 5, costLimitMicros: 0, executionsUsed: 3, executionLimit: 20 }).pass).toBe(false);
    expect(evalToolAuthorization('t').pass).toBe(true);
    expect(evalToolAuthorization('t', { x: { ...AGENT_CONTRACTS.CREATIVE_STRATEGY, allowedTools: ['ads.spend'] } as AgentContract }).pass).toBe(false);
    expect(evalDuplicates('d', ['Fresh bissap juice served cold today', 'Fresh bissap juice served cold today!']).pass).toBe(false);
    expect(evalDuplicates('d', ['Fresh bissap juice served cold', 'Leather sandals made by hand']).pass).toBe(true);
  });
  it('detects a regression: a case that passed and now fails, or a score drop', () => {
    const prev = summarize('s', 1, [{ id: 'a', criterion: 'x', pass: true, detail: '' }, { id: 'b', criterion: 'x', pass: true, detail: '' }]);
    const same = summarize('s', 1, prev.results);
    const worse = summarize('s', 1, [{ id: 'a', criterion: 'x', pass: true, detail: '' }, { id: 'b', criterion: 'x', pass: false, detail: '' }]);
    expect(detectRegression(prev, same).regressed).toBe(false);
    expect(detectRegression(prev, worse)).toMatchObject({ regressed: true, newlyFailing: ['b'], scoreDrop: 50 });
    expect(detectRegression(null, worse).regressed).toBe(false);
  });
});

describe('experiment statistics', () => {
  it('computes a known sample size (5% vs 6.5%: about 3,800 per arm)', () => {
    const n = requiredSamplePerArm(0.05, 0.065)!;
    expect(n).toBeGreaterThan(3500);
    expect(n).toBeLessThan(4200);
    expect(requiredSamplePerArm(0.05, 0.05)).toBeNull();
  });
  it('never declares a winner without data, with a small sample, or on simulated data', () => {
    const real = (label: string, e: number, r: number) => ({ label, engagements: e, reach: r, origin: 'REAL' as const });
    expect(interpretExperiment({ label: 'A', engagements: null, reach: null, origin: 'UNAVAILABLE' }, real('B', 5, 100), 100).verdict).toBe('INSUFFICIENT_DATA');
    expect(interpretExperiment(real('A', 9, 100), real('B', 3, 100), 500).verdict).toBe('INCONCLUSIVE_SMALL_SAMPLE');
    const sim = interpretExperiment({ ...real('A', 900, 1000), origin: 'SIMULATED' }, real('B', 100, 1000), 100);
    expect(sim.verdict).toBe('SIMULATED_NOT_EVIDENCE');
    expect(sim.leader).toBeNull();
  });
  it('detects a clear real difference and reports an interval; says nothing when it is within noise', () => {
    const r = interpretExperiment({ label: 'A', engagements: 300, reach: 3000, origin: 'REAL' }, { label: 'B', engagements: 150, reach: 3000, origin: 'REAL' }, 1000);
    expect(r).toMatchObject({ verdict: 'DIFFERENCE_DETECTED', leader: 'A' });
    expect(r.ci95![0]).toBeGreaterThan(0);
    expect(r.caveats.join(' ')).toMatch(/not evidence about sales/);
    const n = interpretExperiment({ label: 'A', engagements: 52, reach: 1000, origin: 'REAL' }, { label: 'B', engagements: 48, reach: 1000, origin: 'REAL' }, 500);
    expect(n.verdict).toBe('NO_DETECTABLE_DIFFERENCE');
    expect(n.leader).toBeNull();
  });
});
