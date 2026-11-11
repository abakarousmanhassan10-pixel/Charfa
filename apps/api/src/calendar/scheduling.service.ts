import { Injectable } from '@nestjs/common';
import { Prisma, type SocialPlatform } from '@touma/database';
import { ANALYTICS_MIN_SAMPLES, HARD_CONFLICTS, PLATFORM_RULES, addDays, localDayRange, utcToZoned, zonedToUtc, type AiPlatform, type ConflictCode, type TimeSource } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface Conflict {
  code: ConflictCode;
  severity: 'hard' | 'soft';
  message: string;
  withEntryId?: string;
  withTitle?: string;
}

export interface Recommendation {
  platform: SocialPlatform;
  date: string;
  timezone: string;
  /** ANALYTICS = measured data of this business's published posts; ESTIMATE = general guidance, not audience data. */
  source: Extract<TimeSource, 'ANALYTICS' | 'ESTIMATE'>;
  sampleSize: number;
  note: string;
  slots: Array<{ time: string; scheduledAt: string; reason: string }>;
}

type Tx = Prisma.TransactionClient | PrismaService;

const ACTIVE_STATUSES = ['DRAFT', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'FAILED'] as const;

/** Conflict detection and smart time recommendation. Never publishes anything. */
@Injectable()
export class SchedulingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Serialises scheduling decisions for one business and platform, so concurrent requests see each other's writes. */
  async lock(tx: Prisma.TransactionClient, businessId: string, platform: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`calendar:${businessId}:${platform}`}))`;
  }

  /** Entries that count for conflicts: not deleted, not cancelled. */
  private activeWhere(businessId: string, platform: SocialPlatform): Prisma.CalendarEventWhereInput {
    return { businessId, platform, deletedAt: null, status: { not: 'CANCELLED' }, OR: [{ content: null }, { content: { status: { in: [...ACTIVE_STATUSES] }, deletedAt: null } }] };
  }

  async detect(
    db: Tx,
    p: { businessId: string; platform: SocialPlatform; scheduledAt: Date; timezone: string; contentId?: string | null; excludeEventId?: string; now?: Date },
  ): Promise<Conflict[]> {
    const out: Conflict[] = [];
    const now = p.now ?? new Date();
    const rule = PLATFORM_RULES[p.platform as AiPlatform];

    if (p.scheduledAt.getTime() <= now.getTime()) {
      out.push({ code: 'PAST_TIME', severity: 'hard', message: 'This time is in the past.' });
    }
    if (p.contentId) {
      const dup = await db.calendarEvent.findFirst({ where: { ...this.activeWhere(p.businessId, p.platform), contentId: p.contentId, ...(p.excludeEventId ? { id: { not: p.excludeEventId } } : {}) }, select: { id: true, title: true } });
      if (dup) out.push({ code: 'DUPLICATE_PLACEMENT', severity: 'hard', message: 'This content is already planned on this platform.', withEntryId: dup.id, withTitle: dup.title });
    }
    const gapMs = rule.minGapMinutes * 60_000;
    const near = await db.calendarEvent.findFirst({
      where: { ...this.activeWhere(p.businessId, p.platform), scheduledAt: { gt: new Date(p.scheduledAt.getTime() - gapMs), lt: new Date(p.scheduledAt.getTime() + gapMs) }, ...(p.excludeEventId ? { id: { not: p.excludeEventId } } : {}) },
      select: { id: true, title: true },
      orderBy: { scheduledAt: 'asc' },
    });
    if (near) out.push({ code: 'SLOT_TOO_CLOSE', severity: 'soft', message: `Another post is planned less than ${rule.minGapMinutes / 60} h away on this platform.`, withEntryId: near.id, withTitle: near.title });

    const day = utcToZoned(p.scheduledAt, p.timezone).date;
    const { start, end } = localDayRange(day, p.timezone);
    const sameDay = await db.calendarEvent.count({ where: { ...this.activeWhere(p.businessId, p.platform), scheduledAt: { gte: start, lt: end }, ...(p.excludeEventId ? { id: { not: p.excludeEventId } } : {}) } });
    if (sameDay + 1 > rule.maxPerDay) out.push({ code: 'DAILY_LIMIT', severity: 'soft', message: `More than ${rule.maxPerDay} post(s) on one day on this platform.` });

    const connected = await db.socialAccount.count({ where: { businessId: p.businessId, platform: p.platform, status: 'CONNECTED', deletedAt: null } });
    if (!connected) out.push({ code: 'ACCOUNT_NOT_CONNECTED', severity: 'soft', message: 'No connected account for this platform yet. It must be connected before this can be published.' });
    return out;
  }

  hasHard(conflicts: Conflict[]) {
    return conflicts.some((c) => (HARD_CONFLICTS as readonly string[]).includes(c.code));
  }

  /**
   * Recommended local posting times for a date.
   * With at least ANALYTICS_MIN_SAMPLES measured posts for this platform, the best hours come from this
   * business's own engagement data. Otherwise the answer is general guidance and is labelled ESTIMATE.
   */
  async recommend(p: { businessId: string; platform: SocialPlatform; date: string; timezone: string; notBefore?: Date; limit?: number }): Promise<Recommendation> {
    const limit = p.limit ?? 3;
    const weekday = utcToZoned(zonedToUtc(p.date, '12:00', p.timezone).utc, p.timezone).weekday;
    const weekend = weekday === 0 || weekday === 6;
    const rows = await this.prisma.analyticsSnapshot.findMany({
      where: { businessId: p.businessId, platform: p.platform, source: 'MEASURED', engagementRate: { not: null }, publicationId: { not: null }, publication: { publishedAt: { not: null }, status: 'PUBLISHED' } },
      select: { engagementRate: true, publicationId: true, publication: { select: { publishedAt: true } } },
      take: 2000,
    });
    const byPub = new Map<string, { er: number; at: Date }>();
    for (const r of rows) if (r.publicationId && r.publication?.publishedAt && r.engagementRate !== null) byPub.set(r.publicationId, { er: Number(r.engagementRate), at: r.publication.publishedAt });
    const sampleSize = byPub.size;

    let times: Array<{ time: string; reason: string }>;
    let source: Recommendation['source'];
    let note: string;
    if (sampleSize >= ANALYTICS_MIN_SAMPLES) {
      const hours = new Map<number, number[]>();
      for (const { er, at } of byPub.values()) {
        const h = Number(utcToZoned(at, p.timezone).time.slice(0, 2));
        hours.set(h, [...(hours.get(h) ?? []), er]);
      }
      const ranked = [...hours.entries()]
        .map(([h, v]) => ({ h, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
        .sort((a, b) => (b.n >= 2 ? 1 : 0) - (a.n >= 2 ? 1 : 0) || b.avg - a.avg);
      if (ranked.length) {
        source = 'ANALYTICS';
        times = ranked.slice(0, limit).map((r) => ({ time: `${String(r.h).padStart(2, '0')}:00`, reason: `Average engagement ${(r.avg * 100).toFixed(1)}% over ${r.n} of your published post(s) at this hour` }));
        note = `Based on ${sampleSize} of your published posts with measured engagement on this platform.`;
        return this.finish(p, source, sampleSize, note, times, limit);
      }
    }
    source = 'ESTIMATE';
    const base = PLATFORM_RULES[p.platform as AiPlatform].estimate[weekend ? 'weekend' : 'weekday'];
    times = base.map((time) => ({ time, reason: 'General guidance for this platform, not your audience data' }));
    note = sampleSize
      ? `Estimate: only ${sampleSize} published post(s) with measured engagement (at least ${ANALYTICS_MIN_SAMPLES} are needed). These times are general guidance, not your audience data.`
      : 'Estimate: no measured audience data yet. These times are general guidance for the platform, not your audience data.';
    return this.finish(p, source, sampleSize, note, times, limit);
  }

  private finish(p: { platform: SocialPlatform; date: string; timezone: string; notBefore?: Date }, source: Recommendation['source'], sampleSize: number, note: string, times: Array<{ time: string; reason: string }>, limit: number): Recommendation {
    const usable = times
      .map((t) => ({ ...t, scheduledAt: zonedToUtc(p.date, t.time, p.timezone).utc }))
      .filter((s) => !p.notBefore || s.scheduledAt.getTime() > p.notBefore.getTime());
    // Analytics keep their ranking (best first); general guidance is shown in time order.
    const slots = (source === 'ESTIMATE' ? usable.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()) : usable)
      .slice(0, limit)
      .map((s) => ({ time: s.time, scheduledAt: s.scheduledAt.toISOString(), reason: s.reason }));
    return { platform: p.platform, date: p.date, timezone: p.timezone, source, sampleSize, note, slots };
  }

  /**
   * Picks the first recommended slot on (or after) a date that does not collide with existing entries,
   * looking up to 14 days ahead. Returns null when nothing is free.
   */
  async firstFreeSlot(db: Tx, p: { businessId: string; platform: SocialPlatform; date: string; timezone: string; notBefore: Date; taken?: Date[] }) {
    for (let i = 0; i < 14; i++) {
      const date = addDays(p.date, i);
      const rec = await this.recommend({ businessId: p.businessId, platform: p.platform, date, timezone: p.timezone, notBefore: p.notBefore, limit: 5 });
      for (const s of rec.slots) {
        const at = new Date(s.scheduledAt);
        const gap = PLATFORM_RULES[p.platform as AiPlatform].minGapMinutes * 60_000;
        if (p.taken?.some((t) => Math.abs(t.getTime() - at.getTime()) < gap)) continue;
        const conflicts = await this.detect(db, { businessId: p.businessId, platform: p.platform, scheduledAt: at, timezone: p.timezone });
        if (!conflicts.some((c) => c.code === 'SLOT_TOO_CLOSE' || c.code === 'DAILY_LIMIT' || c.severity === 'hard')) return { at, rec, slot: s };
      }
    }
    return null;
  }
}
