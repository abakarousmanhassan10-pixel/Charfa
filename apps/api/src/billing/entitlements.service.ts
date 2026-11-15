import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { hasAgent, hasFeature, parseEntitlements, resolveEntitlement, type PlanEntitlements, type PlanFeature } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { FounderService } from './founder.service';

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export interface ResolvedEntitlements {
  /** founder = free for life (highest plan's entitlements); plan = the business's current plan while it has access; open = no plan restricts it. */
  source: 'founder' | 'plan' | 'open';
  planCode: string | null;
  e: PlanEntitlements;
}

/**
 * What the business's plan allows (agents, features, quotas), decided on the server from the database. The restrictions on agents, features and sales
 * interactions are enforced only when BILLING_ENFORCEMENT_ENABLED=true (businesses without a subscription are otherwise untouched); AI generation, image and
 * video quotas already follow the plan's limits whenever the plan is active. An expired or unpaid business loses paid actions (see BillingService.assertAccess)
 * but can still read its history, usage and billing pages.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly founders: FounderService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async resolve(businessId: string): Promise<ResolvedEntitlements> {
    if (await this.founders.isFounder(businessId)) {
      const top = await this.prisma.plan.findUnique({ where: { code: 'BUSINESS' }, select: { code: true, limits: true } });
      return { source: 'founder', planCode: top?.code ?? null, e: parseEntitlements(top?.limits ?? {}) };
    }
    const sub = await this.prisma.subscription.findUnique({ where: { businessId }, include: { plan: { select: { code: true, limits: true } } } });
    const ent = resolveEntitlement({ now: new Date(), isFounder: false, graceDays: this.env.BILLING_GRACE_DAYS, subscription: sub });
    if (sub && ent.hasAccess) return { source: 'plan', planCode: sub.plan.code, e: parseEntitlements(sub.plan.limits) };
    return { source: 'open', planCode: sub?.plan.code ?? null, e: parseEntitlements({}) };
  }

  private deny(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}): never {
    throw new HttpException({ code, message, ...extra }, status);
  }

  async assertFeature(businessId: string, feature: PlanFeature): Promise<void> {
    if (!this.env.BILLING_ENFORCEMENT_ENABLED) return;
    const r = await this.resolve(businessId);
    if (!hasFeature(r.e, feature)) this.deny(HttpStatus.PAYMENT_REQUIRED, 'FEATURE_NOT_IN_PLAN', 'This feature is not included in your plan', { feature, plan: r.planCode });
  }

  async assertAgent(businessId: string, agent: string): Promise<void> {
    if (!this.env.BILLING_ENFORCEMENT_ENABLED) return;
    const r = await this.resolve(businessId);
    if (!hasAgent(r.e, agent)) this.deny(HttpStatus.PAYMENT_REQUIRED, 'AGENT_NOT_IN_PLAN', 'This AI agent is not included in your plan', { agent, plan: r.planCode });
  }

  /** Sales-agent replies this month (every model attempt that produced a reply counts once, failures do not). */
  async salesInteractionsUsed(businessId: string, now = new Date()): Promise<number> {
    return this.prisma.aIUsage.count({ where: { businessId, operation: 'sales_reply', success: true, createdAt: { gte: monthStart(now) } } });
  }

  async assertSalesInteraction(businessId: string): Promise<void> {
    if (!this.env.BILLING_ENFORCEMENT_ENABLED) return;
    const r = await this.resolve(businessId);
    if (r.e.salesInteractionsPerMonth === null) return;
    const used = await this.salesInteractionsUsed(businessId);
    if (used >= r.e.salesInteractionsPerMonth) this.deny(HttpStatus.TOO_MANY_REQUESTS, 'PLAN_QUOTA_REACHED', 'The monthly AI sales-assistant limit of your plan is reached', { quota: 'salesInteractions', used, limit: r.e.salesInteractionsPerMonth });
  }

  /** What the customer sees: plan, agents, features and consumption this month. */
  async summary(businessId: string) {
    const r = await this.resolve(businessId);
    const period = await this.prisma.aIUsagePeriod.findUnique({ where: { businessId_periodStart: { businessId, periodStart: monthStart() } } });
    return {
      enforced: this.env.BILLING_ENFORCEMENT_ENABLED,
      source: r.source,
      plan: r.planCode,
      agents: { allowed: r.e.agents, max: r.e.maxAgents },
      features: r.e.features,
      usage: {
        aiGenerations: { used: (period?.completedGenerations ?? 0), limit: r.e.aiGenerationsPerMonth ?? this.env.AI_MONTHLY_GENERATIONS_PER_BUSINESS },
        aiTokens: { used: period?.usedTokens ?? 0, limit: r.e.aiTokensPerMonth ?? this.env.AI_MONTHLY_TOKENS_PER_BUSINESS },
        salesInteractions: { used: await this.salesInteractionsUsed(businessId), limit: r.e.salesInteractionsPerMonth },
      },
    };
  }
}
