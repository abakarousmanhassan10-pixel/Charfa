/**
 * Phase N21: honest experiment statistics. Social posts are few and noisy, so the default answer is "not enough data".
 * Nothing here estimates an improvement that the data does not show.
 */
const Z_ALPHA = 1.959964; // two-sided 5%
const Z_POWER = 0.841621; // 80% power

export interface Arm { label: string; engagements: number | null; reach: number | null; origin: 'REAL' | 'SIMULATED' | 'UNAVAILABLE' }

/** Audience size needed per arm to detect p1 vs p2 (two-proportion test, 5% significance, 80% power). null when the rates are equal or invalid. */
export function requiredSamplePerArm(p1: number, p2: number): number | null {
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1) || p1 === p2) return null;
  const pb = (p1 + p2) / 2;
  const n = Math.pow(Z_ALPHA * Math.sqrt(2 * pb * (1 - pb)) + Z_POWER * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2) / Math.pow(p1 - p2, 2);
  return Math.ceil(n);
}

export type ExperimentVerdict = 'INSUFFICIENT_DATA' | 'INCONCLUSIVE_SMALL_SAMPLE' | 'NO_DETECTABLE_DIFFERENCE' | 'DIFFERENCE_DETECTED' | 'SIMULATED_NOT_EVIDENCE';
export interface ExperimentResult {
  verdict: ExperimentVerdict;
  evidenceOrigin: 'REAL' | 'SIMULATED' | 'UNAVAILABLE';
  rates: Array<{ label: string; rate: number | null; reach: number | null }>;
  difference: number | null;
  ci95: [number, number] | null;
  leader: string | null;
  requiredPerArm: number | null;
  summary: string;
  caveats: string[];
}

export function interpretExperiment(a: Arm, b: Arm, minSamplePerArm: number): ExperimentResult {
  const caveats = [
    'Each variant is usually one post: audiences, timing and platform ranking differ between posts, so a gap can come from something other than the wording.',
    'Engagements are treated as independent; real engagement is clustered, so the interval is optimistic.',
    'A detected difference describes engagement with these posts only. It is not evidence about sales.',
  ];
  const rates = [a, b].map((x) => ({ label: x.label, reach: x.reach, rate: x.reach && x.reach > 0 && x.engagements !== null ? x.engagements / x.reach : null }));
  const unavailable = [a, b].some((x) => x.origin === 'UNAVAILABLE' || x.reach === null || x.reach <= 0 || x.engagements === null);
  const origin = unavailable ? 'UNAVAILABLE' : a.origin === 'SIMULATED' || b.origin === 'SIMULATED' ? 'SIMULATED' : 'REAL';
  const base = { evidenceOrigin: origin as ExperimentResult['evidenceOrigin'], rates, difference: null, ci95: null, leader: null, requiredPerArm: null, caveats } satisfies Partial<ExperimentResult>;
  if (unavailable) return { ...base, verdict: 'INSUFFICIENT_DATA', summary: 'At least one variant has no measured reach or engagement. Nothing can be concluded, and a missing value is not a zero.' };
  const [r1, r2] = [rates[0]!.rate!, rates[1]!.rate!];
  const [n1, n2] = [a.reach!, b.reach!];
  const diff = r1 - r2;
  const se = Math.sqrt((r1 * (1 - r1)) / n1 + (r2 * (1 - r2)) / n2);
  const ci: [number, number] = [diff - Z_ALPHA * se, diff + Z_ALPHA * se];
  const required = requiredSamplePerArm(Math.min(Math.max(r1, 0.0001), 0.9999), Math.min(Math.max(r2, 0.0001), 0.9999));
  const full = { ...base, difference: diff, ci95: ci, requiredPerArm: required };
  if (origin === 'SIMULATED') return { ...full, verdict: 'SIMULATED_NOT_EVIDENCE', summary: 'The data comes from the test simulator. It exercises the workflow but says nothing about real audiences.' };
  if (Math.min(n1, n2) < minSamplePerArm) return { ...full, verdict: 'INCONCLUSIVE_SMALL_SAMPLE', summary: `Reach is below the planned minimum of ${minSamplePerArm} per variant${required ? `; about ${required} per variant would be needed to detect this gap` : ''}. No winner is declared.` };
  const significant = ci[0] > 0 || ci[1] < 0;
  if (!significant) return { ...full, verdict: 'NO_DETECTABLE_DIFFERENCE', summary: 'The 95% interval includes zero: the data does not show that one variant is better.' };
  return { ...full, leader: diff > 0 ? a.label : b.label, verdict: 'DIFFERENCE_DETECTED', summary: `Variant ${diff > 0 ? a.label : b.label} had a higher engagement rate (difference ${(Math.abs(diff) * 100).toFixed(2)} points, 95% interval ${(ci[0] * 100).toFixed(2)} to ${(ci[1] * 100).toFixed(2)}). Treat it as a lead to test again, not a proven effect.` };
}
