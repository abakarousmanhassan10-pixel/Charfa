import { analyze, checkRecommendation, compare, makeVariants, pearson, type EngineOptions, type PerfPost } from './learning-engine';
import { effectivePreferences, validateDeclared } from './preferences';

const HOURS = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }];
const opts = (o: Partial<EngineOptions> = {}): EngineOptions => ({ now: new Date('2026-12-01T00:00:00Z'), timezone: 'UTC', hours: HOURS, maxPostsPerDay: 2, allowedKinds: [], restrictions: [], rejectedKeys: [], ...o });
/** Deterministic pseudo-noise so tests do not depend on Math.random. */
const noise = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
function posts(n: number, effect: (i: number) => { hour: number; kind: string; boost: number }, origin: 'REAL' | 'SIMULATED' = 'SIMULATED'): PerfPost[] {
  return Array.from({ length: n }, (_, i) => {
    const e = effect(i);
    return { id: `p${i}`, platform: 'INSTAGRAM', publishedAt: new Date(Date.UTC(2026, 9, 1 + i * 2, e.hour)), kind: e.kind, title: `Post ${i}`, caption: 'Fresh bissap juice, served cold at our shop today.', hashtags: ['#bissap', i % 2 ? '#jus' : '#promo'], rate: 0.03 * e.boost * (0.95 + noise(i) * 0.1), origin };
  });
}

describe('analyze', () => {
  it('too little data: no recommendation, only a reason', () => {
    const r = analyze(posts(8, () => ({ hour: 18, kind: 'IMAGE', boost: 1 })), opts());
    expect(r.recommendations).toEqual([]);
    expect(r.insufficient[0]).toMatch(/at least 12/);
  });
  it('pure noise yields no strong recommendation', () => {
    const r = analyze(posts(40, (i) => ({ hour: [9, 13, 18][i % 3]!, kind: 'IMAGE', boost: 1 }), 'REAL'), opts());
    expect(r.recommendations.filter((x) => x.confidence !== 'LOW')).toEqual([]);
  });
  it('a planted evening effect is proposed with justification, data, limits and effects to verify; simulated data stays LOW', () => {
    const data = posts(30, (i) => { const hour = [9, 13, 18][i % 3]!; return { hour, kind: 'IMAGE', boost: hour === 18 ? 1.5 : 1 }; });
    const r = analyze(data, opts());
    const slot = r.recommendations.find((x) => x.kind === 'POSTING_SLOT')!;
    expect(slot).toBeTruthy();
    expect(slot.confidence).toBe('LOW');
    expect(slot.dataUsed).toMatchObject({ metric: 'engagementRate', origin: 'SIMULATED' });
    expect(slot.dataUsed.compared[0]!.n).toBeGreaterThanOrEqual(4);
    expect(slot.limitations.join(' ')).toMatch(/not proof|simulator/);
    expect(slot.expectedEffects.every((e) => e.toVerify)).toBe(true);
    expect(slot.proposedAction).toMatchObject({ bucket: 'evening' });
    // The same data as REAL can reach a higher level, never a causal claim.
    const real = analyze(posts(60, (i) => { const hour = [9, 13, 18][i % 3]!; return { hour, kind: 'IMAGE', boost: hour === 18 ? 1.5 : 1 }; }, 'REAL'), opts());
    expect(['MEDIUM', 'HIGH']).toContain(real.recommendations.find((x) => x.kind === 'POSTING_SLOT')!.confidence);
    for (const rec of [...r.recommendations, ...real.recommendations]) expect(JSON.stringify(rec)).not.toMatch(/guarantee|will increase|because of/i);
  });
  it('drops what conflicts with the client: rejected keys, disallowed types, restricted topics, hours', () => {
    const data = posts(30, (i) => { const hour = [9, 13, 18][i % 3]!; return { hour, kind: i % 2 ? 'VIDEO' : 'IMAGE', boost: (hour === 18 ? 1.5 : 1) * (i % 2 ? 1.4 : 1) }; });
    const base = analyze(data, opts());
    expect(base.recommendations.map((r) => r.kind)).toEqual(expect.arrayContaining(['POSTING_SLOT', 'VIDEO_FORMAT']));
    expect(analyze(data, opts({ rejectedKeys: ['slot:evening'] })).recommendations.some((r) => r.kind === 'POSTING_SLOT')).toBe(false);
    expect(analyze(data, opts({ allowedKinds: ['IMAGE'] })).recommendations.some((r) => r.kind === 'VIDEO_FORMAT')).toBe(false);
    expect(analyze(data, opts({ hours: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '12:00' }] })).recommendations.some((r) => r.kind === 'POSTING_SLOT')).toBe(false);
  });
  it('frequency stays inside the daily limit and 7 per week', () => {
    // more posts in a week goes with higher engagement
    const data: PerfPost[] = [];
    for (let w = 0; w < 8; w++) for (let k = 0; k < 1 + (w % 4); k++) data.push({ id: `f${w}-${k}`, platform: 'INSTAGRAM', publishedAt: new Date(Date.UTC(2026, 8, 1 + w * 7 + k, 12)), kind: 'IMAGE', title: 't', caption: 'c', hashtags: ['#a'], rate: 0.02 + (w % 4) * 0.01, origin: 'REAL' });
    const f = analyze(data, opts({ maxPostsPerDay: 1 })).recommendations.find((r) => r.kind === 'FREQUENCY');
    if (f) expect((f.proposedAction as { postsPerWeek: number }).postsPerWeek).toBeLessThanOrEqual(7);
  });
});

describe('compliance, statistics and variants', () => {
  const rec = (over: Record<string, unknown> = {}) => ({ kind: 'TOPIC', key: 'k', title: 'Cover #bissap again', justification: 'Posts tagged #bissap had higher engagement.', dataUsed: { metric: 'engagementRate', n: 20, compared: [], period: { from: 'a', to: 'b' }, origin: 'REAL', difference: 0.1, ci95: [0, 0.2] }, confidence: 'LOW', limitations: ['x'], expectedEffects: [{ statement: 'May stay similar.', metric: 'engagementRate', toVerify: true }], proposedAction: {}, ...over }) as never;
  it('rejects promises, causal wording and missing parts', () => {
    const o = { hours: HOURS, restrictions: [], allowedKinds: [] };
    expect(checkRecommendation(rec(), o)).toEqual([]);
    expect(checkRecommendation(rec({ title: 'This will increase your sales' }), o)).toContain('promises results or implies causation');
    expect(checkRecommendation(rec({ limitations: [] }), o)).toContain('missing limitations');
    expect(checkRecommendation(rec({ confidence: 'HIGH', dataUsed: { n: 5, period: {}, origin: 'SIMULATED' } }), o)).toContain('simulated data cannot support high confidence');
  });
  it('statistics helpers', () => {
    expect(compare([0.05, 0.06, 0.05, 0.07], [0.03, 0.03, 0.04, 0.03]).ci[0]).toBeGreaterThan(0);
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
  it('variants differ in one element and respect restrictions', () => {
    const v = makeVariants({ title: 'Fresh bissap today', caption: 'c', hashtags: [] }, { language: 'en', restrictions: [] });
    expect(v.changed).toEqual(['title.hook']);
    expect(v.a.caption).toBe(v.b.caption);
    expect(v.b.title).toMatch(/\?$/);
    expect(() => makeVariants({ title: 'Fresh bissap today', caption: 'c', hashtags: [] }, { language: 'en', restrictions: ['bissap'] })).toThrow(/restricted/);
  });
});

describe('preferences', () => {
  it('validates declared values and refuses personal data', () => {
    expect(validateDeclared('tone', 'friendly').ok).toBe(true);
    expect(validateDeclared('tone', 'rude').ok).toBe(false);
    expect(validateDeclared('audience', 'call me on +235 66 12 34 56').ok).toBe(false);
    expect(validateDeclared('inferred.bestSlot', {}).ok).toBe(false); // a client cannot declare a system-owned key
    expect(validateDeclared('content.preferredTypes', ['VIDEO', 'VIDEO'])).toEqual({ ok: true, value: ['VIDEO'] });
  });
  it('declared beats inferred; rejected and hypothesis rows never count', () => {
    const e = effectivePreferences([
      { key: 'tone', origin: 'INFERRED', value: 'playful', status: 'ACTIVE' }, { key: 'tone', origin: 'DECLARED', value: 'formal', status: 'ACTIVE' },
      { key: 'x', origin: 'INFERRED', value: 1, status: 'REJECTED' }, { key: 'h', origin: 'HYPOTHESIS', value: 1, status: 'ACTIVE' }, { key: 'y', origin: 'INFERRED', value: 2, status: 'ACTIVE' },
    ]);
    expect(e).toEqual({ tone: { origin: 'DECLARED', value: 'formal' }, y: { origin: 'INFERRED', value: 2 } });
  });
});
