import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type AIAgent } from '@touma/database';
import { estimateCostUsd, type AttemptRecord } from '@touma/ai-engine';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get pricing() {
    return { inputPerMillion: this.env.AI_INPUT_COST_PER_1M_TOKENS, outputPerMillion: this.env.AI_OUTPUT_COST_PER_1M_TOKENS };
  }
  get costConfigured() {
    return this.pricing.inputPerMillion > 0 || this.pricing.outputPerMillion > 0;
  }

  async monthToDate(businessId: string) {
    const since = monthStart();
    const [generations, tokens] = await Promise.all([
      this.prisma.aIGeneration.count({ where: { businessId, createdAt: { gte: since }, status: { in: ['SUCCEEDED', 'FAILED'] } } }),
      this.prisma.aIUsage.aggregate({ where: { businessId, createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true } }),
    ]);
    return {
      generations,
      tokens: (tokens._sum.inputTokens ?? 0) + (tokens._sum.outputTokens ?? 0),
      generationLimit: this.env.AI_MONTHLY_GENERATIONS_PER_BUSINESS,
      tokenLimit: this.env.AI_MONTHLY_TOKENS_PER_BUSINESS,
      periodStart: since.toISOString(),
    };
  }

  /** Blocks the request before any provider call when the business is over its monthly limits. */
  async assertWithinLimits(businessId: string, plannedCalls = 1) {
    const u = await this.monthToDate(businessId);
    if (u.generations + plannedCalls > u.generationLimit) {
      throw new HttpException({ code: 'AI_LIMIT_REACHED', message: `Monthly AI generation limit reached (${u.generationLimit})`, usage: u }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (u.tokens >= u.tokenLimit) {
      throw new HttpException({ code: 'AI_TOKEN_LIMIT_REACHED', message: 'Monthly AI token limit reached', usage: u }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return u;
  }

  /** One AIUsage row per provider call (initial, retries, repairs), so every token is accounted for. */
  async recordAttempts(args: { businessId: string; userId: string; agent: AIAgent; provider: string; operation: string; generationId: string; attempts: AttemptRecord[] }) {
    if (!args.attempts.length) return { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
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
        costUsd: new Prisma.Decimal(estimateCostUsd(a.inputTokens, a.outputTokens, this.pricing).toFixed(6)),
        success: a.success,
        error: a.error ? a.error.slice(0, 300) : a.issues ? `validation: ${a.issues.slice(0, 3).join('; ').slice(0, 280)}` : null,
        latencyMs: a.latencyMs,
        generationId: args.generationId,
        attemptKind: a.kind,
      })),
    });
    const inputTokens = args.attempts.reduce((s, a) => s + a.inputTokens, 0);
    const outputTokens = args.attempts.reduce((s, a) => s + a.outputTokens, 0);
    return {
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(inputTokens, outputTokens, this.pricing),
      latencyMs: args.attempts.reduce((s, a) => s + a.latencyMs, 0),
    };
  }

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
    return {
      periodDays: days,
      since: since.toISOString(),
      costConfigured: this.costConfigured,
      totals: {
        providerCalls: totals._count._all,
        inputTokens: n(totals._sum.inputTokens),
        outputTokens: n(totals._sum.outputTokens),
        costUsd: money(totals._sum.costUsd),
        generations: gens.reduce((s, g) => s + g._count._all, 0),
        succeeded: gens.filter((g) => g.status === 'SUCCEEDED').reduce((s, g) => s + g._count._all, 0),
        failed: gens.filter((g) => g.status === 'FAILED').reduce((s, g) => s + g._count._all, 0),
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
}
