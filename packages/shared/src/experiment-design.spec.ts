import { concludePrudently, detectBias, type VariantCondition } from './experiment-design';
import { regressions, runLearningSuite } from './learning-eval';

const v = (label: string, d: string, over: Partial<VariantCondition> = {}): VariantCondition => ({ label, platform: 'INSTAGRAM', accountId: 'a1', scheduledAt: new Date(d), kind: 'IMAGE', title: 'T', caption: 'c', hashtags: ['#a'], mediaIds: ['m1'], audience: 500, origin: 'REAL', ...over });
const opt = { timezone: 'UTC', minAudience: 100 };

describe('experiment design', () => {
  it('posts on different days are flagged and never presented as a randomized test', () => {
    const f = detectBias(v('A', '2026-12-01T18:00:00Z', { title: 'Statement' }), v('B', '2026-12-05T18:00:00Z', { title: 'Question?' }), opt).map((x) => x.code);
    expect(f).toEqual(expect.arrayContaining(['NOT_RANDOMIZED', 'DIFFERENT_DAYS', 'ORDER_EFFECT']));
    const c = concludePrudently({ verdict: 'DIFFERENCE_DETECTED', leader: 'B', summary: '' }, detectBias(v('A', '2026-12-01T18:00:00Z'), v('B', '2026-12-05T11:00:00Z', { kind: 'VIDEO', caption: 'other' }), opt));
    expect(c).toMatchObject({ verdict: 'POSSIBLE_DIFFERENCE_CONFOUNDED', design: 'NON_RANDOMIZED_SEQUENTIAL', evidenceGrade: 'ANECDOTAL', observedLeader: 'B' });
    expect(c.text).toMatch(/not a randomized test/);
    expect(c.text).not.toMatch(/proves?|guarantee|will increase/i);
  });
  it('multiple changes, small audiences and simulated data are flagged; missing data concludes nothing', () => {
    const f = detectBias(v('A', '2026-12-01T18:00:00Z', { audience: 20, origin: 'SIMULATED' }), v('B', '2026-12-01T18:00:00Z', { title: 'x', caption: 'y' }), opt).map((x) => x.code);
    expect(f).toEqual(expect.arrayContaining(['MULTIPLE_CHANGES', 'SMALL_AUDIENCE', 'SIMULATED_DATA']));
    expect(concludePrudently({ verdict: 'INSUFFICIENT_DATA', leader: null, summary: 'x' }, []).observedLeader).toBeNull();
    expect(concludePrudently({ verdict: 'SIMULATED_NOT_EVIDENCE', leader: 'A', summary: '' }, []).observedLeader).toBeNull();
  });
});

describe('learning quality suite', () => {
  it('passes on the current engine, and a regression is a case that passed and now fails', () => {
    const s = runLearningSuite();
    expect(s.cases.filter((c) => !c.passed)).toEqual([]);
    expect(s.score).toBe(100);
    expect(regressions(s.cases, s.cases.map((c, i) => (i === 0 ? { ...c, passed: false } : c)))).toEqual([s.cases[0]!.id]);
  });
});
