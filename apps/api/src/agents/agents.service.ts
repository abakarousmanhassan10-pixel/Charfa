import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@touma/database';
import { AGENT_CATALOG, AGENT_TYPES, defaultAgentConfig, taskStateOf, validateAgentConfig, type AgentConfig, type AgentTypeName } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RunsQueueService } from '../runs/runs-queue';
import { RunsService, runView } from '../runs/runs.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { AGENT_TEMPLATES, AGENT_TEMPLATE_PREFIX } from './agent-adapters';
import { GuardianDenied } from './agent-errors';
import { AgentGuardian } from './agent-guardian.service';
import { KillSwitchService } from './kill-switch.service';
import { ModelRouter } from './model-router';

const bad = (message: string) => new BadRequestException({ code: 'VALIDATION_ERROR', message });
const conflict = (code: string, message: string) => new ConflictException({ code, message });

export interface TaskInput { template: string; topic?: string; question?: string; channel?: string; agents?: Partial<Record<AgentTypeName, string>>; priority?: number }

/**
 * Agents of a business and their tasks. A task is a run of the existing job engine (queue, retries with backoff, dead letters, idempotency, tenant
 * concurrency limit, crash recovery, human approvals); this service adds what the engine does not know: configured agents, the guardian's admission
 * (CREATED -> QUEUED, or BLOCKED), and the task states of the product.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guardian: AgentGuardian,
    private readonly kill: KillSwitchService,
    private readonly router: ModelRouter,
    private readonly runs: RunsService,
    private readonly queue: RunsQueueService,
    private readonly audit: AuditService,
  ) {}

  // ─── Catalog and agents ──────────────────────────────────────────────────

  async catalog(t: TenantContext) {
    const L = await this.guardian.limitsFor(t.businessId);
    return {
      types: AGENT_TYPES.map((type) => ({ type, label: AGENT_CATALOG[type].label, role: AGENT_CATALOG[type].role, defaults: defaultAgentConfig(type), allowedByPlan: !(L.allowedAgents && AGENT_CATALOG[type].planAgent && !L.allowedAgents.includes(AGENT_CATALOG[type].planAgent!)) })),
      templates: Object.entries(AGENT_TEMPLATES).map(([name, v]) => ({ name, agents: v.kinds, steps: v.steps.map((s) => ({ key: s.key, requiresApproval: s.requiresApproval })) })),
      models: { allowed: this.router.allowedModels(), tiers: { economy: this.router.tierModel('economy'), standard: this.router.tierModel('standard'), advanced: this.router.tierModel('advanced') } },
      plan: { code: L.planCode, features: L.features, maxAgentInstances: L.maxAgentInstances },
    };
  }

  private view(a: { id: string; type: string; name: string; enabled: boolean; config: unknown; createdAt: Date; updatedAt: Date }) {
    return { id: a.id, type: a.type, label: AGENT_CATALOG[a.type as AgentTypeName]?.label ?? a.type, name: a.name, enabled: a.enabled, config: a.config, createdAt: a.createdAt, updatedAt: a.updatedAt };
  }

  async list(t: TenantContext) {
    const rows = await this.prisma.agent.findMany({ where: { businessId: t.businessId }, orderBy: { createdAt: 'asc' } });
    return rows.map((a) => this.view(a));
  }

  private config(type: AgentTypeName, patch: unknown): AgentConfig {
    const merged = { ...defaultAgentConfig(type), ...((patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>) };
    const v = validateAgentConfig(type, merged);
    if (!v.ok) throw bad(v.error);
    if (v.config.model && !this.router.allowedModels().includes(v.config.model)) throw bad('model is not on the server\'s allowed list');
    return v.config;
  }

  async create(t: TenantContext, dto: { type: AgentTypeName; name: string; config?: unknown }) {
    if (!AGENT_TYPES.includes(dto.type)) throw bad('unknown agent type');
    const config = this.config(dto.type, dto.config);
    try { await this.guardian.assertCanAddAgent(t.businessId, dto.type); } catch (e) { if (e instanceof GuardianDenied) throw e.toHttp(); throw e; }
    try {
      const a = await this.prisma.agent.create({ data: { businessId: t.businessId, type: dto.type, name: dto.name, config: config as unknown as Prisma.InputJsonObject, createdById: t.userId } });
      await this.audit.record({ action: 'agents.created', actorId: t.userId, businessId: t.businessId, entityType: 'Agent', entityId: a.id, metadata: { type: dto.type } });
      return this.view(a);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('AGENT_NAME_TAKEN', 'An agent with this name already exists');
      throw e;
    }
  }

  private async find(t: TenantContext, id: string) {
    const a = await this.prisma.agent.findFirst({ where: { id, businessId: t.businessId } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Agent not found' });
    return a;
  }

  async update(t: TenantContext, id: string, dto: { name?: string; config?: unknown }) {
    const a = await this.find(t, id);
    const config = dto.config !== undefined ? this.config(a.type as AgentTypeName, { ...(a.config as object), ...(dto.config as object) }) : undefined;
    try {
      const u = await this.prisma.agent.update({ where: { id: a.id }, data: { ...(dto.name ? { name: dto.name } : {}), ...(config ? { config: config as unknown as Prisma.InputJsonObject } : {}) } });
      await this.audit.record({ action: 'agents.updated', actorId: t.userId, businessId: t.businessId, entityType: 'Agent', entityId: a.id, metadata: { fields: Object.keys(dto) } });
      return this.view(u);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('AGENT_NAME_TAKEN', 'An agent with this name already exists');
      throw e;
    }
  }

  /** Agents are disabled, never deleted: their history (usage, conversations, approvals) stays. Enabling checks the plan's agent limit again. */
  async setEnabled(t: TenantContext, id: string, enabled: boolean) {
    const a = await this.find(t, id);
    if (enabled && !a.enabled) { try { await this.guardian.assertCanAddAgent(t.businessId, a.type as AgentTypeName); } catch (e) { if (e instanceof GuardianDenied) throw e.toHttp(); throw e; } }
    const u = await this.prisma.agent.update({ where: { id: a.id }, data: { enabled } });
    await this.audit.record({ action: enabled ? 'agents.enabled' : 'agents.disabled', actorId: t.userId, businessId: t.businessId, entityType: 'Agent', entityId: a.id });
    return this.view(u);
  }

  // ─── Tasks ───────────────────────────────────────────────────────────────

  private async resolveAgents(t: TenantContext, kinds: AgentTypeName[], chosen: Partial<Record<AgentTypeName, string>> | undefined) {
    const out: Record<string, { id: string; type: AgentTypeName; enabled: boolean }> = {};
    for (const kind of kinds) {
      const id = chosen?.[kind];
      if (id) {
        const a = await this.prisma.agent.findFirst({ where: { id, businessId: t.businessId, type: kind } });
        if (!a) throw bad(`${AGENT_CATALOG[kind].label} not found in this business`);
        out[kind] = { id: a.id, type: kind, enabled: a.enabled };
      } else {
        const all = await this.prisma.agent.findMany({ where: { businessId: t.businessId, type: kind, enabled: true }, select: { id: true } });
        if (all.length === 0) throw conflict('AGENT_MISSING', `Create a ${AGENT_CATALOG[kind].label} first`);
        if (all.length > 1) throw bad(`Several ${AGENT_CATALOG[kind].label} agents exist: choose one`);
        out[kind] = { id: all[0]!.id, type: kind, enabled: true };
      }
    }
    return out;
  }

  /**
   * Creates a task: CREATED -> (guardian admission) -> QUEUED, or BLOCKED. The admission checks the stop switches, the subscription, the plan and the quota
   * left; the same rules are checked again right before every step, so a subscription that expires while the task waits blocks it.
   */
  async createTask(t: TenantContext, dto: TaskInput, idempotencyKey: string) {
    const tpl = AGENT_TEMPLATES[dto.template];
    if (!tpl) throw bad('unknown task template');
    const topic = (dto.topic ?? dto.question ?? '').trim().replace(/\s+/g, ' ');
    // eslint-disable-next-line no-control-regex
    if (topic.length < 1 || topic.length > 200 || /[\u0000-\u001f\u007f]/.test(topic)) throw bad('topic must be 1-200 printable characters');
    const channel = dto.channel ?? 'INSTAGRAM';
    if (!['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN'].includes(channel)) throw bad('unknown channel');
    const resolved = await this.resolveAgents(t, tpl.kinds, dto.agents);
    try { await this.guardian.admit(t.businessId, Object.values(resolved), tpl.steps.filter((s) => s.adapter.startsWith('agent.') && !s.adapter.includes('publish')).length); } catch (e) { if (e instanceof GuardianDenied) throw e.toHttp(); throw e; }
    const agents = Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.id]));
    const input = { topic, channel, agents } as Record<string, unknown>;
    const hash = createHash('sha256').update(JSON.stringify({ template: dto.template, input })).digest('hex');
    const { run, replayed } = await this.runs.createFromSpec(t, { template: dto.template, templateVersion: 1, input, steps: tpl.steps, initialStatus: 'CREATED', priority: Math.min(9, Math.max(3, Math.trunc(dto.priority ?? 5))) }, idempotencyKey, hash);
    if (!replayed) await this.admit(t, run.id);
    return { replayed, task: await this.task(t, run.id) };
  }

  /** CREATED -> QUEUED (or BLOCKED when a switch was turned on meanwhile). */
  private async admit(t: TenantContext, runId: string) {
    const stop = await this.kill.active(t.businessId);
    if (stop) { await this.runs.blockRun({ id: runId, businessId: t.businessId }, null, 'AGENTS_STOPPED', `Stopped by an administrator (${stop.scope})`); return; }
    const res = await this.prisma.agentRun.updateMany({ where: { id: runId, businessId: t.businessId, status: 'CREATED' }, data: { status: 'PENDING' } });
    if (!res.count) return;
    await this.prisma.agentRunEvent.create({ data: { runId, businessId: t.businessId, type: 'task.queued', actorId: t.userId } });
    await this.queue.wake(runId);
  }

  async task(t: TenantContext, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, businessId: t.businessId, template: { startsWith: AGENT_TEMPLATE_PREFIX } }, include: { steps: true } });
    if (!run) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Task not found' });
    const [approvals, usage] = await Promise.all([
      this.prisma.agentApproval.findMany({ where: { runId: id, businessId: t.businessId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, channel: true, contentId: true } }),
      this.prisma.usageEvent.aggregate({ where: { runId: id, businessId: t.businessId }, _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true }, _count: { _all: true } }),
    ]);
    const v = runView(run);
    return { id: v.id, template: v.template, state: taskStateOf(run.status), status: run.status, priority: run.priority, errorCode: run.errorCode, createdAt: run.createdAt, completedAt: run.completedAt, steps: run.steps.map((s) => ({ key: s.key, adapter: s.adapter, status: s.status, requiresApproval: s.requiresApproval, attempts: s.attempts, errorCode: s.errorCode, output: s.output })), approvals, usage: { calls: usage._count._all, tokens: (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0), estimatedCostMicros: Number(usage._sum.estimatedCostMicros ?? 0n), estimated: true } };
  }

  async listTasks(t: TenantContext, q: { state?: string; page: number; pageSize: number }) {
    const statusFor: Record<string, string[]> = { CREATED: ['CREATED'], QUEUED: ['PENDING', 'PAUSED'], RUNNING: ['RUNNING'], WAITING_APPROVAL: ['WAITING_APPROVAL'], COMPLETED: ['COMPLETED'], FAILED: ['FAILED'], CANCELED: ['CANCELLED'], BLOCKED: ['BLOCKED'] };
    const where: Prisma.AgentRunWhereInput = { businessId: t.businessId, template: { startsWith: AGENT_TEMPLATE_PREFIX }, ...(q.state && statusFor[q.state] ? { status: { in: statusFor[q.state] as never } } : {}) };
    const [total, rows] = await Promise.all([this.prisma.agentRun.count({ where }), this.prisma.agentRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, template: true, status: true, errorCode: true, createdAt: true, completedAt: true, input: true } })]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => ({ id: r.id, template: r.template, state: taskStateOf(r.status), errorCode: r.errorCode, topic: (r.input as { topic?: string }).topic ?? null, createdAt: r.createdAt, completedAt: r.completedAt })) };
  }

  async cancel(t: TenantContext, id: string) {
    await this.task(t, id);
    await this.runs.cancel(t, id);
    return this.task(t, id);
  }

  /** A blocked or failed task is retried only when the guardian would admit it now (the cause was fixed). */
  async retry(t: TenantContext, id: string) {
    const task = await this.task(t, id);
    const run = await this.prisma.agentRun.findFirstOrThrow({ where: { id, businessId: t.businessId }, select: { input: true } });
    const ids = Object.values(((run.input as { agents?: Record<string, string> }).agents ?? {}));
    const agents = await this.prisma.agent.findMany({ where: { id: { in: ids }, businessId: t.businessId }, select: { id: true, type: true, enabled: true } });
    try { await this.guardian.admit(t.businessId, agents.map((a) => ({ id: a.id, type: a.type as AgentTypeName, enabled: a.enabled })), 1); } catch (e) { if (e instanceof GuardianDenied) throw e.toHttp(); throw e; }
    void task;
    await this.runs.retry(t, id);
    return this.task(t, id);
  }

  // ─── Budget ──────────────────────────────────────────────────────────────

  async budget(t: TenantContext) {
    const p = await this.prisma.budgetPolicy.findUnique({ where: { businessId: t.businessId } });
    const n = (b: bigint | null | undefined) => (b == null ? null : Number(b));
    return p ? { dailyCapMicros: n(p.dailyCapMicros), monthlyCapMicros: n(p.monthlyCapMicros), perRunCapMicros: n(p.perRunCapMicros), alertPercent: p.alertPercent, enforce: p.enforce } : { dailyCapMicros: null, monthlyCapMicros: null, perRunCapMicros: null, alertPercent: 80, enforce: true };
  }

  async setBudget(t: TenantContext, dto: { dailyCapMicros?: number | null; monthlyCapMicros?: number | null; perRunCapMicros?: number | null; alertPercent?: number; enforce?: boolean }) {
    const big = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : BigInt(v));
    const data = { dailyCapMicros: big(dto.dailyCapMicros), monthlyCapMicros: big(dto.monthlyCapMicros), perRunCapMicros: big(dto.perRunCapMicros), alertPercent: dto.alertPercent, enforce: dto.enforce, updatedById: t.userId };
    await this.prisma.budgetPolicy.upsert({ where: { businessId: t.businessId }, create: { businessId: t.businessId, ...data }, update: data });
    await this.audit.record({ action: 'agents.budget_changed', actorId: t.userId, businessId: t.businessId, entityType: 'BudgetPolicy', metadata: { fields: Object.keys(dto) } });
    return this.budget(t);
  }
}
