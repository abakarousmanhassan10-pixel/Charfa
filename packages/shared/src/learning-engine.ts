import { withinHours, type HoursWindow } from './publishing-policy';
import { utcToZoned } from './timezone';

/**
 * The adaptive recommendation engine (N22): pure and deterministic. It compares groups of the client's own posts on measured engagement and proposes changes.
 * Rules it never breaks:
 *  - Too little data means no recommendation, not a weak one.
 *  - A difference is a correlation in a small, uncontrolled sample: no wording says or implies cause, and nothing promises results or sales.
 *  - Simulated data never yields more than LOW confidence.
 *  - A proposal that conflicts with a declared preference, a rejected inference, the publishing hours or the daily limit is dropped.
 */
export interface PerfPost { id: string; platform: string; publishedAt: Date; kind: string; title: string | null; caption: string | null; hashtags: string[]; rate: number | null; origin: 'REAL' | 'SIMULATED' }
export interface EngineOptions {
  now: Date; timezone: string; hours: HoursWindow[]; maxPostsPerDay: number;
  /** Declared preferred content types (empty = no restriction). */ allowedKinds: string[];
  /** Declared words or topics the client does not want. */ restrictions: string[];
  /** Keys the client rejected: never inferred or proposed again. */ rejectedKeys: string[];
  minTotal?: number; minGroup?: number;
}
export type RecKind = 'TOPIC' | 'TITLE_VARIANT' | 'HOOK' | 'VIDEO_FORMAT' | 'LENGTH' | 'POSTING_SLOT' | 'FREQUENCY';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export interface Rec {
  kind: RecKind; key: string; title: string; justification: string;
  dataUsed: { metric: string; n: number; compared: Array<{ label: string; n: number; mean: number }>; period: { from: string; to: string }; origin: 'REAL' | 'SIMULATED'; difference: number; ci95: [number, number] };
  confidence: Confidence; limitations: string[]; expectedEffects: Array<{ statement: string; metric: string; toVerify: true }>; proposedAction: Record<string, unknown>;
}
export interface Hypothesis { key: string; statement: string; value: unknown; n: number }
export interface Inference { key: string; value: Record<string, unknown>; n: number; confidence: Confidence }
export interface EngineResult { usable: number; baselineRate: number | null; origin: 'REAL' | 'SIMULATED' | 'MIXED' | 'NONE'; period: { from: string; to: string } | null; groups: Array<{ dimension: string; groups: Array<{ label: string; n: number; mean: number }> }>; recommendations: Rec[]; hypotheses: Hypothesis[]; inferences: Inference[]; insufficient: string[]; dropped: Array<{ key: string; reason: string }> }

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const variance = (v: number[]) => { const m = mean(v); return v.length > 1 ? v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1) : 0; };
/** Difference of means (group minus the rest) with a conservative 95% interval: a larger multiplier for small groups. */
export function compare(group: number[], rest: number[]): { diff: number; ci: [number, number]; rel: number } {
  const diff = mean(group) - mean(rest);
  const se = Math.sqrt(variance(group) / group.length + variance(rest) / rest.length);
  const t = Math.min(group.length, rest.length) < 10 ? 2.3 : 2.0;
  return { diff, ci: [diff - t * se, diff + t * se], rel: mean(rest) > 0 ? diff / mean(rest) : 0 };
}
export function pearson(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  const mx = mean(x), my = mean(y);
  const sx = Math.sqrt(x.reduce((a, b) => a + (b - mx) ** 2, 0)), sy = Math.sqrt(y.reduce((a, b) => a + (b - my) ** 2, 0));
  return sx === 0 || sy === 0 ? null : x.reduce((a, b, i) => a + (b - mx) * (y[i]! - my), 0) / (sx * sy);
}

const BUCKETS: Array<[string, number, number, number]> = [['morning', 6, 11, 9], ['midday', 12, 16, 13], ['evening', 17, 21, 18]];
const hourBucket = (h: number) => BUCKETS.find(([, a, b]) => h >= a && h <= b)?.[0] ?? 'other';
const lenBucket = (c: string | null) => { const n = (c ?? '').length; return n < 80 ? 'short' : n <= 200 ? 'medium' : 'long'; };
const isQuestion = (p: PerfPost) => /\?/.test(p.title ?? (p.caption ?? '').slice(0, 80));
const topicOf = (p: PerfPost) => (p.hashtags.find((h) => h !== '#bissap') ?? p.hashtags[0] ?? '').toLowerCase();

const SIMULATED_NOTE = 'The numbers come from the simulator: they exercise the workflow and say nothing about real audiences.';
const LIMITS = ['This is an association observed in your own posts, not proof that the factor caused the difference: posts differ in many other ways (audience mood, timing, platform ranking, content).', 'The sample is small and uncontrolled; the interval shown is approximate.'];

export function analyze(posts: PerfPost[], o: EngineOptions): EngineResult {
  const minTotal = o.minTotal ?? 12, minGroup = o.minGroup ?? 4;
  const usable = posts.filter((p) => p.rate !== null);
  const empty: EngineResult = { usable: usable.length, baselineRate: null, origin: 'NONE', period: null, groups: [], recommendations: [], hypotheses: [], inferences: [], insufficient: [], dropped: [] };
  if (usable.length < minTotal) return { ...empty, insufficient: [`Only ${usable.length} measured post(s); at least ${minTotal} are needed before any pattern is proposed.`] };
  const sim = usable.filter((p) => p.origin === 'SIMULATED').length;
  const origin = sim === 0 ? 'REAL' : sim === usable.length ? 'SIMULATED' : 'MIXED';
  const times = usable.map((p) => p.publishedAt.getTime());
  const period = { from: new Date(Math.min(...times)).toISOString().slice(0, 10), to: new Date(Math.max(...times)).toISOString().slice(0, 10) };
  const base = mean(usable.map((p) => p.rate!));
  const res: EngineResult = { ...empty, baselineRate: base, origin, period };
  const cap: Confidence = origin === 'REAL' ? 'HIGH' : 'LOW';
  const order: Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];
  const minConf = (a: Confidence, b: Confidence) => order[Math.min(order.indexOf(a), order.indexOf(b))]!;
  const dropped = (key: string, reason: string) => res.dropped.push({ key, reason });

  type Dim = { dimension: string; of: (p: PerfPost) => string };
  const dims: Dim[] = [
    { dimension: 'slot', of: (p) => hourBucket(utcToZoned(p.publishedAt, o.timezone).time ? Number(utcToZoned(p.publishedAt, o.timezone).time.slice(0, 2)) : 0) },
    { dimension: 'kind', of: (p) => p.kind },
    { dimension: 'length', of: (p) => lenBucket(p.caption) },
    { dimension: 'hook', of: (p) => (isQuestion(p) ? 'question' : 'statement') },
    { dimension: 'topic', of: (p) => topicOf(p) || 'none' },
  ];
  const weekendOf = (p: PerfPost) => [0, 6].includes(utcToZoned(p.publishedAt, o.timezone).weekday);

  for (const d of dims) {
    const byLabel = new Map<string, PerfPost[]>();
    for (const p of usable) { const l = d.of(p); byLabel.set(l, [...(byLabel.get(l) ?? []), p]); }
    res.groups.push({ dimension: d.dimension, groups: [...byLabel.entries()].map(([label, ps]) => ({ label, n: ps.length, mean: mean(ps.map((p) => p.rate!)) })).sort((a, b) => b.mean - a.mean) });
    // Candidate: the best group with enough posts and a worthwhile gap against everything else.
    let best: { label: string; ps: PerfPost[]; c: ReturnType<typeof compare>; rest: PerfPost[] } | null = null;
    for (const [label, ps] of byLabel) {
      if (ps.length < minGroup || label === 'other' || label === 'none') continue;
      const rest = usable.filter((p) => d.of(p) !== label);
      if (rest.length < minGroup) continue;
      const c = compare(ps.map((p) => p.rate!), rest.map((p) => p.rate!));
      if (c.diff > 0 && (!best || c.diff > best.c.diff)) best = { label, ps, c, rest };
    }
    if (!best) continue;
    const key = `${d.dimension}:${best.label}`;
    if (o.rejectedKeys.includes(key)) { dropped(key, 'The client rejected this earlier'); continue; }
    const excludes0 = best.c.ci[0] > 0;
    const rel = best.c.rel;
    const nMin = Math.min(best.ps.length, best.rest.length);
    let conf: Confidence = 'LOW';
    if (excludes0 && nMin >= 8) conf = 'MEDIUM';
    if (excludes0 && nMin >= 15 && rel >= 0.2) conf = 'HIGH';
    conf = minConf(conf, cap);
    const dataUsed = { metric: 'engagementRate', n: usable.length, compared: [{ label: best.label, n: best.ps.length, mean: mean(best.ps.map((p) => p.rate!)) }, { label: 'all other posts', n: best.rest.length, mean: mean(best.rest.map((p) => p.rate!)) }], period, origin: origin === 'REAL' ? ('REAL' as const) : ('SIMULATED' as const), difference: best.c.diff, ci95: best.c.ci };
    // A gap whose interval includes zero and that is not large is not worth proposing; a large one becomes a hypothesis to confirm, not a recommendation.
    if (!excludes0) {
      if (rel >= 0.2) res.hypotheses.push({ key: `hypothesis.${d.dimension}.${best.label}`, statement: `Posts with ${d.dimension} "${best.label}" seem to get more engagement (${(rel * 100).toFixed(0)}% higher in this sample), but the gap is within the noise.`, value: { dimension: d.dimension, label: best.label }, n: best.ps.length });
      else dropped(key, 'Gap too small and not distinguishable from noise');
      continue;
    }
    // A difference that is statistically visible but practically tiny is not worth a change.
    if (rel < 0.1) { dropped(key, 'Effect smaller than 10%: not worth a change'); continue; }
    const pct = `${(Math.abs(rel) * 100).toFixed(0)}%`;
    const common = { dataUsed, confidence: conf, limitations: LIMITS.concat(origin === 'REAL' ? [] : [SIMULATED_NOTE]), key };
    const fx = (statement: string) => [{ statement, metric: 'engagementRate', toVerify: true as const }];
    if (d.dimension === 'slot') {
      const b = BUCKETS.find(([n]) => n === best!.label)!;
      // The hour must fall inside the allowed publishing hours (read in the policy timezone): try the bucket's usual hour, then the others.
      const ok = [b[3], b[1], b[2]].find((h) => o.hours.some((w) => w.from <= `${String(h).padStart(2, '0')}:00` && `${String(h).padStart(2, '0')}:00` < w.to));
      if (ok === undefined) { dropped(key, 'No hour of this period is inside the allowed publishing hours'); continue; }
      const weekend = best.ps.length ? weekendOf(best.ps[0]!) : false;
      res.recommendations.push({ ...common, kind: 'POSTING_SLOT', title: `Try the ${best.label} slot around ${String(ok).padStart(2, '0')}:00`, justification: `Posts published in the ${best.label} period had a mean engagement rate ${pct} higher than the others (${best.ps.length} posts vs ${best.rest.length}).`, expectedEffects: fx(`Engagement of posts moved to the ${best.label} slot may be higher than their current level; check after at least 4 posts at the new time.`), proposedAction: { type: 'PREFER_SLOT', bucket: best.label, hour: ok, within: 'allowed publishing hours', weekendObserved: weekend } });
      res.inferences.push({ key: 'inferred.bestSlot', value: { bucket: best.label, hour: ok }, n: best.ps.length, confidence: conf });
    } else if (d.dimension === 'kind') {
      if (o.allowedKinds.length && !o.allowedKinds.includes(best.label)) { dropped(key, 'The client does not allow this content type'); continue; }
      res.recommendations.push({ ...common, kind: 'VIDEO_FORMAT', title: `Try more ${best.label.toLowerCase()} posts`, justification: `${best.label} posts had a mean engagement rate ${pct} higher than the other formats (${best.ps.length} vs ${best.rest.length}).`, expectedEffects: fx(`A few more ${best.label.toLowerCase()} posts may show a similar engagement level; compare after 4 posts.`), proposedAction: { type: 'PREFER_KIND', kind: best.label } });
      res.inferences.push({ key: 'inferred.bestKind', value: { kind: best.label }, n: best.ps.length, confidence: conf });
    } else if (d.dimension === 'length') {
      res.recommendations.push({ ...common, kind: 'LENGTH', title: `Try ${best.label} captions`, justification: `${best.label} captions had a mean engagement rate ${pct} higher than the other lengths (${best.ps.length} vs ${best.rest.length}).`, expectedEffects: fx(`Captions of ${best.label} length may keep a similar engagement; verify on the next posts.`), proposedAction: { type: 'PREFER_CAPTION_LENGTH', length: best.label } });
      res.inferences.push({ key: 'inferred.captionLength', value: { length: best.label }, n: best.ps.length, confidence: conf });
    } else if (d.dimension === 'hook') {
      if (best.label === 'question') {
        res.recommendations.push({ ...common, kind: 'HOOK', title: 'Open with a question', justification: `Posts that open with a question had a mean engagement rate ${pct} higher than statements (${best.ps.length} vs ${best.rest.length}).`, expectedEffects: fx('Question openings may keep a higher engagement; verify with a comparison test (see experiments).'), proposedAction: { type: 'PREFER_HOOK', hook: 'question' } });
        const latest = [...usable].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()).find((p) => !isQuestion(p) && p.title);
        if (latest?.title) res.recommendations.push({ ...common, key: `title:${best.label}`, kind: 'TITLE_VARIANT', title: 'Title variant to test', justification: `Because question openings did better in your posts, here is a question version of a recent title to compare.`, expectedEffects: fx('The question title may get a similar or higher engagement than the statement; test it before adopting it.'), proposedAction: { type: 'TEST_TITLE', original: latest.title, variant: `Have you tried this: ${latest.title.replace(/[.!]+$/, '')}?` } });
      } else { res.recommendations.push({ ...common, kind: 'HOOK', title: 'Keep openings as statements', justification: `Statement openings had a mean engagement rate ${pct} higher than questions (${best.ps.length} vs ${best.rest.length}).`, expectedEffects: fx('Statement openings may keep their level; verify on the next posts.'), proposedAction: { type: 'PREFER_HOOK', hook: 'statement' } }); }
      res.inferences.push({ key: 'inferred.hook', value: { hook: best.label }, n: best.ps.length, confidence: conf });
    } else if (d.dimension === 'topic') {
      if (o.restrictions.some((r) => best!.label.includes(r.toLowerCase()) || r.toLowerCase().includes(best!.label.replace('#', '')))) { dropped(key, 'The client asked to avoid this topic'); continue; }
      res.recommendations.push({ ...common, kind: 'TOPIC', title: `Cover ${best.label} again`, justification: `Posts tagged ${best.label} had a mean engagement rate ${pct} higher than the others (${best.ps.length} vs ${best.rest.length}).`, expectedEffects: fx(`More posts on ${best.label} may keep a similar level; check after 4 posts.`), proposedAction: { type: 'PREFER_TOPIC', topic: best.label } });
      res.inferences.push({ key: 'inferred.topic', value: { topic: best.label }, n: best.ps.length, confidence: conf });
    }
  }

  // Frequency: weekly post count against that week's mean engagement. A reasonable change only, inside the policy limit.
  const WEEK = 7 * 86_400_000;
  const weeks = new Map<number, number[]>();
  for (const p of usable) { const w = Math.floor(p.publishedAt.getTime() / WEEK); weeks.set(w, [...(weeks.get(w) ?? []), p.rate!]); }
  const wk = [...weeks.values()];
  const current = usable.length / Math.max(weeks.size, 1);
  if (wk.length >= 5) {
    const r = pearson(wk.map((x) => x.length), wk.map((x) => mean(x)));
    const key = 'frequency';
    const counts = wk.map((x) => x.length);
    const hi = wk.filter((x) => x.length >= mean(counts)).map(mean), lo = wk.filter((x) => x.length < mean(counts)).map(mean);
    // Practical size: weeks with more posts must differ from the others by at least 15% on mean engagement, and the weekly counts must really vary.
    const gap = hi.length && lo.length && mean(lo) > 0 ? Math.abs(mean(hi) - mean(lo)) / mean(lo) : 0;
    if (r !== null && Math.abs(r) >= 0.5 && gap >= 0.15 && Math.max(...counts) - Math.min(...counts) >= 2 && !o.rejectedKeys.includes(key)) {
      const ceiling = Math.min(7, o.maxPostsPerDay * 7);
      const target = r > 0 ? Math.min(Math.ceil(current) + 1, ceiling) : Math.max(Math.floor(current) - 1, 1);
      if (target !== Math.round(current)) {
        const conf = minConf(wk.length >= 10 ? 'MEDIUM' : 'LOW', cap);
        res.recommendations.push({ kind: 'FREQUENCY', key, title: r > 0 ? `Try ${target} posts per week` : `Avoid raising the posting rate`, justification: `Across ${wk.length} weeks, weeks with more posts had ${r > 0 ? 'higher' : 'lower'} mean engagement (correlation ${r.toFixed(2)}). The current pace is about ${current.toFixed(1)} posts per week.`, dataUsed: { metric: 'engagementRate', n: usable.length, compared: [{ label: 'weekly posts vs weekly mean engagement', n: wk.length, mean: r }], period, origin: origin === 'REAL' ? 'REAL' : 'SIMULATED', difference: r, ci95: [r, r] }, confidence: conf, limitations: LIMITS.concat(origin === 'REAL' ? [] : [SIMULATED_NOTE], ['Weekly counts and engagement both move with seasons, promotions and platform changes; the pace stays within your daily limit and never above 7 posts per week.']), expectedEffects: [{ statement: 'Engagement per post may stay at a similar level at the new pace; check after 3 weeks.', metric: 'engagementRate', toVerify: true }], proposedAction: { type: 'SET_FREQUENCY', postsPerWeek: target, ceiling } });
        res.inferences.push({ key: 'inferred.frequency', value: { postsPerWeek: target }, n: wk.length, confidence: conf });
      }
    }
  }
  const out = { ...res, recommendations: res.recommendations.filter((r) => { const issues = checkRecommendation(r, o); if (issues.length) { dropped(r.key, `Failed compliance: ${issues.join('; ')}`); return false; } return true; }) };
  return out;
}

// ─── Compliance of a recommendation (also used by the quality evaluation) ──

const FORBIDDEN = /(guarantee|garanti|will (increase|boost|double|grow)|is sure to|proves?\b|proven|causes?\b|caused by|because of this|thanks to this|revenue|sales? (will|increase|growth)|ventes? (augment|croiss)|100\s?%)/i;
export function checkRecommendation(r: Rec, o: Pick<EngineOptions, 'hours' | 'restrictions' | 'allowedKinds'>): string[] {
  const issues: string[] = [];
  if (!r.justification.trim()) issues.push('missing justification');
  if (!r.dataUsed || r.dataUsed.n <= 0 || !r.dataUsed.period) issues.push('missing data used');
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(r.confidence)) issues.push('missing confidence');
  if (!r.limitations.length) issues.push('missing limitations');
  if (!r.expectedEffects.length || r.expectedEffects.some((e) => e.toVerify !== true)) issues.push('expected effects must be marked to verify');
  const wording = [r.title, r.justification, ...r.expectedEffects.map((e) => e.statement)].join(' ');
  if (FORBIDDEN.test(wording)) issues.push('promises results or implies causation');
  const a = r.proposedAction as { hour?: number; kind?: string };
  if (typeof a.hour === 'number' && !o.hours.some((w) => w.from <= `${String(a.hour).padStart(2, '0')}:00` && `${String(a.hour).padStart(2, '0')}:00` < w.to)) issues.push('slot outside the allowed publishing hours');
  if (a.kind && o.allowedKinds.length && !o.allowedKinds.includes(a.kind)) issues.push('content type not allowed by the client');
  if (o.restrictions.some((x) => x && wording.toLowerCase().includes(x.toLowerCase()))) issues.push('mentions a restricted topic');
  if (r.confidence === 'HIGH' && r.dataUsed.origin !== 'REAL') issues.push('simulated data cannot support high confidence');
  return issues;
}

// ─── Content variants for a comparison test ────────────────────────────────

export interface VariantBase { title: string; caption: string; hashtags: string[] }
/** Two variants that differ in ONE element (the opening of the title), so a later comparison has a clear hypothesis. Template-based: no AI call, no cost. */
export function makeVariants(base: VariantBase, o: { language: string; restrictions: string[] }): { a: VariantBase; b: VariantBase; changed: string[] } {
  const stem = base.title.replace(/[?!.\s]+$/, '');
  const q = o.language === 'fr' ? `Avez-vous déjà essayé : ${stem} ?` : `Have you tried this: ${stem}?`;
  const s = o.language === 'fr' ? `${stem}.` : `${stem}.`;
  const a = { ...base, title: s }, b = { ...base, title: q };
  const banned = o.restrictions.filter(Boolean).find((x) => `${a.title} ${b.title} ${base.caption}`.toLowerCase().includes(x.toLowerCase()));
  if (banned) throw new Error(`The content mentions a restricted term: ${banned}`);
  return { a, b, changed: ['title.hook'] };
}
