import { SocialApiError } from '@touma/social-connectors';
import { availableMetrics, type MetricName } from '@touma/shared';

export interface CollectedMetrics extends Record<MetricName, number | null> {
  unavailableReason: string | null;
}
export interface PostRef { id: string; platform: string; publishedAt: Date; kind: string; title: string | null; caption: string | null; hashtags: string[]; externalPostId: string | null }
export const NO_METRICS: CollectedMetrics = { views: null, reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, avgWatchSeconds: null, linkClicks: null, conversions: null, unavailableReason: null };

/** Reads the metrics of one post at a point in time. A value the source does not provide is null; 0 is a value the source reported. */
export interface AnalyticsProvider {
  readonly name: string;
  readonly simulated: boolean;
  collect(post: PostRef, at: Date): Promise<CollectedMetrics>;
}

/** Small deterministic generator: the same post always gets the same simulated numbers. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100_000) / 100_000; };
}

/**
 * SIMULATED analytics (test-only; the environment refuses it outside APP_ENV=test). It models a few plausible effects (time of day, weekday, format, caption
 * length, a question hook) plus noise so the analysis has something to find, but it says nothing about any real audience. It fills only the metrics the platform's
 * adapter can really provide and returns nothing during the simulated platform delay, exactly like the real path.
 */
export class MockAnalyticsProvider implements AnalyticsProvider {
  readonly name = 'mock-analytics';
  readonly simulated = true;
  /** Simulated platform delay: before this age every metric is unavailable. */
  delayHours = 24;
  /** Test switch: the simulated API is unreachable. */
  down = false;
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async collect(post: PostRef, at: Date = this.clock()): Promise<CollectedMetrics> {
    if (this.down) throw new SocialApiError('transient', 'Simulated analytics API unreachable', { status: 503, outcome: 'not_created' });
    const ageH = (at.getTime() - post.publishedAt.getTime()) / 3_600_000;
    if (ageH < this.delayHours) return { ...NO_METRICS, unavailableReason: 'METRICS_DELAYED: the simulated platform has not published metrics for this post yet' };
    const r = rng(post.id);
    const hour = post.publishedAt.getUTCHours();
    const dow = post.publishedAt.getUTCDay();
    const cap = post.caption ?? '';
    const effect = (hour >= 17 && hour <= 20 ? 1.9 : hour >= 6 && hour <= 9 ? 0.8 : 1) * ([2, 4].includes(dow) ? 1.1 : dow === 0 ? 0.9 : 1) * (post.kind === 'VIDEO' ? 2.2 : 1) * (cap.length >= 60 && cap.length <= 140 ? 1.7 : cap.length > 300 ? 0.6 : 1) * (/\?/.test(post.title ?? cap.slice(0, 80)) ? 1.5 : 1);
    const reach0 = Math.round((800 + r() * 400) * (post.platform === 'TIKTOK' ? 2 : post.platform === 'YOUTUBE' ? 1.2 : 1));
    // Counts keep growing after publication and flatten out (simulated).
    const growth = 1 - Math.exp(-Math.max(ageH, 0) / 96);
    const reach = Math.round(reach0 * growth);
    const rate = 0.03 * effect * (0.9 + r() * 0.2);
    const likes = Math.round(reach * rate), comments = Math.round(likes * 0.08), shares = Math.round(likes * 0.1), saves = Math.round(likes * 0.15);
    const full: Record<MetricName, number | null> = { views: Math.round(reach * 1.3), reach, impressions: Math.round(reach * 1.25), likes, comments, shares, saves, avgWatchSeconds: null, linkClicks: null, conversions: null };
    const have = new Set<MetricName>(availableMetrics(post.platform));
    const out = { ...NO_METRICS } as CollectedMetrics;
    for (const m of Object.keys(full) as MetricName[]) out[m] = have.has(m) ? full[m] : null;
    return out;
  }
}
