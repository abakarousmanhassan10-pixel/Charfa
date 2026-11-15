import { Injectable, Logger } from '@nestjs/common';
import { parseEntitlements, resolveEntitlement, type AgentTypeName, AGENT_CATALOG, type Entitlement } from '@touma/shared';
import { Prisma } from '@touma/database';
import { AuditService } from '../audit/audit.service';
import { FounderService } from '../billing/founder.service';
import { AppEnv, InjectEnv } from '../config';
import { lockTenantQuota } from '../common/tenant-quota';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DENIED } from './agent-errors';
import { KillSwitchService } from './kill-switch.service';
import { PricesService } from './prices.service';

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

export interface TenantLimits {
  /** billing = the subscription's period; calendar = a calendar month (no subscription). */
  source: 'billing' | 'calendar';
  periodStart: Date;
  periodEnd: Date;
  planCode: string | null;
  founder: boolean;
  hasSubscription: boolean;
  access: Entitlement;
  allowedAgents: string[] | null;
  features: string[] | null;
  maxAgentInstances: number | null;
  callsLimit: number;
  budgetLimitMicros: bigint;
}

export interface ReserveInput {
  businessId: string;
  agentId: string;
  agentType: AgentTypeName;
  agentMaxCallsPerDay: number;
  agentMaxCostPerRunMicros: number;
  runId: string;
  stepKey: string;
  attempt: number;
  estimateMicros: bigint;
}

export interface SettleInput { modelId: string; inputTokens: number; outputTokens: number; cachedTokens?: number | null; status: 'SUCCEEDED' | 'FAILED'; errorCode?: string | null }

/**
 * The billing guardian for agents (N28): the single place that decides whether an agent may run, and that holds, consumes and releases quotas and budget.
 *  - Subscription: with a subscription row the business needs access (trial, paid period, grace, paid period of a canceled one); with none, only without enforcement.
 *  - Plan: the `agents` feature, the agent type, the number of agents, calls and budget per BILLING period (a renewal starts a new period with fresh counters;
 *    during the grace days the last period's counters continue: no fresh quota until the renewal is paid; a plan change applies from the next period).
 *  - Reservation: atomic under a per-business lock (calls, period budget, daily cap, monthly cap, per-run cap, agent daily limit), so two simultaneous tasks can never
 *    exceed a limit. A reservation is settled with what was really used, or released when nothing was consumed; abandoned ones are reconciled.
 *  - Costs are ESTIMATES from the versioned price table (micro-units), never invoices.
 */
@Injectable()
export class AgentGuardian {
  private readonly logger = new Logger('AgentGuardian');
  constructor(
    private readonly prisma: PrismaService,
    private readonly kill: KillSwitchService,
    private readonly prices: PricesService,
    private readonly founders: FounderService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  // ─── Limits of a business ────────────────────────────────────────────────

  async limitsFor(businessId: string, now = new Date()): Promise<TenantLimits> {
    const founder = await this.founders.isFounder(businessId);
    const sub = await this.prisma.subscription.findUnique({ where: { businessId }, include: { plan: { select: { code: true, limits: true } } } });
    const access = resolveEntitlement({ now, isFounder: founder, graceDays: this.env.BILLING_GRACE_DAYS, subscription: sub });
    let plan: { code: string; limits: unknown } | null = null;
    if (founder) plan = await this.prisma.plan.findUnique({ where: { code: 'BUSINESS' }, select: { code: true, limits: true } });
    else if (sub && access.hasAccess) plan = sub.plan;
    const e = parseEntitlements(plan?.limits ?? {});
    const billing = !founder && sub?.currentPeriodStart && sub.currentPeriodEnd;
    return {
      source: billing ? 'billing' : 'calendar',
      periodStart: billing ? sub!.currentPeriodStart! : monthStart(now),
      periodEnd: billing ? sub!.currentPeriodEnd! : nextMonth(now),
      planCode: plan?.code ?? sub?.plan.code ?? null,
      founder,
      hasSubscription: Boolean(sub),
      access,
      allowedAgents: e.agents,
      features: e.features,
      maxAgentInstances: e.maxAgentInstances,
      callsLimit: e.agentCallsPerMonth ?? this.env.AGENT_DEFAULT_CALLS_PER_MONTH,
      budgetLimitMicros: BigInt(e.agentBudgetMicrosPerMonth ?? this.env.AGENT_DEFAULT_BUDGET_MICROS_PER_MONTH),
    };
  }

  /** The rules that need no counters: stop switches, subscription, plan feature and agent type. Throws GuardianDenied. */
  async assertMayRun(businessId: string, agent: { id: string; type: AgentTypeName; enabled: boolean } | null, limits?: TenantLimits): Promise<TenantLimits> {
    const stop = await this.kill.active(businessId, agent?.id);
    if (stop) throw DENIED.stopped(stop.scope);
    const L = limits ?? (await this.limitsFor(businessId));
    // A business that chose a plan and let it lapse runs nothing; one with no plan at all is allowed only while enforcement is off.
    if (L.hasSubscription ? !L.access.hasAccess : this.env.BILLING_ENFORCEMENT_ENABLED && !L.founder) throw DENIED.subscription();
    if (L.features && !L.features.includes('agents')) throw DENIED.feature();
    if (agent) {
      if (!agent.enabled) throw DENIED.disabled();
      const planAgent = AGENT_CATALOG[agent.type].planAgent;
      if (planAgent && L.allowedAgents && !L.allowedAgents.includes(planAgent)) throw DENIED.agentType();
    }
    return L;
  }

  /** Admission of a task (before anything is queued): the rules above, and enough calls and budget left for the planned calls. Nothing is reserved yet. */
  async admit(businessId: string, agents: Array<{ id: string; type: AgentTypeName; enabled: boolean }>, plannedCalls: number): Promise<void> {
    const L = await this.limitsFor(businessId);
    for (const a of agents) await this.assertMayRun(businessId, a, L);
    if (!agents.length) await this.assertMayRun(businessId, null, L);
    const ent = await this.prisma.tenantEntitlement.findUnique({ where: { businessId_periodStart: { businessId, periodStart: L.periodStart } } });
    const used = (ent?.callsUsed ?? 0) + (ent?.callsReserved ?? 0);
    if (used + plannedCalls > L.callsLimit) throw DENIED.calls();
    if ((ent?.budgetUsedMicros ?? 0n) + (ent?.budgetReservedMicros ?? 0n) >= L.budgetLimitMicros) throw DENIED.budget();
  }

  /** The number of agents the plan allows (null = unlimited). */
  async assertCanAddAgent(businessId: string, type: AgentTypeName): Promise<void> {
    const L = await this.limitsFor(businessId);
    if (L.hasSubscription ? !L.access.hasAccess : this.env.BILLING_ENFORCEMENT_ENABLED && !L.founder) throw DENIED.subscription();
    if (L.features && !L.features.includes('agents')) throw DENIED.feature();
    const planAgent = AGENT_CATALOG[type].planAgent;
    if (planAgent && L.allowedAgents && !L.allowedAgents.includes(planAgent)) throw DENIED.agentType();
    if (L.maxAgentInstances !== null) {
      const count = await this.prisma.agent.count({ where: { businessId, enabled: true } });
      if (count >= L.maxAgentInstances) throw DENIED.instances(L.maxAgentInstances);
    }
  }

  // ─── Reservation, settlement, release ───────────────────────────────────

  private async ensureEntitlement(tx: Prisma.TransactionClient, businessId: string, L: TenantLimits) {
    const found = await tx.tenantEntitlement.findUnique({ where: { businessId_periodStart: { businessId, periodStart: L.periodStart } } });
    if (found) return found;
    return tx.tenantEntitlement.create({ data: { businessId, periodStart: L.periodStart, periodEnd: L.periodEnd, source: L.source, planCode: L.planCode, callsLimit: L.callsLimit, budgetLimitMicros: L.budgetLimitMicros } });
  }

  /**
   * Holds one call and its estimated cost, atomically. Repeating it for the same (run, step, attempt) returns the same reservation. Throws GuardianDenied
   * before anything is held when any rule fails.
   */
  async reserve(i: ReserveInput, now = new Date()): Promise<{ reservationId: string; entitlementId: string }> {
    const L = await this.assertMayRun(i.businessId, { id: i.agentId, type: i.agentType, enabled: true });
    return this.prisma.$transaction(async (tx) => {
      await lockTenantQuota(tx, 'agents', i.businessId);
      const again = await tx.usageReservation.findUnique({ where: { runId_stepKey_attempt: { runId: i.runId, stepKey: i.stepKey, attempt: i.attempt } } });
      if (again) return { reservationId: again.id, entitlementId: again.entitlementId };
      const ent = await this.ensureEntitlement(tx, i.businessId, L);
      if (ent.callsLimit !== null && ent.callsUsed + ent.callsReserved + 1 > ent.callsLimit) throw DENIED.calls();
      if (ent.budgetLimitMicros !== null && ent.budgetUsedMicros + ent.budgetReservedMicros + i.estimateMicros > ent.budgetLimitMicros) throw DENIED.budget();

      const policy = await tx.budgetPolicy.findUnique({ where: { businessId: i.businessId } });
      const today = dayKey(now);
      const dayStart = new Date(`${today}T00:00:00.000Z`);
      const [usedToday, heldToday, agentToday, runUsed, runHeld, periodUsed] = await Promise.all([
        tx.usageEvent.aggregate({ where: { businessId: i.businessId, createdAt: { gte: dayStart } }, _sum: { estimatedCostMicros: true } }),
        tx.usageReservation.aggregate({ where: { businessId: i.businessId, status: 'RESERVED', dayKey: today }, _sum: { costMicros: true } }),
        Promise.all([tx.usageEvent.count({ where: { agentId: i.agentId, createdAt: { gte: dayStart } } }), tx.usageReservation.count({ where: { agentId: i.agentId, status: 'RESERVED', dayKey: today } })]),
        tx.usageEvent.aggregate({ where: { runId: i.runId }, _sum: { estimatedCostMicros: true } }),
        tx.usageReservation.aggregate({ where: { runId: i.runId, status: 'RESERVED' }, _sum: { costMicros: true } }),
        tx.usageEvent.aggregate({ where: { businessId: i.businessId, createdAt: { gte: ent.periodStart, lt: ent.periodEnd } }, _sum: { estimatedCostMicros: true } }),
      ]);
      if (agentToday[0] + agentToday[1] + 1 > i.agentMaxCallsPerDay) throw DENIED.agentDaily();
      const perRunCaps = [BigInt(i.agentMaxCostPerRunMicros), ...(policy?.enforce !== false && policy?.perRunCapMicros != null ? [policy.perRunCapMicros] : [])];
      const runTotal = (runUsed._sum.estimatedCostMicros ?? 0n) + (runHeld._sum.costMicros ?? 0n) + i.estimateMicros;
      if (perRunCaps.some((c) => runTotal > c)) throw DENIED.run();
      if (policy && policy.enforce) {
        if (policy.dailyCapMicros != null && (usedToday._sum.estimatedCostMicros ?? 0n) + (heldToday._sum.costMicros ?? 0n) + i.estimateMicros > policy.dailyCapMicros) throw DENIED.daily();
        if (policy.monthlyCapMicros != null && (periodUsed._sum.estimatedCostMicros ?? 0n) + ent.budgetReservedMicros + i.estimateMicros > policy.monthlyCapMicros) throw DENIED.monthly();
      }
      const res = await tx.usageReservation.create({ data: { businessId: i.businessId, agentId: i.agentId, entitlementId: ent.id, runId: i.runId, stepKey: i.stepKey, attempt: i.attempt, calls: 1, costMicros: i.estimateMicros, dayKey: today } });
      await tx.tenantEntitlement.update({ where: { id: ent.id }, data: { callsReserved: { increment: 1 }, budgetReservedMicros: { increment: i.estimateMicros } } });
      return { reservationId: res.id, entitlementId: ent.id };
    }, { timeout: 15_000 });
  }

  /** The call happened (tokens were consumed): the reservation becomes real usage, with the cost estimated from the price table in force. Idempotent. */
  async settle(reservationId: string, u: SettleInput, now = new Date()): Promise<{ estimatedCostMicros: bigint; priced: boolean }> {
    const est = await this.prices.estimate(u.modelId.replace(/^fake:/, ''), { input: u.inputTokens, output: u.outputTokens, cached: u.cachedTokens }, now);
    const micros = BigInt(est.micros);
    const out = await this.prisma.$transaction(async (tx) => {
      const r = await tx.usageReservation.findUnique({ where: { id: reservationId } });
      if (!r) return null;
      await lockTenantQuota(tx, 'agents', r.businessId);
      const fresh = await tx.usageReservation.findUnique({ where: { id: reservationId } });
      if (!fresh || fresh.status !== 'RESERVED') return { done: false as const, r: fresh ?? r };
      await tx.usageEvent.create({ data: { businessId: r.businessId, agentId: r.agentId, runId: r.runId, stepKey: r.stepKey, attempt: r.attempt, modelId: u.modelId, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens ?? null, estimatedCostMicros: micros, priceVersion: est.version, priced: est.priced, currency: est.currency, status: u.status, errorCode: u.errorCode ?? null } });
      await tx.usageReservation.update({ where: { id: r.id }, data: { status: 'SETTLED', settledAt: now } });
      const ent = await tx.tenantEntitlement.update({ where: { id: r.entitlementId }, data: { callsReserved: { decrement: r.calls }, callsUsed: { increment: r.calls }, budgetReservedMicros: { decrement: r.costMicros }, budgetUsedMicros: { increment: micros } } });
      return { done: true as const, r, ent };
    });
    if (out?.done) await this.afterUsage(out.r.businessId, out.ent, out.r.dayKey).catch(() => undefined);
    return { estimatedCostMicros: micros, priced: est.priced };
  }

  /** Nothing was consumed (the provider failed before answering, the task was stopped): the held call and budget go back. A FAILED usage event with no tokens is kept for the history. Idempotent. */
  async release(reservationId: string, errorCode: string, modelId = 'unknown', now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.usageReservation.findUnique({ where: { id: reservationId } });
      if (!r) return;
      await lockTenantQuota(tx, 'agents', r.businessId);
      const fresh = await tx.usageReservation.findUnique({ where: { id: reservationId } });
      if (!fresh || fresh.status !== 'RESERVED') return;
      await tx.usageReservation.update({ where: { id: r.id }, data: { status: 'RELEASED', settledAt: now } });
      await tx.tenantEntitlement.updateMany({ where: { id: r.entitlementId }, data: { callsReserved: { decrement: r.calls }, budgetReservedMicros: { decrement: r.costMicros } } });
      // skipDuplicates: a failed statement inside a transaction would abort it.
      await tx.usageEvent.createMany({ data: [{ businessId: r.businessId, agentId: r.agentId, runId: r.runId, stepKey: r.stepKey, attempt: r.attempt, modelId, estimatedCostMicros: 0n, status: 'FAILED', errorCode, priced: true }], skipDuplicates: true });
    });
  }

  /** Crash recovery: reservations never settled within the TTL (the worker died) are released, so a crash cannot leak quota. */
  async reconcileStale(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.env.AGENT_RESERVATION_TTL_SECONDS * 1000);
    const stale = await this.prisma.usageReservation.findMany({ where: { status: 'RESERVED', createdAt: { lt: cutoff } }, select: { id: true, businessId: true }, take: 200 });
    for (const s of stale) {
      try {
        await this.release(s.id, 'RESERVATION_EXPIRED', 'unknown', now);
        await this.audit.record({ action: 'agents.reservation_expired', businessId: s.businessId, entityType: 'UsageReservation', entityId: s.id });
      } catch (e) {
        // One bad row must not stop the others from being reconciled.
        this.logger.warn(`reservation ${s.id} could not be reconciled: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    return stale.length;
  }

  // ─── Alerts ──────────────────────────────────────────────────────────────

  private async afterUsage(businessId: string, ent: { id: string; budgetLimitMicros: bigint | null; budgetUsedMicros: bigint; callsLimit: number | null; callsUsed: number }, today: string) {
    const policy = await this.prisma.budgetPolicy.findUnique({ where: { businessId } });
    const pct = policy?.alertPercent ?? 80;
    const tell = (key: string, type: string, title: string, data: Record<string, unknown>) => this.notifications.notify({ businessId, permission: 'agents.manage', type, title, data, dedupeKey: key });
    const check = async (label: string, used: bigint, cap: bigint | null | undefined, keyBase: string) => {
      if (!cap || cap <= 0n) return;
      if (used >= cap) await tell(`${keyBase}:100`, 'agents.budget_exhausted', `AI budget reached (${label})`, { label });
      else if (used * 100n >= cap * BigInt(pct)) await tell(`${keyBase}:${pct}`, 'agents.budget_alert', `AI budget is at ${pct}% (${label})`, { label, percent: pct });
    };
    await check('period', ent.budgetUsedMicros, ent.budgetLimitMicros, `agents:period:${ent.id}`);
    if (policy?.dailyCapMicros != null) {
      const agg = await this.prisma.usageEvent.aggregate({ where: { businessId, createdAt: { gte: new Date(`${today}T00:00:00.000Z`) } }, _sum: { estimatedCostMicros: true } });
      await check('daily', agg._sum.estimatedCostMicros ?? 0n, policy.dailyCapMicros, `agents:daily:${businessId}:${today}`);
    }
    if (ent.callsLimit && ent.callsUsed >= ent.callsLimit) await tell(`agents:calls:${ent.id}`, 'agents.quota_exhausted', 'Agent call quota reached', { limit: ent.callsLimit });
  }

  // ─── Views ───────────────────────────────────────────────────────────────

  /** Quotas and budget of the current period for the customer. */
  async summary(businessId: string, now = new Date()) {
    const L = await this.limitsFor(businessId, now);
    const ent = await this.prisma.tenantEntitlement.findUnique({ where: { businessId_periodStart: { businessId, periodStart: L.periodStart } } });
    const policy = await this.prisma.budgetPolicy.findUnique({ where: { businessId } });
    const n = (b: bigint | null | undefined) => (b == null ? null : Number(b));
    return {
      period: { start: L.periodStart, end: L.periodEnd, source: L.source },
      plan: L.planCode,
      access: { state: L.access.state, hasAccess: L.access.hasAccess },
      calls: { used: ent?.callsUsed ?? 0, reserved: ent?.callsReserved ?? 0, limit: L.callsLimit, remaining: Math.max(0, L.callsLimit - (ent?.callsUsed ?? 0) - (ent?.callsReserved ?? 0)) },
      budget: { usedMicros: n(ent?.budgetUsedMicros) ?? 0, reservedMicros: n(ent?.budgetReservedMicros) ?? 0, limitMicros: Number(L.budgetLimitMicros), remainingMicros: Math.max(0, Number(L.budgetLimitMicros) - (n(ent?.budgetUsedMicros) ?? 0) - (n(ent?.budgetReservedMicros) ?? 0)), currency: 'USD', estimated: true },
      policy: policy ? { dailyCapMicros: n(policy.dailyCapMicros), monthlyCapMicros: n(policy.monthlyCapMicros), perRunCapMicros: n(policy.perRunCapMicros), alertPercent: policy.alertPercent, enforce: policy.enforce } : null,
      maxAgentInstances: L.maxAgentInstances,
      stopped: await this.kill.active(businessId),
    };
  }

  /** Estimated cost report by agent and model for a period. Estimates, never invoices. */
  async report(businessId: string | null, from: Date, to: Date) {
    const where = { ...(businessId ? { businessId } : {}), createdAt: { gte: from, lt: to } };
    const [byAgent, byModel, byStatus] = await Promise.all([
      this.prisma.usageEvent.groupBy({ by: ['agentId'], where, _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true }, _count: { _all: true } }),
      this.prisma.usageEvent.groupBy({ by: ['modelId'], where, _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true }, _count: { _all: true } }),
      this.prisma.usageEvent.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const ids = byAgent.map((a) => a.agentId).filter((x): x is string => Boolean(x));
    const agents = ids.length ? await this.prisma.agent.findMany({ where: { id: { in: ids }, ...(businessId ? { businessId } : {}) }, select: { id: true, name: true, type: true } }) : [];
    const row = (r: { _sum: { inputTokens: number | null; outputTokens: number | null; estimatedCostMicros: bigint | null }; _count: { _all: number } }) => ({ calls: r._count._all, inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0, estimatedCostMicros: Number(r._sum.estimatedCostMicros ?? 0n) });
    return {
      from, to, currency: 'USD', estimated: true,
      note: 'Costs are estimates from the versioned price table. They are not an invoice from any provider.',
      byAgent: byAgent.map((a) => ({ agentId: a.agentId, name: agents.find((x) => x.id === a.agentId)?.name ?? null, type: agents.find((x) => x.id === a.agentId)?.type ?? null, ...row(a) })),
      byModel: byModel.map((m) => ({ modelId: m.modelId, ...row(m) })),
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    };
  }
}
