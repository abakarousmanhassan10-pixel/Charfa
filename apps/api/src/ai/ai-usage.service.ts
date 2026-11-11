import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type AIAgent, type AIReservation } from '@touma/database';
import { estimateCostUsd, resolvePricing, type AttemptRecord, type ModelPricing } from '@touma/ai-engine';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient;

export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface UsageLimits {
  generations: number;
  tokens: number;
  /** plan = taken from the business's active subscription plan; default = server-wide defaults. */
  source: 'plan' | 'default';
  planCode?: string;
}

export type SettleOutcome = 'succeeded' | 'failed' | 'released' | 'reconciled';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/**
 * Monthly AI quota accounting.
 *
 * Every generation job holds a RESERVATION (units + estimated tokens) from the moment it is accepted
 * until it is settled. Reserving is a single conditional UPDATE on the business's monthly counter row,
 * so the check and the increment happen atomically under the row lock:
 *
 *     reserved + completed + failed + units  <=  limit      (and the same for tokens)
 *
 * Concurrent requests therefore cannot overshoot, whatever the interleaving. When the job ends the
 * reservation is settled: units that consumed tokens move to completed/failed, the rest is released,
 * and the measured tokens replace the estimate.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger('AiUsage');

  constructor(
    private readonly prisma: PrismaService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  // ─── Pricing ────────────────────────────────────────────────────────────────

  private get fallbackPricing(): ModelPricing {
    return { inputPerMillion: this.env.AI_INPUT_COST_PER_1M_TOKENS, outputPerMillion: this.env.AI_OUTPUT_COST_PER_1M_TOKENS };
  }
  /** Price of the model that served a call: per-model table first, then the flat default, else "not configured". */
  priceFor(model: string) {
    return resolvePricing(model, this.env.AI_MODEL_PRICING, this.fallbackPricing);
  }
  get costConfigured() {
    return Object.keys(this.env.AI_MODEL_PRICING).length > 0 || this.fallbackPricing.inputPerMillion > 0 || this.fallbackPricing.outputPerMillion > 0;
  }
  /** Configured prices (non-secret), for the status endpoint and the usage page. */
  pricingSummary() {
    return {
      default: this.fallbackPricing,
      models: Object.entries(this.env.AI_MODEL_PRICING).map(([model, p]) => ({ model, ...p })),
    };
  }

  // ─── Limits ─────────────────────────────────────────────────────────────────

  /** Plan limits (aiGenerationsPerMonth / aiCreditsPerMonth, aiTokensPerMonth) of an active subscription, else the defaults. */
  async limitsFor(businessId: string, db: Db | PrismaService = this.prisma): Promise<UsageLimits> {
    const defaults = { generations: this.env.AI_MONTHLY_GENERATIONS_PER_BUSINESS, tokens: this.env.AI_MONTHLY_TOKENS_PER_BUSINESS };
    const sub = await db.subscription.findUnique({ where: { businessId }, select: { status: true, plan: { select: { code: true, limits: true } } } });
    if (sub && (sub.status === 'ACTIVE' || sub.status === 'TRIALING')) {
      const l = (sub.plan.limits ?? {}) as Record<string, unknown>;
      const generations = num(l.aiGenerationsPerMonth) ?? num(l.aiCreditsPerMonth);
      const tokens = num(l.aiTokensPerMonth);
      if (generations !== undefined || tokens !== undefined) {
        return { generations: generations ?? defaults.generations, tokens: tokens ?? defaults.tokens, source: 'plan', planCode: sub.plan.code };
      }
    }
    return { ...defaults, source: 'default' };
  }

  async monthToDate(businessId: string, now = new Date()) {
    const periodStart = monthStart(now);
    const [p, limits] = await Promise.all([
      this.prisma.aIUsagePeriod.findUnique({ where: { businessId_periodStart: { businessId, periodStart } } }),
      this.limitsFor(businessId),
    ]);
    const completed = p?.completedGenerations ?? 0;
    const failed = p?.failedGenerations ?? 0;
    const reserved = p?.reservedGenerations ?? 0;
    return {
      /** Generations that consumed tokens this month (completed + failed). */
      generations: completed + failed,
      completedGenerations: completed,
      failedGenerations: failed,
      reservedGenerations: reserved,
      releasedGenerations: p?.releasedGenerations ?? 0,
      tokens: p?.usedTokens ?? 0,
      reservedTokens: p?.reservedTokens ?? 0,
      generationLimit: limits.generations,
      tokenLimit: limits.tokens,
      remainingGenerations: Math.max(0, limits.generations - completed - failed - reserved),
      limitSource: limits.source,
      ...(limits.planCode ? { planCode: limits.planCode } : {}),
      periodStart: periodStart.toISOString(),
    };
  }

  // ─── Reservations ───────────────────────────────────────────────────────────

  /**
   * Atomically holds `units` generations (and the estimated tokens) for a job. Must run in the same
   * transaction as the creation of the generation row. Throws 429 when a limit would be exceeded.
   */
  async reserve(tx: Db, args: { businessId: string; generationId: string; units: number; now?: Date }): Promise<AIReservation> {
    const periodStart = monthStart(args.now);
    const limits = await this.limitsFor(args.businessId, tx);
    const tokens = args.units * this.env.AI_TOKENS_RESERVED_PER_GENERATION;
    await this.claim(tx, args.businessId, periodStart, args.units, tokens, limits);
    return tx.aIReservation.create({ data: { businessId: args.businessId, generationId: args.generationId, periodStart, units: args.units, tokens } });
  }

  /** Adds capacity to a running job's reservation (e.g. a cached analysis went stale), under the same atomic rule. */
  async topUp(generationId: string, extraUnits: number) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.aIReservation.findUnique({ where: { generationId } });
      if (!r || r.status !== 'RESERVED') throw new HttpException({ code: 'AI_RESERVATION_CLOSED', message: 'The usage reservation of this job is closed' }, HttpStatus.CONFLICT);
      const tokens = extraUnits * this.env.AI_TOKENS_RESERVED_PER_GENERATION;
      await this.claim(tx, r.businessId, r.periodStart, extraUnits, tokens, await this.limitsFor(r.businessId, tx));
      return tx.aIReservation.update({ where: { id: r.id }, data: { units: { increment: extraUnits }, tokens: { increment: tokens } } });
    });
  }

  /** Makes sure the job's reservation covers `rowsNeeded` generation rows, topping it up if necessary. */
  async ensureCovers(generationId: string, rowsNeeded: number) {
    const r = await this.prisma.aIReservation.findUnique({ where: { generationId }, select: { units: true } });
    if (r && r.units < rowsNeeded) await this.topUp(generationId, rowsNeeded - r.units);
  }

  /** The one place where limits are enforced: a conditional UPDATE that only matches while capacity remains. */
  private async claim(tx: Db, businessId: string, periodStart: Date, units: number, tokens: number, limits: UsageLimits) {
    await tx.$executeRaw`
      INSERT INTO "AIUsagePeriod" ("id", "businessId", "periodStart", "updatedAt")
      VALUES (${randomUUID()}, ${businessId}, ${periodStart}, now())
      ON CONFLICT ("businessId", "periodStart") DO NOTHING`;
    const updated = await tx.$executeRaw`
      UPDATE "AIUsagePeriod"
      SET "reservedGenerations" = "reservedGenerations" + ${units},
          "reservedTokens" = "reservedTokens" + ${tokens},
          "updatedAt" = now()
      WHERE "businessId" = ${businessId} AND "periodStart" = ${periodStart}
        AND "reservedGenerations" + "completedGenerations" + "failedGenerations" + ${units} <= ${limits.generations}
        AND "reservedTokens" + "usedTokens" + ${tokens} <= ${limits.tokens}`;
    if (updated === 1) return;
    const p = await tx.aIUsagePeriod.findUniqueOrThrow({ where: { businessId_periodStart: { businessId, periodStart } } });
    const usage = {
      generations: p.completedGenerations + p.failedGenerations,
      reservedGenerations: p.reservedGenerations,
      generationLimit: limits.generations,
      tokens: p.usedTokens,
      reservedTokens: p.reservedTokens,
      tokenLimit: limits.tokens,
      periodStart: periodStart.toISOString(),
    };
    if (p.reservedGenerations + p.completedGenerations + p.failedGenerations + units > limits.generations) {
      throw new HttpException({ code: 'AI_LIMIT_REACHED', message: `Monthly AI generation limit reached (${limits.generations})`, usage }, HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new HttpException({ code: 'AI_TOKEN_LIMIT_REACHED', message: 'Monthly AI token limit reached', usage }, HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * Closes a job's reservation. Idempotent: only the first caller settles, later calls return null.
   *  - rows of the job that consumed tokens count as completed (SUCCEEDED) or failed (anything else);
   *  - rows that never reached the provider, or whose calls all errored, consume nothing and are released;
   *  - measured tokens replace the reserved estimate.
   */
  async settle(generationId: string, outcome: SettleOutcome) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ id: string; businessId: string; periodStart: Date; units: number; tokens: number }>>`
        UPDATE "AIReservation" SET "status" = 'COMMITTED', "settledAt" = now()
        WHERE "generationId" = ${generationId} AND "status" = 'RESERVED'
        RETURNING "id", "businessId", "periodStart", "units", "tokens"`;
      const r = claimed[0];
      if (!r) return null;
      const rows = await tx.$queryRaw<Array<{ id: string; status: string; tokens: bigint }>>`
        SELECT g."id", g."status"::text AS status, COALESCE(SUM(u."inputTokens" + u."outputTokens"), 0) AS tokens
        FROM "AIGeneration" g LEFT JOIN "AIUsage" u ON u."generationId" = g."id"
        WHERE g."rootId" = ${generationId}
        GROUP BY g."id", g."status"`;
      const consumed = rows.filter((x) => Number(x.tokens) > 0);
      const completed = consumed.filter((x) => x.status === 'SUCCEEDED').length;
      const failed = consumed.length - completed;
      const tokens = consumed.reduce((s, x) => s + Number(x.tokens), 0);
      const released = Math.max(0, r.units - consumed.length);
      await tx.$executeRaw`
        UPDATE "AIUsagePeriod"
        SET "reservedGenerations" = "reservedGenerations" - ${r.units},
            "completedGenerations" = "completedGenerations" + ${completed},
            "failedGenerations" = "failedGenerations" + ${failed},
            "releasedGenerations" = "releasedGenerations" + ${released},
            "reservedTokens" = "reservedTokens" - ${r.tokens},
            "usedTokens" = "usedTokens" + ${tokens},
            "updatedAt" = now()
        WHERE "businessId" = ${r.businessId} AND "periodStart" = ${r.periodStart}`;
      return tx.aIReservation.update({
        where: { id: r.id },
        data: { status: consumed.length > 0 ? 'COMMITTED' : 'RELEASED', consumedUnits: consumed.length, consumedTokens: tokens, outcome },
      });
    });
  }

  /** Counters recomputed from their sources, to prove they agree (used by tests and the reconciler). */
  async consistency(businessId: string, periodStart = monthStart()) {
    const [p, held] = await Promise.all([
      this.prisma.aIUsagePeriod.findUnique({ where: { businessId_periodStart: { businessId, periodStart } } }),
      this.prisma.aIReservation.aggregate({ where: { businessId, periodStart, status: 'RESERVED' }, _sum: { units: true, tokens: true } }),
    ]);
    const settled = await this.prisma.aIReservation.aggregate({ where: { businessId, periodStart, status: { in: ['COMMITTED', 'RELEASED'] } }, _sum: { consumedTokens: true } });
    return {
      reservedGenerations: { counter: p?.reservedGenerations ?? 0, expected: held._sum.units ?? 0 },
      reservedTokens: { counter: p?.reservedTokens ?? 0, expected: held._sum.tokens ?? 0 },
      // Only reservations created after the counters were introduced contribute to this comparison.
      settledTokens: { counter: p?.usedTokens ?? 0, settledByReservations: settled._sum.consumedTokens ?? 0 },
    };
  }

  /**
   * Settles reservations whose job reached a final state without settling (crash between the last
   * write and the settle call). Reservations of jobs that are still queued or running are never touched
   * here: those are handled by the worker, which knows whether the BullMQ job still exists.
   */
  async reconcileFinished() {
    const open = await this.prisma.aIReservation.findMany({
      where: { status: 'RESERVED', generation: { status: { in: ['SUCCEEDED', 'FAILED', 'BLOCKED'] } } },
      select: { generationId: true },
      take: 200,
    });
    let settled = 0;
    for (const r of open) if (await this.settle(r.generationId, 'reconciled')) settled++;
    if (settled) this.logger.warn(`Reconciled ${settled} unsettled AI reservation(s)`);
    return settled;
  }

  // ─── Recording ──────────────────────────────────────────────────────────────

  /** One AIUsage row per provider call (initial, retries, repairs), priced with the model that served it. */
  async recordAttempts(args: { businessId: string; userId: string; agent: AIAgent; provider: string; operation: string; generationId: string; attempts: AttemptRecord[] }) {
    if (!args.attempts.length) return this.totalsFor(args.generationId);
    await this.prisma.aIUsage.createMany({
      data: args.attempts.map((a) => ({
        businessId: args.businessId,
        userId: args.userId,
        agent: args.agent,
        provider: args.provider,
        model: a.model,
        operation: args.operation,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        costUsd: new Prisma.Decimal(estimateCostUsd(a.inputTokens, a.outputTokens, this.priceFor(a.model).pricing).toFixed(6)),
        success: a.success,
        error: a.error ? a.error.slice(0, 300) : a.issues ? `validation: ${a.issues.slice(0, 3).join('; ').slice(0, 280)}` : null,
        latencyMs: a.latencyMs,
        generationId: args.generationId,
        attemptKind: a.kind,
      })),
    });
    return this.totalsFor(args.generationId);
  }

  /** Totals of every provider call recorded for a generation (stable across job retries). */
  async totalsFor(generationId: string) {
    const t = await this.prisma.aIUsage.aggregate({ where: { generationId }, _sum: { inputTokens: true, outputTokens: true, costUsd: true, latencyMs: true }, _count: { _all: true } });
    return {
      calls: t._count._all,
      inputTokens: t._sum.inputTokens ?? 0,
      outputTokens: t._sum.outputTokens ?? 0,
      costUsd: Number(t._sum.costUsd ?? 0),
      latencyMs: t._sum.latencyMs ?? 0,
    };
  }

  // ─── Reports ────────────────────────────────────────────────────────────────

  /** Token consumption report for one business (measured provider usage; cost = tokens × configured price). */
  async report(businessId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const where = { businessId, createdAt: { gte: since } };
    const sum = { inputTokens: true, outputTokens: true, costUsd: true } as const;
    const [totals, byAgent, byModel, gens, rows, month] = await Promise.all([
      this.prisma.aIUsage.aggregate({ where, _sum: sum, _count: { _all: true } }),
      this.prisma.aIUsage.groupBy({ by: ['agent'], where, _sum: sum, _count: { _all: true } }),
      this.prisma.aIUsage.groupBy({ by: ['model'], where, _sum: sum, _count: { _all: true } }),
      this.prisma.aIGeneration.groupBy({ by: ['task', 'status'], where, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ day: Date; input: bigint; output: bigint; calls: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day, SUM("inputTokens")::bigint AS input, SUM("outputTokens")::bigint AS output, COUNT(*)::bigint AS calls
        FROM "AIUsage" WHERE "businessId" = ${businessId} AND "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1`,
      this.monthToDate(businessId),
    ]);
    const n = (v: unknown) => Number(v ?? 0);
    const money = (v: Prisma.Decimal | null) => (v ? Number(v.toFixed(6)) : 0);
    const count = (status: string) => gens.filter((g) => g.status === status).reduce((s, g) => s + g._count._all, 0);
    return {
      periodDays: days,
      since: since.toISOString(),
      costConfigured: this.costConfigured,
      pricing: this.pricingSummary(),
      totals: {
        providerCalls: totals._count._all,
        inputTokens: n(totals._sum.inputTokens),
        outputTokens: n(totals._sum.outputTokens),
        costUsd: money(totals._sum.costUsd),
        generations: count('SUCCEEDED') + count('FAILED'),
        succeeded: count('SUCCEEDED'),
        failed: count('FAILED'),
        inFlight: count('QUEUED') + count('RUNNING'),
      },
      byTask: Object.values(
        gens.reduce<Record<string, { task: string; succeeded: number; failed: number }>>((acc, g) => {
          acc[g.task] ??= { task: g.task, succeeded: 0, failed: 0 };
          if (g.status === 'SUCCEEDED') acc[g.task]!.succeeded += g._count._all;
          if (g.status === 'FAILED') acc[g.task]!.failed += g._count._all;
          return acc;
        }, {}),
      ),
      byAgent: byAgent.map((a) => ({ agent: a.agent, calls: a._count._all, inputTokens: n(a._sum.inputTokens), outputTokens: n(a._sum.outputTokens), costUsd: money(a._sum.costUsd) })),
      byModel: byModel.map((a) => ({ model: a.model, calls: a._count._all, inputTokens: n(a._sum.inputTokens), outputTokens: n(a._sum.outputTokens), costUsd: money(a._sum.costUsd) })),
      byDay: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), calls: n(r.calls), inputTokens: n(r.input), outputTokens: n(r.output) })),
      monthToDate: month,
    };
  }

  /**
   * Monthly usage report for one business: generation counters (reserved / completed / failed /
   * released) from the usage period, and measured tokens and estimated cost per model from the
   * recorded provider calls. Months without activity are included as zeros.
   */
  async monthly(businessId: string, months: number, now = new Date()) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const [periods, usage] = await Promise.all([
      this.prisma.aIUsagePeriod.findMany({ where: { businessId, periodStart: { gte: first } } }),
      this.prisma.$queryRaw<Array<{ month: Date; model: string; calls: bigint; input: bigint; output: bigint; cost: Prisma.Decimal }>>`
        SELECT date_trunc('month', "createdAt" AT TIME ZONE 'UTC') AS month, "model", COUNT(*)::bigint AS calls,
               COALESCE(SUM("inputTokens"), 0)::bigint AS input, COALESCE(SUM("outputTokens"), 0)::bigint AS output,
               COALESCE(SUM("costUsd"), 0) AS cost
        FROM "AIUsage" WHERE "businessId" = ${businessId} AND "createdAt" >= ${first}
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
    ]);
    const limits = await this.limitsFor(businessId);
    const key = (d: Date) => d.toISOString().slice(0, 7);
    const out = [];
    for (let i = 0; i < months; i++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const p = periods.find((x) => key(x.periodStart) === key(start));
      const u = usage.filter((x) => key(x.month) === key(start));
      out.push({
        month: key(start),
        generations: { reserved: p?.reservedGenerations ?? 0, completed: p?.completedGenerations ?? 0, failed: p?.failedGenerations ?? 0, released: p?.releasedGenerations ?? 0 },
        tokens: { input: u.reduce((s, x) => s + Number(x.input), 0), output: u.reduce((s, x) => s + Number(x.output), 0), reserved: p?.reservedTokens ?? 0, settled: p?.usedTokens ?? 0 },
        providerCalls: u.reduce((s, x) => s + Number(x.calls), 0),
        costUsd: Number(u.reduce((s, x) => s + Number(x.cost), 0).toFixed(6)),
        byModel: u.map((x) => ({ model: x.model, calls: Number(x.calls), inputTokens: Number(x.input), outputTokens: Number(x.output), costUsd: Number(Number(x.cost).toFixed(6)) })),
        ...(i === 0 ? { limits: { generations: limits.generations, tokens: limits.tokens, source: limits.source } } : {}),
      });
    }
    return { costConfigured: this.costConfigured, pricing: this.pricingSummary(), months: out };
  }
}
