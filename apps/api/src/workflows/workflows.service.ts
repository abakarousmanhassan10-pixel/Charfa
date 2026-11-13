import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { RUN_ADAPTER_REGISTRY, adapterIsExternal, type RunAdapterRegistry } from '../runs/run-adapters';
import { RunsService, runView, type Actor, type RunSpec } from '../runs/runs.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { Inject } from '@nestjs/common';
import { evaluateCondition } from './workflow-conditions';
import { WORKFLOW_EVENT_TYPES, parseExecutionInput, parseWorkflowDefinition, sanitizeEventPayload, type WorkflowDoc, type WorkflowEventType } from './workflow-definition';

const EVENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
/** An event raised by a workflow that itself started from an event stops propagating after this many hops (no endless loops). */
export const MAX_EVENT_CHAIN = 3;

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonical = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

type Def = Awaited<ReturnType<PrismaService['workflowDefinition']['findFirstOrThrow']>>;

function definitionView(d: Def, extra: Record<string, unknown> = {}) {
  return { id: d.id, name: d.name, description: d.description, currentVersion: d.currentVersion, isActive: d.isActive, nextRunAt: d.nextRunAt, createdAt: d.createdAt, updatedAt: d.updatedAt, ...extra };
}

/**
 * Workflow definitions with immutable versions, and the three ways to start an execution: manually, on a schedule, or on
 * an internal event. An execution is an AgentRun (see RunsService), which snapshots the version it started from, so editing
 * a workflow never changes a run in progress. Starting always goes through RunsService.createFromSpec: idempotency, the
 * tenant's concurrency limit, the approval invariant for outward steps and the audit trail are shared, not duplicated.
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger('Workflows');

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RunsService,
    private readonly audit: AuditService,
    @Inject(RUN_ADAPTER_REGISTRY) private readonly registry: RunAdapterRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {
    // Internal events: a workflow that completes or fails can start others (bounded chain).
    this.runs.setFinishedListener((r) => this.onRunFinished(r));
  }

  private parse(raw: unknown): WorkflowDoc {
    return parseWorkflowDefinition(raw, { isExternal: adapterIsExternal(this.registry), minScheduleMinutes: this.env.WORKFLOWS_MIN_SCHEDULE_MINUTES });
  }

  private async findDef(tenant: Pick<Actor, 'businessId'>, id: string) {
    const d = await this.prisma.workflowDefinition.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!d) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' });
    return d;
  }

  private async versionDoc(d: { id: string; businessId: string; currentVersion: number }, version = d.currentVersion): Promise<WorkflowDoc> {
    const v = await this.prisma.workflowVersion.findFirst({ where: { workflowId: d.id, businessId: d.businessId, version } });
    if (!v) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow version not found' });
    return v.definition as unknown as WorkflowDoc;
  }

  private nextRun(doc: WorkflowDoc, from = new Date()): Date | null {
    const t = doc.triggers.find((x) => x.type === 'schedule');
    return t?.everyMinutes ? new Date(from.getTime() + t.everyMinutes * 60_000) : null;
  }

  // ─── Definitions ───────────────────────────────────────────────────────────────

  async create(tenant: TenantContext, dto: { name: string; description?: string; definition: unknown }) {
    const doc = this.parse(dto.definition);
    if ((await this.prisma.workflowDefinition.count({ where: { businessId: tenant.businessId } })) >= this.env.WORKFLOWS_MAX_PER_BUSINESS) {
      throw new BadRequestException({ code: 'WORKFLOW_LIMIT_REACHED', message: `At most ${this.env.WORKFLOWS_MAX_PER_BUSINESS} workflows per business` });
    }
    try {
      const d = await this.prisma.workflowDefinition.create({
        data: {
          businessId: tenant.businessId,
          name: dto.name,
          description: dto.description ?? doc.description,
          currentVersion: 1,
          createdById: tenant.userId,
          versions: { create: [{ businessId: tenant.businessId, version: 1, definition: doc as unknown as Prisma.InputJsonObject, createdById: tenant.userId }] },
        },
      });
      await this.audit.record({ action: 'workflow.created', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'WorkflowDefinition', entityId: d.id, metadata: { steps: doc.steps.length } });
      return definitionView(d, { definition: doc });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException({ code: 'WORKFLOW_NAME_TAKEN', message: 'A workflow with this name already exists' });
      throw err;
    }
  }

  /** Saving never edits a version: it adds a new one. Executions already started keep the version they began with. */
  async update(tenant: TenantContext, id: string, dto: { definition: unknown; description?: string }) {
    const d = await this.findDef(tenant, id);
    const doc = this.parse(dto.definition);
    if (d.currentVersion >= this.env.WORKFLOWS_MAX_VERSIONS) throw new BadRequestException({ code: 'WORKFLOW_VERSION_LIMIT', message: `A workflow can have at most ${this.env.WORKFLOWS_MAX_VERSIONS} versions` });
    const version = d.currentVersion + 1;
    try {
      const res = await this.prisma.$transaction(async (tx) => {
        // Compare-and-set on the version number: two simultaneous saves cannot both become version N+1.
        const bumped = await tx.workflowDefinition.updateMany({
          where: { id: d.id, currentVersion: d.currentVersion },
          data: { currentVersion: version, ...(dto.description !== undefined ? { description: dto.description } : {}), nextRunAt: d.isActive ? this.nextRun(doc) : null },
        });
        if (!bumped.count) throw new ConflictException({ code: 'WORKFLOW_CHANGED', message: 'The workflow changed meanwhile: reload and try again' });
        await tx.workflowVersion.create({ data: { workflowId: d.id, businessId: tenant.businessId, version, definition: doc as unknown as Prisma.InputJsonObject, createdById: tenant.userId } });
        return tx.workflowDefinition.findFirstOrThrow({ where: { id: d.id } });
      });
      await this.audit.record({ action: 'workflow.updated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'WorkflowDefinition', entityId: d.id, metadata: { version } });
      return definitionView(res, { definition: doc });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException({ code: 'WORKFLOW_CHANGED', message: 'The workflow changed meanwhile: reload and try again' });
      throw err;
    }
  }

  async list(tenant: TenantContext, q: PageQueryDto) {
    const where: Prisma.WorkflowDefinitionWhereInput = { businessId: tenant.businessId, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workflowDefinition.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.workflowDefinition.count({ where }),
    ]);
    return toPage(items.map((d) => definitionView(d)), total, q);
  }

  async get(tenant: TenantContext, id: string) {
    const d = await this.findDef(tenant, id);
    const versions = await this.prisma.workflowVersion.findMany({ where: { workflowId: d.id, businessId: tenant.businessId }, orderBy: { version: 'desc' }, select: { version: true, createdAt: true, createdById: true } });
    return definitionView(d, { definition: await this.versionDoc(d), versions });
  }

  async getVersion(tenant: TenantContext, id: string, version: number) {
    const d = await this.findDef(tenant, id);
    return { version, definition: await this.versionDoc(d, version) };
  }

  async setActive(tenant: TenantContext, id: string, active: boolean) {
    const d = await this.findDef(tenant, id);
    const doc = await this.versionDoc(d);
    const res = await this.prisma.workflowDefinition.updateMany({
      where: { id: d.id, businessId: tenant.businessId },
      data: { isActive: active, activatedById: active ? tenant.userId : null, nextRunAt: active ? this.nextRun(doc) : null },
    });
    if (!res.count) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' });
    await this.audit.record({ action: active ? 'workflow.activated' : 'workflow.deactivated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'WorkflowDefinition', entityId: d.id });
    return this.get(tenant, id);
  }

  // ─── Starting executions ───────────────────────────────────────────────────────

  private spec(d: { id: string; name: string; currentVersion: number }, doc: WorkflowDoc, input: Record<string, unknown>, triggerType: 'manual' | 'schedule' | 'event', triggerData: Record<string, unknown> | null): RunSpec {
    return {
      template: `workflow:${d.name}`.slice(0, 80),
      templateVersion: d.currentVersion,
      input,
      workflowId: d.id,
      workflowVersion: d.currentVersion,
      triggerType,
      triggerData,
      steps: doc.steps.map((s) => ({ key: s.key, adapter: s.adapter, dependsOn: s.dependsOn, requiresApproval: s.requiresApproval, condition: s.condition, maxAttempts: s.retry?.maxAttempts, backoffMs: s.retry?.backoffMs })),
    };
  }

  /** Manual trigger. The input is checked against the workflow's input spec; the same Idempotency-Key never starts two executions. */
  async start(tenant: TenantContext, id: string, input: unknown, idempotencyKey: string) {
    const d = await this.findDef(tenant, id);
    if (!d.isActive) throw new ConflictException({ code: 'WORKFLOW_INACTIVE', message: 'Activate the workflow before starting it' });
    const doc = await this.versionDoc(d);
    if (!doc.triggers.some((t) => t.type === 'manual')) throw new ConflictException({ code: 'TRIGGER_NOT_ALLOWED', message: 'This workflow has no manual trigger' });
    const merged = parseExecutionInput(doc, { ...doc.defaultInput, ...((input as Record<string, unknown>) ?? {}) });
    return this.runs.createFromSpec(tenant, this.spec(d, doc, merged, 'manual', null), idempotencyKey, sha({ w: d.id, v: d.currentVersion, i: canonical(merged) }));
  }

  /** Scheduled trigger, called by the worker's tick. Each due schedule is claimed with one conditional UPDATE, then started with a key that names the slot. */
  async runDueSchedules(now = new Date()): Promise<{ started: number; skipped: number }> {
    let started = 0;
    let skipped = 0;
    const due = await this.prisma.workflowDefinition.findMany({ where: { isActive: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: 50 });
    for (const d of due) {
      const slot = d.nextRunAt!;
      const doc = await this.versionDoc(d).catch(() => null);
      const every = doc?.triggers.find((t) => t.type === 'schedule')?.everyMinutes;
      // Claim the slot first: only one worker advances nextRunAt, so a slot starts at most once. Missed slots are not replayed.
      const claim = await this.prisma.workflowDefinition.updateMany({ where: { id: d.id, isActive: true, nextRunAt: slot }, data: { nextRunAt: every ? new Date(now.getTime() + every * 60_000) : null } });
      if (!claim.count) continue;
      if (!doc || !every || !d.activatedById) {
        skipped++;
        continue;
      }
      try {
        const input = parseExecutionInput(doc, doc.defaultInput);
        const actor: Actor = { businessId: d.businessId, userId: d.activatedById };
        const key = `sched:${d.id}:${slot.toISOString()}`;
        const res = await this.runs.createFromSpec(actor, this.spec(d, doc, input, 'schedule', null), key, sha({ w: d.id, v: d.currentVersion, slot: slot.toISOString() }));
        if (!res.replayed) started++;
      } catch (err) {
        skipped++;
        const code = (err as { response?: { code?: string } }).response?.code ?? 'ERROR';
        await this.audit.record({ action: 'workflow.schedule_skipped', businessId: d.businessId, entityType: 'WorkflowDefinition', entityId: d.id, metadata: { code } });
      }
    }
    return { started, skipped };
  }

  /**
   * Internal event trigger. Only TOUMA's own code calls this (there is no public endpoint); the event type is from a fixed
   * list, the payload is reduced to a few short scalars, and the same eventId never starts the same workflow twice.
   */
  async emit(businessId: string, type: WorkflowEventType, eventId: string, rawPayload: unknown = {}): Promise<{ started: number; duplicates: number; skipped: number }> {
    const out = { started: 0, duplicates: 0, skipped: 0 };
    if (!this.env.WORKFLOWS_ENABLED || !this.env.ORCHESTRATOR_ENABLED) return out;
    if (!(WORKFLOW_EVENT_TYPES as readonly string[]).includes(type) || !EVENT_ID.test(eventId)) throw new BadRequestException({ code: 'INVALID_EVENT', message: 'Unknown event type or invalid event id' });
    const payload = sanitizeEventPayload(rawPayload);
    const chain = typeof payload.chain === 'number' ? payload.chain : 0;
    const defs = await this.prisma.workflowDefinition.findMany({ where: { businessId, isActive: true }, take: 100 });
    for (const d of defs) {
      const doc = await this.versionDoc(d).catch(() => null);
      const trigger = doc?.triggers.find((t) => t.type === 'event' && t.event === type);
      if (!doc || !trigger || !d.activatedById) continue;
      // Loop guards: a workflow never reacts to its own result, and a chain of event-started runs stops after MAX_EVENT_CHAIN hops.
      if (payload.workflowId === d.id || chain >= MAX_EVENT_CHAIN) {
        out.skipped++;
        continue;
      }
      if (trigger.condition && !evaluateCondition(trigger.condition, { input: {}, trigger: payload, steps: {} })) {
        out.skipped++;
        continue;
      }
      try {
        const input = parseExecutionInput(doc, doc.defaultInput);
        const res = await this.runs.createFromSpec({ businessId, userId: d.activatedById }, this.spec(d, doc, input, 'event', payload), `evt:${d.id}:${eventId}`, sha({ w: d.id, v: d.currentVersion, e: type, p: canonical(payload) }));
        if (res.replayed) out.duplicates++;
        else out.started++;
      } catch (err) {
        const code = (err as { response?: { code?: string } }).response?.code;
        if (code === 'IDEMPOTENCY_KEY_REUSED') out.duplicates++;
        else {
          out.skipped++;
          await this.audit.record({ action: 'workflow.event_skipped', businessId, entityType: 'WorkflowDefinition', entityId: d.id, metadata: { code: code ?? 'ERROR', event: type } });
        }
      }
    }
    return out;
  }

  private async onRunFinished(r: { id: string; businessId: string; workflowId: string; status: 'COMPLETED' | 'FAILED'; errorCode: string | null }) {
    if (!this.env.WORKFLOWS_ENABLED) return;
    const run = await this.prisma.agentRun.findUnique({ where: { id: r.id }, select: { triggerData: true } });
    const parentChain = typeof (run?.triggerData as { chain?: unknown } | null)?.chain === 'number' ? ((run!.triggerData as { chain: number }).chain) : 0;
    await this.emit(r.businessId, r.status === 'COMPLETED' ? 'workflow.execution.completed' : 'workflow.execution.failed', `run-${r.id}-${r.status.toLowerCase()}`, { workflowId: r.workflowId, runId: r.id, errorCode: r.errorCode ?? '', chain: parentChain + 1 });
  }

  /** Executions of one workflow (the list used by the UI), newest first. */
  async executions(tenant: TenantContext, id: string, q: PageQueryDto) {
    const d = await this.findDef(tenant, id);
    const where: Prisma.AgentRunWhereInput = { businessId: tenant.businessId, workflowId: d.id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentRun.findMany({ where, orderBy: { createdAt: 'desc' }, include: { steps: true }, ...pageArgs(q) }),
      this.prisma.agentRun.count({ where }),
    ]);
    return toPage(items.map(runView), total, q);
  }
}
