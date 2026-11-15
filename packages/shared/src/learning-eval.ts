import { analyze, checkRecommendation, type EngineOptions, type PerfPost, type Rec } from './learning-engine';

/**
 * Quality evaluation of the recommendation engine (N22). A fixed corpus of synthetic cases with expected behaviour. It proves the engine still behaves as
 * promised (no strong claims from noise, nothing from tiny samples, nothing against the client's wishes, every proposal compliant, deterministic) - it does not
 * prove that a proposal will improve a real account. Run it after any change; a case that used to pass and now fails is a regression.
 */
export interface EvalCase { id: string; description: string; passed: boolean; detail: string }
export interface EvalSuite { suite: string; version: number; passed: boolean; score: number; cases: EvalCase[] }

const HOURS = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }];
const opts = (o: Partial<EngineOptions> = {}): EngineOptions => ({ now: new Date('2026-12-01T00:00:00Z'), timezone: 'UTC', hours: HOURS, maxPostsPerDay: 2, allowedKinds: [], restrictions: [], rejectedKeys: [], ...o });
const noise = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
function corpus(n: number, f: (i: number) => { hour: number; kind: string; boost: number }, origin: 'REAL' | 'SIMULATED'): PerfPost[] {
  return Array.from({ length: n }, (_, i) => { const e = f(i); return { id: `g${i}`, platform: 'INSTAGRAM', publishedAt: new Date(Date.UTC(2026, 8, 1 + i * 2, e.hour)), kind: e.kind, title: `Post ${i}`, caption: 'Fresh bissap juice, served cold at our shop today.', hashtags: ['#bissap', i % 2 ? '#jus' : '#promo'], rate: 0.03 * e.boost * (0.95 + noise(i) * 0.1), origin }; });
}
const evening = (i: number) => { const hour = [9, 13, 18][i % 3]!; return { hour, kind: 'IMAGE', boost: hour === 18 ? 1.5 : 1 }; };
const flat = (i: number) => ({ hour: [9, 13, 18][i % 3]!, kind: 'IMAGE', boost: 1 });
const mixedKinds = (i: number) => { const hour = [9, 13, 18][i % 3]!; return { hour, kind: i % 2 ? 'VIDEO' : 'IMAGE', boost: (hour === 18 ? 1.5 : 1) * (i % 2 ? 1.4 : 1) }; };

export function runLearningSuite(): EvalSuite {
  const cases: EvalCase[] = [];
  const add = (id: string, description: string, passed: boolean, detail = '') => cases.push({ id, description, passed, detail });
  const all: Rec[] = [];

  const noiseRun = analyze(corpus(40, flat, 'REAL'), opts());
  add('noise', 'No confident recommendation from noise', noiseRun.recommendations.every((r) => r.confidence === 'LOW'), `${noiseRun.recommendations.length} proposals`);
  const few = analyze(corpus(8, evening, 'REAL'), opts());
  add('small-sample', 'Nothing is proposed from fewer than 12 posts', few.recommendations.length === 0 && few.insufficient.length > 0);
  const real = analyze(corpus(60, evening, 'REAL'), opts());
  const slot = real.recommendations.find((r) => r.kind === 'POSTING_SLOT');
  add('finds-effect', 'A clear, repeated effect is found with at least medium confidence', !!slot && slot.proposedAction.bucket === 'evening' && slot.confidence !== 'LOW', slot ? `${slot.confidence}` : 'none');
  const sim = analyze(corpus(30, evening, 'SIMULATED'), opts());
  add('simulated-cap', 'Simulated data never exceeds LOW confidence', sim.recommendations.length > 0 && sim.recommendations.every((r) => r.confidence === 'LOW'));
  const kinds = analyze(corpus(30, mixedKinds, 'SIMULATED'), opts({ allowedKinds: ['IMAGE'] }));
  add('client-types', 'A format the client does not allow is never proposed', !kinds.recommendations.some((r) => r.kind === 'VIDEO_FORMAT'));
  const narrow = analyze(corpus(30, evening, 'SIMULATED'), opts({ hours: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '12:00' }] }));
  add('hours', 'A slot outside the allowed hours is never proposed', !narrow.recommendations.some((r) => r.kind === 'POSTING_SLOT'));
  const rejected = analyze(corpus(30, evening, 'SIMULATED'), opts({ rejectedKeys: ['slot:evening'] }));
  add('rejected', 'A rejected proposal is not proposed again', !rejected.recommendations.some((r) => r.kind === 'POSTING_SLOT'));
  all.push(...real.recommendations, ...sim.recommendations, ...noiseRun.recommendations);
  const bad = all.flatMap((r) => checkRecommendation(r, opts()).map((i) => `${r.kind}: ${i}`));
  add('compliance', 'Every proposal has justification, data, confidence, limits, effects to verify and no promise or causal claim', bad.length === 0, bad.join('; '));
  const again = analyze(corpus(30, evening, 'SIMULATED'), opts());
  add('deterministic', 'The same data gives the same proposals', JSON.stringify(again.recommendations) === JSON.stringify(sim.recommendations));
  const passed = cases.filter((c) => c.passed).length;
  return { suite: 'learning-golden', version: 1, passed: passed === cases.length, score: Math.round((passed / cases.length) * 100), cases };
}

/** Cases that passed in the previous run and fail now. */
export const regressions = (prev: EvalCase[] | null, now: EvalCase[]) => (prev ?? []).filter((p) => p.passed && now.some((n) => n.id === p.id && !n.passed)).map((p) => p.id);
