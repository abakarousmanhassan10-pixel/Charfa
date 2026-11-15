import { BadRequestException, Injectable } from '@nestjs/common';
import { taskStateOf } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from '../runs/runs.service';
import { AGENT_TEMPLATE_PREFIX } from './agent-adapters';
import { AgentGuardian } from './agent-guardian.service';
import { KillSwitchService, type ControlScopeName } from './kill-switch.service';
import { ModelRouter } from './model-router';
import { PricesService } from './prices.service';

export interface AdminFilter { businessId?: string; from: Date; to: Date }

/** Platform-wide view and controls of the agents (admin control center). Every figure is an estimate or simulated: nothing here is billed or published. */
@Injectable()
export class AgentsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kill: KillSwitchService,
    private readonly guardian: AgentGuardian,
    private readonly prices: PricesService,
    private readonly router: ModelRouter,
    private readonly runs: RunsService,
  ) {}

  async overview(f: AdminFilter) {
    const biz = f.businessId ? { businessId: f.businessId } : {};
    const runWhere = { ...biz, template: { startsWith: AGENT_TEMPLATE_PREFIX }, createdAt: { gte: f.from, lt: f.to } };
    const [byStatus, agents, subs, approvalsWaiting, controls, usage, incidents, customers] = await Promise.all([
      this.prisma.agentRun.groupBy({ by: ['status'], where: runWhere, _count: { _all: true } }),
      this.prisma.agent.groupBy({ by: ['type', 'enabled'], where: biz, _count: { _all: true } }),
      this.prisma.subscription.groupBy({ by: ['status'], where: f.businessId ? { businessId: f.businessId } : {}, _count: { _all: true } }),
      this.prisma.agentApproval.count({ where: { ...biz, status: 'PENDING' } }),
      this.kill.list(),
      this.guardian.report(f.businessId ?? null, f.from, f.to),
      this.prisma.auditLog.findMany({ where: { ...biz, createdAt: { gte: f.from, lt: f.to }, action: { startsWith: 'agents.' } }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, action: true, businessId: true, actorId: true, createdAt: true, metadata: true } }),
      this.prisma.agent.findMany({ where: biz, distinct: ['businessId'], select: { business: { select: { id: true, name: true } } } }),
    ]);
    const tasks: Record<string, number> = {};
    for (const r of byStatus) tasks[taskStateOf(r.status)] = (tasks[taskStateOf(r.status)] ?? 0) + r._count._all;
    const alerts = [
      ...(controls.length ? [{ kind: 'STOP_ACTIVE', count: controls.length }] : []),
      ...((tasks.FAILED ?? 0) > 0 ? [{ kind: 'FAILED_TASKS', count: tasks.FAILED }] : []),
      ...((tasks.BLOCKED ?? 0) > 0 ? [{ kind: 'BLOCKED_TASKS', count: tasks.BLOCKED }] : []),
    ];
    return {
      period: { from: f.from, to: f.to }, simulated: true,
      customers: customers.map((c) => c.business), simulatedSubscriptions: subs.map((s) => ({ status: s.status, count: s._count._all })),
      agents: agents.map((a) => ({ type: a.type, enabled: a.enabled, count: a._count._all })),
      tasks, approvalsWaiting, usage, controls, alerts, events: incidents,
    };
  }

  /** Tasks and approvals of one business, for support (read only). */
  async tasks(businessId: string, state?: string) {
    const rows = await this.prisma.agentRun.findMany({ where: { businessId, template: { startsWith: AGENT_TEMPLATE_PREFIX } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, template: true, status: true, errorCode: true, createdAt: true } });
    return rows.map((r) => ({ ...r, state: taskStateOf(r.status) })).filter((r) => !state || r.state === state);
  }

  controls() { return this.kill.list(); }

  /**
   * Stop (or resume) all agents, one business or one agent. `cancelPending` additionally moves the waiting tasks of the scope to BLOCKED, so nothing stays
   * queued; blocked tasks are never deleted and can be retried after the resume.
   */
  async stop(scope: ControlScopeName, scopeId: string, stopped: boolean, reason: string | null, actorId: string, cancelPending = false) {
    if (scope !== 'GLOBAL' && !scopeId) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'scopeId required' });
    const row = await this.kill.set(scope, scopeId, stopped, reason, actorId);
    let blocked = 0;
    if (stopped && cancelPending) {
      const where = { template: { startsWith: AGENT_TEMPLATE_PREFIX }, status: { in: ['CREATED', 'PENDING', 'PAUSED'] as never }, ...(scope === 'TENANT' ? { businessId: scopeId } : {}) };
      const runs = await this.prisma.agentRun.findMany({ where, select: { id: true, businessId: true, input: true } });
      for (const r of runs) {
        if (scope === 'AGENT' && !Object.values(((r.input as { agents?: Record<string, string> }).agents ?? {})).includes(scopeId)) continue;
        await this.runs.blockRun(r, null, 'AGENTS_STOPPED', `Stopped by an administrator (${scope})`);
        blocked++;
      }
    }
    return { control: row, blocked };
  }

  async prices_() {
    return { prices: await this.prisma.modelPrice.findMany({ orderBy: [{ modelId: 'asc' }, { version: 'desc' }] }) };
  }
  addPrice(modelId: string, p: { inputPerMillionMicros: number; outputPerMillionMicros: number; cachedInputPerMillionMicros?: number | null }, actorId: string) { return this.prices.addVersion(modelId, p, actorId); }

  /** Models the router can use. Names come from configuration only; they are NOT verified against the provider (done at the future real configuration). */
  models() {
    return { verified: false, note: 'Model names come from configuration. They are not verified: check them against the models your account can access before enabling the real provider.', allowed: this.router.allowedModels(), tiers: { economy: this.router.tierModel('economy'), standard: this.router.tierModel('standard'), advanced: this.router.tierModel('advanced') } };
  }
}
