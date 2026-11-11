import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@touma/database';
import type { TextModelProvider } from '@touma/ai-engine';
import { TEXT_PROVIDER } from '../ai/ai-provider';
import { AiUsageService } from '../ai/ai-usage.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

/** Failure families, derived from the stored (generic, credential-free) error text. */
export function errorKind(error: string | null): string {
  if (!error) return 'validation';
  if (/timed out|timeout/i.test(error)) return 'timeout';
  if (/rate limit|quota/i.test(error)) return 'rate_limit';
  if (/credentials|rejected the credentials|not configured/i.test(error)) return 'auth';
  if (/server error|empty answer/i.test(error)) return 'server';
  if (/could not reach|network/i.test(error)) return 'network';
  if (/refus/i.test(error)) return 'refusal';
  if (/cut off|truncated/i.test(error)) return 'truncated';
  if (/^validation/i.test(error)) return 'validation';
  return 'other';
}

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);

/** What the merchant (and the platform team) needs to see about the AI: calls, failures, latency, tokens, cost, handoffs, and whether the AI is healthy right now. No message content. */
@Injectable()
export class SalesMonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageService,
    @Inject(TEXT_PROVIDER) private readonly provider: TextModelProvider,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /** Healthy / degraded / down from the most recent calls of this business (the last hour), so a failing provider is visible at once. */
  async health(businessId: string, now = new Date()) {
    const since = new Date(now.getTime() - 3_600_000);
    const recent = await this.prisma.aIUsage.findMany({ where: { businessId, agent: 'CUSTOMER_SUPPORT', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20, select: { success: true, error: true } });
    const failures = recent.filter((r) => !r.success).length;
    const lastThree = recent.slice(0, 3);
    let status: 'NOT_CONFIGURED' | 'IDLE' | 'OK' | 'DEGRADED' | 'DOWN' = 'OK';
    if (!this.provider.isConfigured()) status = 'NOT_CONFIGURED';
    else if (recent.length === 0) status = 'IDLE';
    else if (lastThree.length === 3 && lastThree.every((r) => !r.success)) status = 'DOWN';
    else if (failures / recent.length >= 0.5) status = 'DEGRADED';
    return { status, recentCalls: recent.length, recentFailures: failures, lastErrorKind: recent.find((r) => !r.success) ? errorKind(recent.find((r) => !r.success)!.error) : null, provider: this.provider.name, providerConfigured: this.provider.isConfigured() };
  }

  async monitoring(tenant: TenantContext, days: number) {
    const b = tenant.businessId;
    const since = new Date(Date.now() - days * 86_400_000);
    const where = { businessId: b, agent: 'CUSTOMER_SUPPORT' as const, createdAt: { gte: since } };
    const [rows, handoffs, conversations, drafts, confidence, held, daily, health] = await Promise.all([
      this.prisma.aIUsage.findMany({ where, select: { model: true, success: true, error: true, latencyMs: true, inputTokens: true, outputTokens: true, costUsd: true, attemptKind: true }, take: 20_000 }),
      this.prisma.conversation.groupBy({ by: ['handoffReason'], where: { businessId: b, isTest: false, escalated: true, createdAt: { gte: since } }, _count: true }),
      this.prisma.conversation.count({ where: { businessId: b, isTest: false, createdAt: { gte: since } } }),
      this.prisma.message.groupBy({ by: ['approvalStatus'], where: { businessId: b, authorType: 'AI_SUGGESTION', conversation: { isTest: false }, createdAt: { gte: since } }, _count: true }),
      this.prisma.$queryRaw<Array<{ level: string | null; n: bigint }>>(Prisma.sql`SELECT "aiMetadata"->>'confidence' AS level, count(*)::bigint AS n FROM "Message" WHERE "businessId" = ${b} AND "createdAt" >= ${since} AND "authorType" IN ('AI_REPLY','AI_SUGGESTION') GROUP BY 1`),
      this.prisma.message.count({ where: { businessId: b, authorType: 'AI_SUGGESTION', createdAt: { gte: since }, aiMetadata: { path: ['heldForReview'], equals: true } } }),
      this.prisma.$queryRaw<Array<{ day: Date; calls: bigint; failures: bigint }>>(Prisma.sql`SELECT date_trunc('day', "createdAt") AS day, count(*)::bigint AS calls, count(*) FILTER (WHERE NOT success)::bigint AS failures FROM "AIUsage" WHERE "businessId" = ${b} AND "agent" = 'CUSTOMER_SUPPORT' AND "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`),
      this.health(b),
    ]);
    const failed = rows.filter((r) => !r.success);
    const byKind: Record<string, number> = {};
    for (const f of failed) byKind[errorKind(f.error)] = (byKind[errorKind(f.error)] ?? 0) + 1;
    const lat = rows.filter((r) => r.success && r.latencyMs !== null).map((r) => r.latencyMs!).sort((a, c) => a - c);
    const handedOff = handoffs.reduce((s, h) => s + h._count, 0);
    const draftTotal = drafts.reduce((s, d) => s + d._count, 0);
    const decided = drafts.filter((d) => d.approvalStatus !== 'PENDING').reduce((s, d) => s + d._count, 0);
    const approved = drafts.find((d) => d.approvalStatus === 'APPROVED')?._count ?? 0;
    const byModel = new Map<string, { calls: number; tokensIn: number; tokensOut: number; cost: number }>();
    for (const r of rows) {
      const m = byModel.get(r.model) ?? { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
      m.calls++; m.tokensIn += r.inputTokens; m.tokensOut += r.outputTokens; m.cost += Number(r.costUsd);
      byModel.set(r.model, m);
    }
    const costConfigured = this.usage.costConfigured;
    return {
      days, health,
      ai: {
        calls: rows.length, failures: failed.length, failureRate: rows.length ? Math.round((failed.length / rows.length) * 1000) / 10 : null, failuresByKind: byKind, retriesAndRepairs: rows.filter((r) => r.attemptKind && r.attemptKind !== 'initial').length,
        latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: lat.length ? lat[lat.length - 1] : null },
        tokens: { input: rows.reduce((s, r) => s + r.inputTokens, 0), output: rows.reduce((s, r) => s + r.outputTokens, 0) },
        // Cost is only meaningful when prices are configured for the model that answered; otherwise it is unknown, never shown as zero.
        costUsd: costConfigured ? Math.round(rows.reduce((s, r) => s + Number(r.costUsd), 0) * 1e6) / 1e6 : null, costConfigured,
        byModel: [...byModel].map(([model, v]) => ({ model, calls: v.calls, tokensIn: v.tokensIn, tokensOut: v.tokensOut, costUsd: costConfigured ? Math.round(v.cost * 1e6) / 1e6 : null })),
      },
      handoffs: { total: handedOff, rate: conversations ? Math.round((handedOff / conversations) * 1000) / 10 : null, byReason: Object.fromEntries(handoffs.map((h) => [h.handoffReason ?? 'UNKNOWN', h._count])), aiUnavailable: handoffs.find((h) => h.handoffReason === 'AI_UNAVAILABLE')?._count ?? 0 },
      drafts: { total: draftTotal, approved, rejected: drafts.find((d) => d.approvalStatus === 'REJECTED')?._count ?? 0, pending: drafts.find((d) => d.approvalStatus === 'PENDING')?._count ?? 0, approvalRate: decided ? Math.round((approved / decided) * 1000) / 10 : null, heldBecauseOfConfidence: held },
      confidence: Object.fromEntries(confidence.map((c) => [c.level ?? 'UNKNOWN', Number(c.n)])),
      daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), calls: Number(d.calls), failures: Number(d.failures) })),
      conversations,
      note: 'Counted from recorded AI calls and conversations. Message content is never part of monitoring. Draft approval rate is only meaningful once enough drafts were reviewed.',
    };
  }

  /** Platform view for support: counts per business, no content. */
  async platform(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ businessId: string; calls: bigint; failures: bigint; tin: bigint | null; tout: bigint | null; cost: Prisma.Decimal | null }>>(Prisma.sql`
      SELECT "businessId", count(*)::bigint AS calls, count(*) FILTER (WHERE NOT success)::bigint AS failures, sum("inputTokens")::bigint AS tin, sum("outputTokens")::bigint AS tout, sum("costUsd") AS cost
      FROM "AIUsage" WHERE "agent" = 'CUSTOMER_SUPPORT' AND "createdAt" >= ${since} GROUP BY 1 ORDER BY calls DESC LIMIT 100`);
    const names = new Map((await this.prisma.business.findMany({ where: { id: { in: rows.map((r) => r.businessId) } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    return {
      days, providerConfigured: this.provider.isConfigured(), model: this.env.SALES_AGENT_MODEL ?? this.env.AI_MODEL,
      businesses: rows.map((r) => ({ businessId: r.businessId, name: names.get(r.businessId) ?? null, calls: Number(r.calls), failures: Number(r.failures), tokensIn: Number(r.tin ?? 0), tokensOut: Number(r.tout ?? 0), costUsd: this.usage.costConfigured ? Number(r.cost ?? 0) : null })),
    };
  }
}
