import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@touma/database';
import { resolveCreativePrice } from '@touma/creative';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { monthStart } from '../ai/ai-usage.service';

type Db = Prisma.TransactionClient;
export type UnitKind = 'IMAGE' | 'VIDEO_SECOND';

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

  /** An ACTIVE or TRIALING plan's `aiImagesPerMonth` / `aiVideoSecondsPerMonth`, else the defaults. */
  async limitsFor(businessId: string, db: Db | PrismaService = this.prisma) {
    const defaults = { images: this.env.CREATIVE_MONTHLY_IMAGES_PER_BUSINESS, videoSeconds: this.env.CREATIVE_MONTHLY_VIDEO_SECONDS_PER_BUSINESS };
    const sub = await db.subscription.findUnique({ where: { businessId }, select: { status: true, plan: { select: { code: true, limits: true } } } });
    if (sub && (sub.status === 'ACTIVE' || sub.status === 'TRIALING')) {
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
      const claimed = await tx.$queryRaw<Array<{ businessId: string; periodStart: Date; reservedUnits: number; producedUnits: number; unitKind: string }>>`
        UPDATE "CreativeGeneration" SET "settledAt" = now()
        WHERE "id" = ${generationId} AND "settledAt" IS NULL
        RETURNING "businessId", "periodStart", "reservedUnits", "producedUnits", "unitKind"`;
      const g = claimed[0];
      if (!g) return null;
      const consumed = Math.min(g.producedUnits, g.reservedUnits);
      if (g.unitKind === 'IMAGE') {
        await tx.$executeRaw`UPDATE "AIUsagePeriod" SET "reservedImages" = "reservedImages" - ${g.reservedUnits}, "completedImages" = "completedImages" + ${consumed}, "updatedAt" = now() WHERE "businessId" = ${g.businessId} AND "periodStart" = ${g.periodStart}`;
      } else {
        await tx.$executeRaw`UPDATE "AIUsagePeriod" SET "reservedVideoSeconds" = "reservedVideoSeconds" - ${g.reservedUnits}, "completedVideoSeconds" = "completedVideoSeconds" + ${consumed}, "updatedAt" = now() WHERE "businessId" = ${g.businessId} AND "periodStart" = ${g.periodStart}`;
      }
      return { consumed, released: g.reservedUnits - consumed };
    });
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
