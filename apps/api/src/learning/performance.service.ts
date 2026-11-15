import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { SocialApiError } from '@touma/social-connectors';
import { engagementRate, freshnessOf, isMature, METRIC_NAMES, type MetricName } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { SocialAnalyticsService } from '../social/social-analytics.service';
import { MockAnalyticsProvider, NO_METRICS, type AnalyticsProvider, type CollectedMetrics, type PostRef } from './analytics-provider';

export const ANALYTICS_PROVIDER = Symbol('ANALYTICS_PROVIDER');
const WEEK = 7 * 86_400_000;

export interface CollectSummary { considered: number; collected: number; pendingMaturity: number; unavailable: number; failed: number }
type Origin = 'REAL' | 'SIMULATED';

/**
 * Collects and reads post performance (N22). Reuses the existing AnalyticsSnapshot table and the platform adapters' fetchMetrics (which already keep a missing metric
 * as null). Adds: a provider seam (the official platform path or the simulator), a maturity window, per-snapshot provenance (provider, simulated, measurement period,
 * collection time) and null-aware aggregation: an average is taken only over posts that have the metric, and its sample size is always returned.
 */
@Injectable()
export class PerformanceService {
  private readonly logger = new Logger('Performance');
  constructor(private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv, @Inject(ANALYTICS_PROVIDER) private readonly provider: AnalyticsProvider, @Optional() private readonly social?: SocialAnalyticsService) {}

  private async postRefs(businessId: string, since?: Date) {
    const pubs = await this.prisma.publication.findMany({ where: { businessId, status: 'PUBLISHED', confirmedByProvider: true, publishedAt: { not: null, ...(since ? { gte: since } : {}) } }, orderBy: { publishedAt: 'asc' }, take: 500 });
    const contents = await this.prisma.content.findMany({ where: { id: { in: pubs.map((p) => p.contentId) }, businessId }, select: { id: true, type: true, title: true, caption: true, hashtags: true } });
    return pubs.map((p) => { const c = contents.find((x) => x.id === p.contentId); return { pub: p, post: { id: p.id, platform: p.platform, publishedAt: p.publishedAt!, kind: c?.type ?? 'TEXT', title: c?.title ?? null, caption: c?.caption ?? null, hashtags: c?.hashtags ?? [], externalPostId: p.externalPostId } satisfies PostRef }; });
  }

  private async store(businessId: string, pub: { id: string; socialAccountId: string; platform: string; publishedAt: Date | null }, m: CollectedMetrics, now: Date, period: 'LIFETIME' | 'WEEK', periodStart: Date, periodEnd: Date) {
    const rate = engagementRate(m);
    const data = {
      views: m.views, reach: m.reach, impressions: m.impressions, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves, linkClicks: m.linkClicks,
      avgWatchSeconds: m.avgWatchSeconds === null ? null : new Prisma.Decimal(m.avgWatchSeconds), engagementRate: rate === null ? null : new Prisma.Decimal(rate),
      periodEnd, fetchedAt: now, provider: this.provider.name, simulated: this.provider.simulated, source: 'MEASURED' as const,
      raw: { unavailableReason: m.unavailableReason, derived: rate === null ? [] : ['engagementRate'], simulated: this.provider.simulated } as Prisma.InputJsonValue,
    };
    const key = { socialAccountId: pub.socialAccountId, publicationId: pub.id, period, periodStart, source: 'MEASURED' as const };
    await this.prisma.analyticsSnapshot.upsert({ where: { socialAccountId_publicationId_period_periodStart_source: key }, create: { businessId, platform: pub.platform as never, ...key, ...data }, update: data });
  }

  /**
   * Collects every published, mature post of the business. One failing post never stops the others; an unreachable source is recorded as "unavailable with a
   * reason" for that post (never as zeros) and counted, and the caller decides what to do with the count.
   */
  async collect(businessId: string, now = new Date()): Promise<CollectSummary> {
    const s: CollectSummary = { considered: 0, collected: 0, pendingMaturity: 0, unavailable: 0, failed: 0 };
    for (const { pub, post } of await this.postRefs(businessId)) {
      s.considered++;
      if (!isMature(post.publishedAt, now, this.env.ANALYTICS_MATURITY_HOURS)) { s.pendingMaturity++; continue; }
      try {
        let m: CollectedMetrics;
        if (this.provider.simulated) m = await this.provider.collect(post, now);
        else {
          // Official platform path: the existing collector stores the snapshot (null for what the platform did not give).
          const snap = this.social ? await this.social.collect(pub.id) : null;
          if (!snap) { s.unavailable++; continue; }
          await this.prisma.analyticsSnapshot.update({ where: { id: snap.id }, data: { provider: this.provider.name, simulated: false } });
          s.collected++;
          continue;
        }
        const hasAny = METRIC_NAMES.some((k) => m[k] !== null);
        // Weekly readings: one per elapsed week since publication, so the evolution can be shown. Each is a cumulative reading at that date.
        const weeks = Math.min(Math.floor((now.getTime() - post.publishedAt.getTime()) / WEEK), 8);
        for (let w = 1; w <= weeks; w++) {
          const at = new Date(post.publishedAt.getTime() + w * WEEK);
          const wm = await this.provider.collect(post, at);
          await this.store(businessId, pub, wm, at, 'WEEK', new Date(post.publishedAt.getTime() + (w - 1) * WEEK), at);
        }
        await this.store(businessId, pub, m, now, 'LIFETIME', post.publishedAt, now);
        if (hasAny) s.collected++; else s.unavailable++;
      } catch (e) {
        if (e instanceof SocialApiError) {
          // The source could not be reached: record the reason, not numbers.
          await this.store(businessId, pub, { ...NO_METRICS, unavailableReason: `${e.kind}: ${e.message}`.slice(0, 300) }, now, 'LIFETIME', post.publishedAt, now);
          s.failed++;
        } else { this.logger.warn(`collect ${pub.id}: ${(e as Error).message}`); s.failed++; }
      }
    }
    return s;
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  /** Latest lifetime reading of every published post, with provenance and freshness. */
  async posts(businessId: string, o: { platform?: string; days?: number; now?: Date } = {}) {
    const now = o.now ?? new Date();
    const since = o.days ? new Date(now.getTime() - o.days * 86_400_000) : undefined;
    const refs = (await this.postRefs(businessId, since)).filter((r) => !o.platform || r.pub.platform === o.platform);
    const snaps = await this.prisma.analyticsSnapshot.findMany({ where: { businessId, publicationId: { in: refs.map((r) => r.pub.id) }, period: 'LIFETIME' }, orderBy: { fetchedAt: 'desc' } });
    return refs.map(({ pub, post }) => {
      const sn = snaps.find((x) => x.publicationId === pub.id) ?? null;
      const origin: Origin = pub.simulated || sn?.simulated ? 'SIMULATED' : 'REAL';
      const metrics = Object.fromEntries(METRIC_NAMES.map((m) => [m, sn ? ((sn as unknown as Record<string, unknown>)[m] == null ? null : Number((sn as unknown as Record<string, unknown>)[m])) : null])) as Record<MetricName, number | null>;
      return {
        publicationId: pub.id, platform: pub.platform, contentId: pub.contentId, kind: post.kind, title: post.title, caption: post.caption, hashtags: post.hashtags, publishedAt: post.publishedAt,
        metrics, engagementRate: sn?.engagementRate == null ? null : Number(sn.engagementRate), origin,
        measurement: sn ? { provider: sn.provider, period: sn.period, periodStart: sn.periodStart, periodEnd: sn.periodEnd, collectedAt: sn.fetchedAt, freshness: freshnessOf(sn.fetchedAt, now), unavailableReason: (sn.raw as { unavailableReason?: string | null } | null)?.unavailableReason ?? null } : null,
        matured: isMature(post.publishedAt, now, this.env.ANALYTICS_MATURITY_HOURS),
      };
    });
  }

  /** Per platform: how many posts, which metrics exist (and for how many posts), null-aware averages with their sample sizes, and whether the evidence is real or simulated. */
  async report(businessId: string, o: { platform?: string; days?: number; now?: Date } = {}) {
    const posts = await this.posts(businessId, o);
    const platforms = [...new Set(posts.map((p) => p.platform))];
    return platforms.map((platform) => {
      const rows = posts.filter((p) => p.platform === platform);
      const sim = rows.filter((r) => r.origin === 'SIMULATED').length;
      const metrics = Object.fromEntries(METRIC_NAMES.map((m) => {
        const vals = rows.map((r) => r.metrics[m]).filter((v): v is number => v !== null);
        return [m, { n: vals.length, total: vals.length ? vals.reduce((a, b) => a + b, 0) : null, mean: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null }];
      }));
      const rates = rows.map((r) => r.engagementRate).filter((v): v is number => v !== null);
      return {
        platform, posts: rows.length, measured: rows.filter((r) => r.measurement && !r.measurement.unavailableReason).length, pendingMaturity: rows.filter((r) => !r.matured).length,
        evidence: sim === 0 ? 'REAL' : sim === rows.length ? 'SIMULATED' : 'MIXED', metrics,
        engagementRate: { n: rates.length, mean: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null },
        oldestCollection: rows.map((r) => r.measurement?.collectedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
      };
    });
  }

  /** Evolution over time: weekly readings, grouped by the week of the reading; the mean engagement counts only readings that have a rate. */
  async series(businessId: string, o: { platform?: string; weeks?: number; now?: Date } = {}) {
    const now = o.now ?? new Date();
    const since = new Date(now.getTime() - (o.weeks ?? 12) * WEEK);
    const rows = await this.prisma.analyticsSnapshot.findMany({ where: { businessId, period: 'WEEK', periodEnd: { gte: since }, ...(o.platform ? { platform: o.platform as never } : {}) } });
    const byWeek = new Map<string, { n: number; rates: number[]; views: number[]; simulated: number }>();
    for (const r of rows) {
      const d = new Date(Math.floor(r.periodEnd.getTime() / WEEK) * WEEK).toISOString().slice(0, 10);
      const g = byWeek.get(d) ?? { n: 0, rates: [], views: [], simulated: 0 };
      g.n++; if (r.engagementRate !== null) g.rates.push(Number(r.engagementRate)); if (r.views !== null) g.views.push(r.views); if (r.simulated) g.simulated++;
      byWeek.set(d, g);
    }
    return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, g]) => ({ week, readings: g.n, engagementRate: g.rates.length ? g.rates.reduce((a, b) => a + b, 0) / g.rates.length : null, engagementN: g.rates.length, views: g.views.length ? g.views.reduce((a, b) => a + b, 0) : null, origin: g.simulated === 0 ? 'REAL' : g.simulated === g.n ? 'SIMULATED' : 'MIXED' }));
  }
}

export { MockAnalyticsProvider };
