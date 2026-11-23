import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@touma/database';
import { imageCostUsd, resolveCreativePrice, videoCostUsd } from '@touma/creative';
import { addDays, parseEntitlements, todayIn, zonedToUtc } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { monthStart } from '../ai/ai-usage.service';

type Db = Prisma.TransactionClient;
export type UnitKind = 'IMAGE' | 'VIDEO_SECOND';
export type DailyKind = 'IMAGE' | 'VIDEO';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/**
 * Monthly image and video-second limits per business, enforced exactly like the AI generation limits: accepting a
 * job reserves its units with one conditional UPDATE on the business's monthly counter row (so concurrent requests
 * cannot overshoot), and the reservation is settled exactly once when the job ends. Units the provider actually
 * produced (and billed) are committed; everything else is released.
 */
@Injectable()
export class CreativeUsageService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /** An ACTIVE (trial included), PAST_DUE or GRACE_PERIOD plan's `aiImagesPerMonth` / `aiVideoSecondsPerMonth`, else the defaults. */
  async limitsFor(businessId: string, db: Db | PrismaService = this.prisma) {
    const defaults = { images: this.env.CREATIVE_MONTHLY_IMAGES_PER_BUSINESS, videoSeconds: this.env.CREATIVE_MONTHLY_VIDEO_SECONDS_PER_BUSINESS };
    const sub = await db.subscription.findUnique({ where: { businessId }, select: { status: true, plan: { select: { code: true, limits: true } } } });
    if (sub && (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE' || sub.status === 'GRACE_PERIOD')) {
      const l = (sub.plan.limits ?? {}) as Record<string, unknown>;
      const images = num(l.aiImagesPerMonth);
      const videoSeconds = num(l.aiVideoSecondsPerMonth);
      if (images !== undefined || videoSeconds !== undefined) return { images: images ?? defaults.images, videoSeconds: videoSeconds ?? defaults.videoSeconds, source: 'plan' as const, planCode: sub.plan.code };
    }
    return { ...defaults, source: 'default' as const };
  }

  async monthToDate(businessId: string, now = new Date()) {
    const periodStart = monthStart(now);
    const [p, limits] = await Promise.all([this.prisma.aIUsagePeriod.findUnique({ where: { businessId_periodStart: { businessId, periodStart } } }), this.limitsFor(businessId)]);
    return {
      images: { completed: p?.completedImages ?? 0, reserved: p?.reservedImages ?? 0, limit: limits.images, remaining: Math.max(0, limits.images - (p?.completedImages ?? 0) - (p?.reservedImages ?? 0)) },
      videoSeconds: { completed: p?.completedVideoSeconds ?? 0, reserved: p?.reservedVideoSeconds ?? 0, limit: limits.videoSeconds, remaining: Math.max(0, limits.videoSeconds - (p?.completedVideoSeconds ?? 0) - (p?.reservedVideoSeconds ?? 0)) },
      limitSource: limits.source,
      periodStart: periodStart.toISOString(),
    };
  }

  /** Atomically holds `units`; throws 429 when the monthly limit would be exceeded. Run inside the transaction that creates the generation. */
  async reserve(tx: Db, args: { businessId: string; kind: UnitKind; units: number; now?: Date }) {
    const periodStart = monthStart(args.now);
    const limits = await this.limitsFor(args.businessId, tx);
    const limit = args.kind === 'IMAGE' ? limits.images : limits.videoSeconds;
    await tx.$executeRaw`
      INSERT INTO "AIUsagePeriod" ("id", "businessId", "periodStart", "updatedAt")
      VALUES (${randomUUID()}, ${args.businessId}, ${periodStart}, now())
      ON CONFLICT ("businessId", "periodStart") DO NOTHING`;
    const updated =
      args.kind === 'IMAGE'
        ? await tx.$executeRaw`
            UPDATE "AIUsagePeriod" SET "reservedImages" = "reservedImages" + ${args.units}, "updatedAt" = now()
            WHERE "businessId" = ${args.businessId} AND "periodStart" = ${periodStart}
              AND "reservedImages" + "completedImages" + ${args.units} <= ${limit}`
        : await tx.$executeRaw`
            UPDATE "AIUsagePeriod" SET "reservedVideoSeconds" = "reservedVideoSeconds" + ${args.units}, "updatedAt" = now()
            WHERE "businessId" = ${args.businessId} AND "periodStart" = ${periodStart}
              AND "reservedVideoSeconds" + "completedVideoSeconds" + ${args.units} <= ${limit}`;
    if (updated === 1) return periodStart;
    const usage = await this.monthToDate(args.businessId, args.now);
    throw new HttpException(
      args.kind === 'IMAGE'
        ? { code: 'IMAGE_LIMIT_REACHED', message: `Monthly image limit reached (${limit})`, usage: usage.images }
        : { code: 'VIDEO_LIMIT_REACHED', message: `Monthly video limit reached (${limit} seconds)`, usage: usage.videoSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Closes a generation's reservation exactly once: produced units are committed, the rest is released. */
  async settle(generationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ businessId: string; periodStart: Date; reservedUnits: number; producedUnits: number; unitKind: string; dailyKind: string | null; dailyReserved: number; dailyKey: string | null }>>`
        UPDATE "CreativeGeneration" SET "settledAt" = now()
        WHERE "id" = ${generationId} AND "settledAt" IS NULL
        RETURNING "businessId", "periodStart", "reservedUnits", "producedUnits", "unitKind", "dailyKind", "dailyReserved", "dailyKey"`;
      const g = claimed[0];
      if (!g) return null;
      const consumed = Math.min(g.producedUnits, g.reservedUnits);
      if (g.unitKind === 'IMAGE') {
        await tx.$executeRaw`UPDATE "AIUsagePeriod" SET "reservedImages" = "reservedImages" - ${g.reservedUnits}, "completedImages" = "completedImages" + ${consumed}, "updatedAt" = now() WHERE "businessId" = ${g.businessId} AND "periodStart" = ${g.periodStart}`;
      } else {
        await tx.$executeRaw`UPDATE "AIUsagePeriod" SET "reservedVideoSeconds" = "reservedVideoSeconds" - ${g.reservedUnits}, "completedVideoSeconds" = "completedVideoSeconds" + ${consumed}, "updatedAt" = now() WHERE "businessId" = ${g.businessId} AND "periodStart" = ${g.periodStart}`;
      }
      // Daily advertising credits: only media that was actually delivered (stored) counts; the rest goes back. The claim above makes this happen once, so a retry never counts twice.
      if (g.dailyKind && g.dailyReserved > 0 && g.dailyKey) {
        const delivered = await tx.creativeOutput.count({ where: { generationId } });
        const dailyConsumed = g.dailyKind === 'IMAGE' ? Math.min(delivered, g.dailyReserved) : Math.min(delivered > 0 ? 1 : 0, g.dailyReserved);
        await tx.$executeRaw`UPDATE "CreativeDailyUsage" SET "reserved" = GREATEST("reserved" - ${g.dailyReserved}, 0), "completed" = "completed" + ${dailyConsumed}, "updatedAt" = now() WHERE "businessId" = ${g.businessId} AND "kind" = ${g.dailyKind} AND "dayKey" = ${g.dailyKey}`;
      }
      // The estimate held against the monthly creative budget is replaced by the recorded cost once the job is settled.
      await tx.$executeRaw`UPDATE "CreativeGeneration" SET "estimatedCostMicros" = NULL WHERE "id" = ${generationId}`;
      return { consumed, released: g.reservedUnits - consumed };
    });
  }

  // ─── Daily advertising quota (N26) ──────────────────────────────────────────

  /** Daily limits: the plan's creativeImagesPerDay / creativeVideosPerDay when the plan sets them, else the configured defaults (5 and 5). */
  async dailyLimits(businessId: string, db: Db | PrismaService = this.prisma) {
    const defaults = { images: this.env.CREATIVE_DAILY_IMAGES_PER_BUSINESS, videos: this.env.CREATIVE_DAILY_VIDEOS_PER_BUSINESS };
    const sub = await db.subscription.findUnique({ where: { businessId }, select: { status: true, plan: { select: { limits: true } } } });
    if (sub && (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE' || sub.status === 'GRACE_PERIOD')) {
      const e = parseEntitlements(sub.plan.limits);
      return { images: e.creativeImagesPerDay ?? defaults.images, videos: e.creativeVideosPerDay ?? defaults.videos, budgetMicros: e.creativeBudgetMicrosPerMonth ?? this.env.CREATIVE_MONTHLY_BUDGET_MICROS };
    }
    return { ...defaults, budgetMicros: this.env.CREATIVE_MONTHLY_BUDGET_MICROS };
  }

  /**
   * The timezone the day is counted in. It follows the business timezone only at the next local midnight and at most once per CREATIVE_QUOTA_TZ_CHANGE_DAYS,
   * so moving the timezone cannot open a second day of quota.
   */
  async quotaZone(businessId: string, now: Date = new Date(), db: Db | PrismaService = this.prisma) {
    const biz = await db.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
    const bizTz = biz?.timezone ?? 'UTC';
    let clock = await db.creativeQuotaClock.findUnique({ where: { businessId } });
    if (!clock) {
      // Two first requests can race on the unique row (Prisma's upsert is not atomic): the loser simply reads the winner's row.
      clock = await db.creativeQuotaClock.create({ data: { businessId, timezone: bizTz, changedAt: now } }).catch(async (e: unknown) => {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        return db.creativeQuotaClock.findUniqueOrThrow({ where: { businessId } });
      });
    }
    if (clock.pendingTimezone && clock.pendingFrom && now >= clock.pendingFrom) {
      clock = await db.creativeQuotaClock.update({ where: { businessId }, data: { timezone: clock.pendingTimezone, changedAt: clock.pendingFrom, pendingTimezone: null, pendingFrom: null } });
    } else if (bizTz === clock.timezone && clock.pendingTimezone) {
      clock = await db.creativeQuotaClock.update({ where: { businessId }, data: { pendingTimezone: null, pendingFrom: null } });
    } else if (bizTz !== clock.timezone && !clock.pendingTimezone && now.getTime() - clock.changedAt.getTime() >= this.env.CREATIVE_QUOTA_TZ_CHANGE_DAYS * 86_400_000) {
      const reset = this.dayInfo(clock.timezone, now).resetsAt;
      clock = await db.creativeQuotaClock.update({ where: { businessId }, data: { pendingTimezone: bizTz, pendingFrom: reset } });
    }
    return { timezone: clock.timezone, businessTimezone: bizTz, pendingTimezone: clock.pendingTimezone, pendingFrom: clock.pendingFrom, nextChangeAllowedAt: new Date(clock.changedAt.getTime() + this.env.CREATIVE_QUOTA_TZ_CHANGE_DAYS * 86_400_000) };
  }

  /** The local day in `tz` and the instant it ends (the next reset). */
  dayInfo(tz: string, now: Date) {
    const dayKey = todayIn(tz, now);
    return { dayKey, resetsAt: zonedToUtc(addDays(dayKey, 1), '00:00', tz).utc };
  }

  async dailyStatus(businessId: string, now: Date = new Date()) {
    const [zone, limits] = await Promise.all([this.quotaZone(businessId, now), this.dailyLimits(businessId)]);
    const { dayKey, resetsAt } = this.dayInfo(zone.timezone, now);
    const rows = await this.prisma.creativeDailyUsage.findMany({ where: { businessId, dayKey } });
    const row = (kind: DailyKind, limit: number) => { const r = rows.find((x) => x.kind === kind); const used = (r?.completed ?? 0) + (r?.reserved ?? 0); return { used, completed: r?.completed ?? 0, reserved: r?.reserved ?? 0, limit, remaining: Math.max(0, limit - used) }; };
    return { timezone: zone.timezone, dayKey, resetsAt: resetsAt.toISOString(), images: row('IMAGE', limits.images), videos: row('VIDEO', limits.videos), timezoneChange: { businessTimezone: zone.businessTimezone, applied: zone.businessTimezone === zone.timezone, pendingTimezone: zone.pendingTimezone, nextChangeAllowedAt: zone.nextChangeAllowedAt.toISOString() }, note: 'Images and videos have separate quotas that cannot be exchanged. The count covers media actually delivered; a failed or cancelled generation gives its credits back.' };
  }

  /** Holds `credits` of today's quota with one conditional UPDATE (no overshoot under concurrency). Throws 429 when it does not fit. Run inside the creating transaction. */
  async reserveDaily(tx: Db, args: { businessId: string; kind: DailyKind; credits: number; now?: Date }) {
    const now = args.now ?? new Date();
    const zone = await this.quotaZone(args.businessId, now, tx);
    const { dayKey, resetsAt } = this.dayInfo(zone.timezone, now);
    const limits = await this.dailyLimits(args.businessId, tx);
    const limit = args.kind === 'IMAGE' ? limits.images : limits.videos;
    await tx.$executeRaw`INSERT INTO "CreativeDailyUsage" ("id", "businessId", "kind", "dayKey", "updatedAt") VALUES (${randomUUID()}, ${args.businessId}, ${args.kind}, ${dayKey}, now()) ON CONFLICT ("businessId", "kind", "dayKey") DO NOTHING`;
    const updated = await tx.$executeRaw`UPDATE "CreativeDailyUsage" SET "reserved" = "reserved" + ${args.credits}, "updatedAt" = now() WHERE "businessId" = ${args.businessId} AND "kind" = ${args.kind} AND "dayKey" = ${dayKey} AND "reserved" + "completed" + ${args.credits} <= ${limit}`;
    if (updated === 1) return { dayKey, resetsAt };
    const r = await tx.creativeDailyUsage.findUnique({ where: { businessId_kind_dayKey: { businessId: args.businessId, kind: args.kind, dayKey } } });
    throw new HttpException({ code: 'CREATIVE_DAILY_LIMIT', message: `You have used all your ${args.kind === 'IMAGE' ? 'image' : 'video'} creations available today (${limit}). Your quota will be renewed at the next reset.`, usage: { kind: args.kind, limit, used: (r?.completed ?? 0) + (r?.reserved ?? 0), requested: args.credits, resetsAt: resetsAt.toISOString(), timezone: zone.timezone } }, HttpStatus.TOO_MANY_REQUESTS);
  }

  // ─── Monetary budget (N26) ──────────────────────────────────────────────────

  /** Estimated cost in micro-USD from the configured price table; null when the model has no price (unknown, never zero). */
  estimateMicros(model: string, kind: UnitKind, units: number): number | null {
    const price = this.priceFor(model);
    const usd = kind === 'IMAGE' ? (price.perImageUsd !== undefined ? imageCostUsd(price, units) : null) : price.perSecondUsd !== undefined ? videoCostUsd(price, units) : null;
    return usd === null ? null : Math.round(usd * 1_000_000);
  }

  /**
   * A free quota does not authorize a generation that would exceed the money available. When a monthly creative budget applies (plan or default), the cost spent this month
   * plus the estimates held by unsettled generations plus this one must fit; an unknown cost cannot be verified and is refused. Returns the estimate to hold.
   */
  async assertBudget(tx: Db, args: { businessId: string; model: string; kind: UnitKind; units: number; now?: Date }): Promise<number | null> {
    const limits = await this.dailyLimits(args.businessId, tx);
    const estimate = this.estimateMicros(args.model, args.kind, args.units);
    await this.assertPlatformCap(tx, estimate, args.now);
    if (!limits.budgetMicros) return estimate;
    if (estimate === null) throw new HttpException({ code: 'CREATIVE_COST_UNKNOWN', message: 'A monthly creative budget applies but the cost of this generation cannot be estimated, so it cannot be authorized.' }, HttpStatus.PAYMENT_REQUIRED);
    const start = monthStart(args.now);
    const [settled, held] = await Promise.all([
      tx.creativeGeneration.aggregate({ where: { businessId: args.businessId, createdAt: { gte: start }, settledAt: { not: null } }, _sum: { costUsd: true } }),
      tx.creativeGeneration.aggregate({ where: { businessId: args.businessId, createdAt: { gte: start }, settledAt: null }, _sum: { estimatedCostMicros: true } }),
    ]);
    const spent = Math.round(Number(settled._sum.costUsd ?? 0) * 1_000_000) + Number(held._sum.estimatedCostMicros ?? 0n);
    if (spent + estimate > limits.budgetMicros) throw new HttpException({ code: 'CREATIVE_BUDGET_EXCEEDED', message: 'The monthly creative budget does not cover this generation, even though quota remains.', usage: { budgetMicros: limits.budgetMicros, spentMicros: spent, estimateMicros: estimate } }, HttpStatus.PAYMENT_REQUIRED);
    return estimate;
  }

  /**
   * Platform-wide monthly cap (CREATIVE_PLATFORM_MONTHLY_CAP_MICROS): spent cost plus estimates held by unsettled generations, ALL businesses together, plus this one, must fit.
   * The per-business budget alone does not bound the platform. A global advisory lock makes the check atomic across businesses. The answer never reveals platform totals to a client.
   */
  private async assertPlatformCap(tx: Db, estimate: number | null, now?: Date) {
    const cap = this.env.CREATIVE_PLATFORM_MONTHLY_CAP_MICROS;
    if (!cap) return;
    if (estimate === null) throw new HttpException({ code: 'CREATIVE_COST_UNKNOWN', message: 'A platform spending cap applies but the cost of this generation cannot be estimated, so it cannot be authorized.' }, HttpStatus.PAYMENT_REQUIRED);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727401)`;
    const start = monthStart(now);
    const [settled, held] = await Promise.all([
      tx.creativeGeneration.aggregate({ where: { createdAt: { gte: start }, settledAt: { not: null } }, _sum: { costUsd: true } }),
      tx.creativeGeneration.aggregate({ where: { createdAt: { gte: start }, settledAt: null }, _sum: { estimatedCostMicros: true } }),
    ]);
    const spent = Math.round(Number(settled._sum.costUsd ?? 0) * 1_000_000) + Number(held._sum.estimatedCostMicros ?? 0n);
    if (spent + estimate > cap) throw new HttpException({ code: 'CREATIVE_PLATFORM_CAP_REACHED', message: 'Creative generation is temporarily unavailable on this platform this month. Please try again later or contact support.' }, HttpStatus.PAYMENT_REQUIRED);
  }

  priceFor(model: string) {
    return resolveCreativePrice(model, this.env.CREATIVE_MODEL_PRICING);
  }
  get costConfigured() {
    return Object.keys(this.env.CREATIVE_MODEL_PRICING).length > 0;
  }
  pricingSummary() {
    return { models: Object.entries(this.env.CREATIVE_MODEL_PRICING).map(([model, p]) => ({ model, ...p })) };
  }
}
