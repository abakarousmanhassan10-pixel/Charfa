import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import type { SocialPlatformId } from '@touma/shared';
import { SocialApiError, type Metrics } from '@touma/social-connectors';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { SocialAccountsService, SocialAuthError } from './social-accounts.service';
import { SOCIAL_ADAPTERS, type SocialAdapters } from './social-providers';

const METRICS = ['views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'linkClicks'] as const;
type MetricName = (typeof METRICS)[number];

/**
 * Social analytics foundation. Metrics are collected from the platform when the account's permissions allow it.
 * A metric the platform did not provide is stored as NULL (unavailable); a number, including 0, is a value the platform reported.
 * Nothing is estimated, interpolated or invented here.
 */
@Injectable()
export class SocialAnalyticsService {
  private readonly logger = new Logger('SocialAnalytics');

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
    @Inject(SOCIAL_ADAPTERS) private readonly adapters: SocialAdapters,
  ) {}

  /** Engagement = interactions / reach (or impressions). Only computed when the platform provided both parts; otherwise unavailable. */
  static engagement(m: Metrics): number | null {
    const denominator = m.reach ?? m.impressions;
    const parts = [m.likes, m.comments, m.shares, m.saves].filter((v): v is number => v !== null);
    if (denominator === null || denominator <= 0 || parts.length === 0) return null;
    return Math.round((parts.reduce((a, b) => a + b, 0) / denominator) * 10_000) / 10_000;
  }

  /** Reads the metrics of one published post and stores a lifetime snapshot. Returns null when the post cannot be measured. */
  async collect(publicationId: string) {
    const pub = await this.prisma.publication.findUnique({ where: { id: publicationId } });
    if (!pub || pub.status !== 'PUBLISHED' || !pub.confirmedByProvider || !pub.externalPostId || !pub.publishedAt) return null;
    let metrics: Metrics;
    try {
      const { auth } = await this.accounts.authorized(pub.businessId, pub.socialAccountId);
      metrics = await this.adapters[pub.platform as SocialPlatformId].fetchMetrics(auth, pub.externalPostId);
    } catch (err) {
      if (err instanceof SocialAuthError || err instanceof SocialApiError) {
        // Not measurable now (token, permission): stored as unavailable with the reason, never as zeros.
        metrics = { views: null, reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, linkClicks: null, unavailableReason: err.message.slice(0, 300) };
      } else throw err;
    }
    const engagementRate = SocialAnalyticsService.engagement(metrics);
    const data = {
      views: metrics.views, reach: metrics.reach, impressions: metrics.impressions, likes: metrics.likes, comments: metrics.comments, shares: metrics.shares, saves: metrics.saves, linkClicks: metrics.linkClicks,
      engagementRate: engagementRate === null ? null : new Prisma.Decimal(engagementRate), fetchedAt: new Date(), periodEnd: new Date(), source: 'MEASURED' as const,
      raw: { unavailableReason: metrics.unavailableReason ?? null, derived: engagementRate === null ? [] : ['engagementRate'], platform: (metrics.raw ?? null) as Prisma.InputJsonValue } as Prisma.InputJsonValue,
    };
    const key = { socialAccountId: pub.socialAccountId, publicationId: pub.id, period: 'LIFETIME' as const, periodStart: pub.publishedAt, source: 'MEASURED' as const };
    return this.prisma.analyticsSnapshot.upsert({
      where: { socialAccountId_publicationId_period_periodStart_source: key },
      create: { businessId: pub.businessId, platform: pub.platform, ...key, ...data },
      update: data,
    });
  }

  /** Publications whose metrics are due: hourly on the first day, every 6 hours the first week, then daily up to 90 days. */
  async due(now = new Date(), limit = 20) {
    const pubs = await this.prisma.publication.findMany({
      where: { status: 'PUBLISHED', confirmedByProvider: true, externalPostId: { not: null }, publishedAt: { gt: new Date(now.getTime() - 90 * 86_400_000) } }, orderBy: { publishedAt: 'desc' }, take: 300, select: { id: true, publishedAt: true },
    });
    if (!pubs.length) return [];
    const last = await this.prisma.analyticsSnapshot.groupBy({ by: ['publicationId'], where: { publicationId: { in: pubs.map((p) => p.id) }, period: 'LIFETIME' }, _max: { fetchedAt: true } });
    const lastBy = new Map(last.map((l) => [l.publicationId, l._max.fetchedAt]));
    return pubs
      .filter((p) => {
        const age = now.getTime() - p.publishedAt!.getTime();
        const every = age < 86_400_000 ? 3_600_000 : age < 7 * 86_400_000 ? 6 * 3_600_000 : 86_400_000;
        const seen = lastBy.get(p.id);
        return !seen || now.getTime() - seen.getTime() >= every;
      })
      .slice(0, limit)
      .map((p) => p.id);
  }

  private snapshotDto(s: { views: number | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; linkClicks: number | null; engagementRate: Prisma.Decimal | null; fetchedAt: Date; raw: Prisma.JsonValue }) {
    const raw = (s.raw ?? {}) as { unavailableReason?: string | null };
    return {
      fetchedAt: s.fetchedAt.toISOString(),
      // null means "the platform did not provide this"; 0 means "the platform reported zero".
      metrics: Object.fromEntries(METRICS.map((m) => [m, s[m]])) as Record<MetricName, number | null>,
      engagementRate: s.engagementRate === null ? null : Number(s.engagementRate),
      unavailableReason: raw.unavailableReason ?? null,
    };
  }

  async forPublication(tenant: TenantContext, publicationId: string) {
    const pub = await this.prisma.publication.findFirst({ where: { id: publicationId, businessId: tenant.businessId }, select: { id: true, status: true, platform: true, confirmedByProvider: true, mode: true } });
    if (!pub) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' });
    const snap = await this.prisma.analyticsSnapshot.findFirst({ where: { businessId: tenant.businessId, publicationId, period: 'LIFETIME' }, orderBy: { fetchedAt: 'desc' } });
    return {
      publicationId, platform: pub.platform, measurable: pub.status === 'PUBLISHED' && pub.confirmedByProvider,
      reason: pub.status !== 'PUBLISHED' ? 'NOT_PUBLISHED' : !pub.confirmedByProvider ? 'MANUAL_PUBLICATION' : null,
      snapshot: snap ? this.snapshotDto(snap) : null,
    };
  }

  async refresh(tenant: TenantContext, publicationId: string) {
    await this.forPublication(tenant, publicationId);
    await this.collect(publicationId);
    return this.forPublication(tenant, publicationId);
  }

  /** Totals over measured posts. A metric with no available values has total null (not 0), and counts how many posts could not provide it. */
  async summary(tenant: TenantContext, q: { platform?: string; days: number }) {
    const since = new Date(Date.now() - q.days * 86_400_000);
    const pubs = await this.prisma.publication.findMany({ where: { businessId: tenant.businessId, status: 'PUBLISHED', publishedAt: { gte: since }, ...(q.platform ? { platform: q.platform as never } : {}) }, select: { id: true, platform: true, confirmedByProvider: true } });
    const snaps = await this.prisma.analyticsSnapshot.findMany({ where: { businessId: tenant.businessId, publicationId: { in: pubs.map((p) => p.id) }, period: 'LIFETIME', source: 'MEASURED' } });
    const by = new Map(snaps.map((s) => [s.publicationId, s]));
    const platforms = new Map<string, { published: number; measured: number; manual: number; metrics: Record<MetricName, { total: number | null; available: number; unavailable: number }> }>();
    for (const p of pubs) {
      const row = platforms.get(p.platform) ?? { published: 0, measured: 0, manual: 0, metrics: Object.fromEntries(METRICS.map((m) => [m, { total: null, available: 0, unavailable: 0 }])) as never };
      row.published++;
      if (!p.confirmedByProvider) row.manual++;
      const s = by.get(p.id);
      if (s) {
        row.measured++;
        for (const m of METRICS) {
          const v = s[m];
          if (v === null) row.metrics[m].unavailable++;
          else {
            row.metrics[m].available++;
            row.metrics[m].total = (row.metrics[m].total ?? 0) + v;
          }
        }
      }
      platforms.set(p.platform, row);
    }
    return { days: q.days, platforms: [...platforms.entries()].map(([platform, v]) => ({ platform, ...v })) };
  }
}
