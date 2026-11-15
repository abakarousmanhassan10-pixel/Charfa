import { utcToZoned } from './timezone';

/**
 * Comparison tests (N22). TOUMA publishes to ONE audience: the two variants reach the same followers, one after the other. That is not a randomized A/B test and
 * is never presented as one. The flags below list what can make a difference come from something other than the wording; the conclusion is always an observation.
 */
export interface VariantCondition { label: string; platform: string; accountId: string | null; scheduledAt: Date; kind: string; title: string | null; caption: string | null; hashtags: string[]; mediaIds: string[]; audience: number | null; origin: 'REAL' | 'SIMULATED' | 'UNAVAILABLE' }
export interface BiasFlag { code: string; message: string }

export function detectBias(a: VariantCondition, b: VariantCondition, o: { timezone: string; minAudience: number }): BiasFlag[] {
  const f: BiasFlag[] = [{ code: 'NOT_RANDOMIZED', message: 'Both variants went to the same audience one after the other; nobody was randomly assigned to a variant.' }];
  const la = utcToZoned(a.scheduledAt, o.timezone), lb = utcToZoned(b.scheduledAt, o.timezone);
  if (la.date !== lb.date) f.push({ code: 'DIFFERENT_DAYS', message: 'The variants were published on different days: day-to-day differences (weather, news, weekday) can explain a gap.' });
  if (Math.abs(Number(la.time.slice(0, 2)) - Number(lb.time.slice(0, 2))) >= 3) f.push({ code: 'DIFFERENT_HOURS', message: 'The variants were published at clearly different times of day.' });
  if ([0, 6].includes(la.weekday) !== [0, 6].includes(lb.weekday)) f.push({ code: 'WEEKEND_VS_WEEKDAY', message: 'One variant was published on a weekend and the other on a weekday.' });
  if (a.scheduledAt.getTime() !== b.scheduledAt.getTime()) f.push({ code: 'ORDER_EFFECT', message: 'The second post may benefit or suffer from the first one (repeat exposure, fatigue).' });
  if (a.platform !== b.platform || a.accountId !== b.accountId) f.push({ code: 'DIFFERENT_ACCOUNTS', message: 'The variants were published on different accounts or platforms: their audiences differ.' });
  if (a.kind !== b.kind) f.push({ code: 'DIFFERENT_FORMATS', message: 'The variants have different formats.' });
  const changed = (['title', 'caption'] as const).filter((k) => (a[k] ?? '') !== (b[k] ?? '')).length + (a.hashtags.join() !== b.hashtags.join() ? 1 : 0) + (a.mediaIds.join() !== b.mediaIds.join() ? 1 : 0);
  if (changed > 1) f.push({ code: 'MULTIPLE_CHANGES', message: `${changed} elements differ between the variants, so the result cannot be attributed to one of them.` });
  if (a.audience !== null && b.audience !== null && Math.min(a.audience, b.audience) < o.minAudience) f.push({ code: 'SMALL_AUDIENCE', message: `Reach is below the planned minimum of ${o.minAudience} per variant.` });
  if (a.origin === 'SIMULATED' || b.origin === 'SIMULATED') f.push({ code: 'SIMULATED_DATA', message: 'The numbers come from the simulator and say nothing about real audiences.' });
  return f;
}

export type PrudentVerdict = 'NO_CONCLUSION' | 'NO_DETECTABLE_DIFFERENCE' | 'POSSIBLE_DIFFERENCE_CONFOUNDED' | 'SIMULATED_NOT_EVIDENCE';
export interface PrudentConclusion { verdict: PrudentVerdict; design: 'NON_RANDOMIZED_SEQUENTIAL'; evidenceGrade: 'ANECDOTAL'; observedLeader: string | null; text: string; nextStep: string }

/** Turns the statistics and the bias flags into a cautious statement. A leader is only ever "observed", and never when the data is simulated or missing. */
export function concludePrudently(stats: { verdict: string; leader: string | null; summary: string }, flags: BiasFlag[]): PrudentConclusion {
  const base = { design: 'NON_RANDOMIZED_SEQUENTIAL' as const, evidenceGrade: 'ANECDOTAL' as const };
  const confounders = flags.filter((x) => !['NOT_RANDOMIZED', 'ORDER_EFFECT', 'SIMULATED_DATA', 'SMALL_AUDIENCE'].includes(x.code));
  if (stats.verdict === 'INSUFFICIENT_DATA' || stats.verdict === 'INCONCLUSIVE_SMALL_SAMPLE') return { ...base, verdict: 'NO_CONCLUSION', observedLeader: null, text: `${stats.summary} No conclusion can be drawn.`, nextStep: 'Wait for more measurements, or repeat the comparison several times.' };
  if (stats.verdict === 'SIMULATED_NOT_EVIDENCE') return { ...base, verdict: 'SIMULATED_NOT_EVIDENCE', observedLeader: null, text: 'The numbers come from the simulator: they exercise the workflow and prove nothing about real audiences.', nextStep: 'Repeat with real measurements.' };
  if (stats.verdict === 'NO_DETECTABLE_DIFFERENCE') return { ...base, verdict: 'NO_DETECTABLE_DIFFERENCE', observedLeader: null, text: 'The data does not show that one variant did better. That is not proof that they are equal.', nextStep: 'Keep either wording; repeat only if the question still matters.' };
  return { ...base, verdict: 'POSSIBLE_DIFFERENCE_CONFOUNDED', observedLeader: stats.leader, text: `Variant ${stats.leader} had higher engagement in this comparison. Because this was not a randomized test${confounders.length ? ` and ${confounders.length} other difference(s) existed (${confounders.map((c) => c.code).join(', ')})` : ''}, treat it as a lead, not a result: it does not show that the wording caused the gap and says nothing about sales.`, nextStep: 'Repeat the comparison at a similar day and time, swapping which variant goes first.' };
}
