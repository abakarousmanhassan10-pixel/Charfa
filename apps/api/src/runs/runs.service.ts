import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type AgentRun, type AgentRunStatus, type AgentRunStep } from '@touma/database';
import { roleHasPermission } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { lockTenantQuota, quotaExceeded } from '../common/tenant-quota';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { RUN_ADAPTER_REGISTRY, RunStepError, type RunAdapterRegistry } from './run-adapters';
import { RUN_TEMPLATES, assertPlan, hashRequest } from './run-templates';
import { RunsQueueService } from './runs-queue';
import { evaluateCondition, type Condition, type ConditionContext } from '../workflows/workflow-conditions';

const ACTIVE: AgentRunStatus[] = ['PENDING', 'RUNNING', 'WAITING_APPROVAL'];
/** Runs that hold a slot of the tenant's concurrency limit: paused runs still count. */
const COUNTED: AgentRunStatus[] = [...ACTIVE, 'PAUSED'];
const TERMINAL: AgentRunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
const DONE_STEP = ['COMPLETED', 'SKIPPED'];

/** Who a run belongs to: a request's tenant, or the user a schedule or an event runs as. */
export type Actor = Pick<TenantContext, 'businessId' | 'userId'>;

export interface PlanStep {
  key: string;
  adapter: string;
  dependsOn: string[];
  requiresApproval: boolean;
  condition?: Condition;
  maxAttempts?: number;
  backoffMs?: number;
}

export interface RunSpec {
  template: string;
  templateVersion: number;
  input: Record<string, unknown>;
  steps: PlanStep[];
  workflowId?: string;
  workflowVersion?: number;
  triggerType?: 'manual' | 'schedule' | 'event';
  triggerData?: Record<string, unknown> | null;
}

export type RunFinished = (run: { id: string; businessId: string; workflowId: string; createdById: string | null; status: 'COMPLETED' | 'FAILED'; errorCode: string | null }) => Promise<void> | void;
const MAX_ADVANCE_ROUNDS = 20;

type RunWithSteps = AgentRun & { steps: AgentRunStep[] };

export function runView(run: RunWithSteps) {
  return {
    id: run.id,
    template: run.template,
    templateVersion: run.templateVersion,
    status: run.status,
    input: run.input,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    triggerType: run.triggerType,
    deadLetteredAt: run.deadLetteredAt,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    steps: [...run.steps]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key))
      .map((s) => ({
        key: s.key,
        adapter: s.adapter,
        dependsOn: s.dependsOn,
        requiresApproval: s.requiresApproval,
        status: s.status,
        attempts: s.attempts,
        maxAttempts: s.maxAttempts,
        backoffMs: s.backoffMs,
        hasCondition: s.condition !== null,
        nextAttemptAt: s.nextAttemptAt,
        output: s.output,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
        approvalDecision: s.approvalDecision,
        decidedById: s.decidedById,
        decidedAt: s.decidedAt,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      })),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new RunStepError('STEP_TIMEOUT', 'The step did not finish in time', true)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Executes agent runs: a small plan of steps with dependencies, persisted in PostgreSQL and advanced by BullMQ workers.
 *
 * Guarantees (each covered by tests):
 *  - a step is claimed with ONE conditional UPDATE (PENDING -> RUNNING), so two workers, two jobs or a replayed job can
 *    never execute the same step twice;
 *  - a step that acts outside TOUMA only runs after an explicit human approval, is never retried automatically, and
 *    after a crash is failed with an unknown outcome instead of being run again;
 *  - the requesting user must still be an active member allowed to use AI when each step runs;
 *  - events and errors carry codes and counters only: never the business input, never provider messages.
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger('Runs');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: RunsQueueService,
    @Inject(RUN_ADAPTER_REGISTRY) private readonly registry: RunAdapterRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  // ─── API side ──────────────────────────────────────────────────────────────────

  async create(tenant: TenantContext, dto: { template: string; input: unknown }, idempotencyKey: string): Promise<{ run: ReturnType<typeof runView>; replayed: boolean }> {
    const template = RUN_TEMPLATES[dto.template];
    if (!template) throw new BadRequestException({ code: 'UNKNOWN_TEMPLATE', message: 'Unknown run template' });
    assertPlan(template, (a) => this.registry.get(a)?.external);
    const input = template.parseInput(dto.input);
    return this.createFromSpec(tenant, { template: template.name, templateVersion: template.version, input, steps: template.steps }, idempotencyKey, hashRequest(template, input));
  }

  /**
   * Creates a run from a plan (a built-in template or a workflow version) with idempotency, the tenant's concurrency
   * limit and the creation audit. Every caller (an API request, a schedule, an event) goes through here.
   */
  async createFromSpec(actor: Actor, spec: RunSpec, idempotencyKey: string, requestHash: string): Promise<{ run: ReturnType<typeof runView>; replayed: boolean }> {
    for (const st of spec.steps) {
      // Defence in depth: whatever built the plan, an outward step must require approval.
      if (this.registry.get(st.adapter)?.external && !st.requiresApproval) throw new BadRequestException({ code: 'APPROVAL_REQUIRED', message: 'A step that acts outside TOUMA must require approval' });
    }
    const replay = async () => {
      const existing = await this.prisma.agentRun.findUnique({ where: { businessId_idempotencyKey: { businessId: actor.businessId, idempotencyKey } }, include: { steps: true } });
      if (!existing) return null;
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request' });
      }
      return { run: runView(existing), replayed: true };
    };
    const replayed = await replay();
    if (replayed) return replayed;

    let created: RunWithSteps;
    try {
      // The limit is checked and the run inserted under one tenant lock: concurrent submissions cannot exceed it.
      created = await this.prisma.$transaction(async (tx) => {
      await lockTenantQuota(tx, 'runs', actor.businessId);
      const active = await tx.agentRun.count({ where: { businessId: actor.businessId, status: { in: COUNTED } } });
      if (active >= this.env.ORCHESTRATOR_MAX_ACTIVE_RUNS_PER_BUSINESS) throw quotaExceeded('RUN_LIMIT_REACHED', `At most ${this.env.ORCHESTRATOR_MAX_ACTIVE_RUNS_PER_BUSINESS} runs can be in progress at once`);
      return tx.agentRun.create({
        data: {
          businessId: actor.businessId,
          createdById: actor.userId,
          template: spec.template,
          templateVersion: spec.templateVersion,
          idempotencyKey,
          requestHash,
          input: spec.input as Prisma.InputJsonObject,
          workflowId: spec.workflowId,
          workflowVersion: spec.workflowVersion,
          triggerType: spec.triggerType,
          triggerData: spec.triggerData ? (spec.triggerData as Prisma.InputJsonObject) : undefined,
          steps: {
            create: spec.steps.map((s) => ({
              businessId: actor.businessId,
              key: s.key,
              adapter: s.adapter,
              dependsOn: s.dependsOn,
              requiresApproval: s.requiresApproval,
              condition: s.condition ? (s.condition as unknown as Prisma.InputJsonObject) : undefined,
              maxAttempts: s.maxAttempts ?? this.env.ORCHESTRATOR_STEP_MAX_ATTEMPTS,
              backoffMs: s.backoffMs,
            })),
          },
          events: { create: [{ businessId: actor.businessId, type: 'run.created', actorId: actor.userId, detail: { template: spec.template, version: spec.templateVersion, steps: spec.steps.length, ...(spec.triggerType ? { trigger: spec.triggerType } : {}) } }] },
        },
        include: { steps: true },
      });
      });
    } catch (err) {
      // Two identical requests raced: the unique key picked a winner; answer with it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await replay();
        if (again) return again;
      }
      throw err;
    }
    await this.audit.record({ action: 'run.created', actorId: actor.userId, businessId: actor.businessId, entityType: 'AgentRun', entityId: created.id, metadata: { template: spec.template, ...(spec.workflowId ? { workflowId: spec.workflowId, trigger: spec.triggerType } : {}) } });
    await this.queue.wake(created.id);
    return { run: runView(created), replayed: false };
  }

  async list(tenant: TenantContext, q: PageQueryDto & { status?: AgentRunStatus; workflowId?: string; deadLettered?: boolean }) {
    const where: Prisma.AgentRunWhereInput = {
      businessId: tenant.businessId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.workflowId ? { workflowId: q.workflowId } : {}),
      ...(q.deadLettered ? { status: 'FAILED', deadLetteredAt: { not: null } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentRun.findMany({ where, orderBy: { createdAt: 'desc' }, include: { steps: true }, ...pageArgs(q) }),
      this.prisma.agentRun.count({ where }),
    ]);
    return toPage(items.map(runView), total, q);
  }

  async get(tenant: TenantContext, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, businessId: tenant.businessId }, include: { steps: true } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    return runView(run);
  }

  async events(tenant: TenantContext, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, businessId: tenant.businessId }, select: { id: true } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    const rows = await this.prisma.agentRunEvent.findMany({ where: { runId: id, businessId: tenant.businessId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
    return rows.map((e) => ({ id: e.id, type: e.type, stepKey: e.stepKey, actorId: e.actorId, detail: e.detail, createdAt: e.createdAt }));
  }

  /** Approving releases a step that was waiting for a human. The decision is recorded once: a second approval is a 409. */
  async approve(tenant: TenantContext, runId: string, stepKey: string) {
    const step = await this.findStep(tenant, runId, stepKey);
    const res = await this.prisma.agentRunStep.updateMany({
      where: { id: step.id, status: 'WAITING_APPROVAL' },
      data: { status: 'PENDING', approvalDecision: 'APPROVED', decidedById: tenant.userId, decidedAt: new Date() },
    });
    if (!res.count) throw new ConflictException({ code: 'NOT_WAITING_APPROVAL', message: 'This step is not waiting for an approval' });
    await this.event(runId, tenant.businessId, 'step.approved', { stepKey, actorId: tenant.userId });
    await this.audit.record({ action: 'run.step_approved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'AgentRun', entityId: runId, metadata: { stepKey } });
    await this.queue.wake(runId);
    return this.get(tenant, runId);
  }

  async reject(tenant: TenantContext, runId: string, stepKey: string) {
    const step = await this.findStep(tenant, runId, stepKey);
    const now = new Date();
    const res = await this.prisma.agentRunStep.updateMany({
      where: { id: step.id, status: 'WAITING_APPROVAL' },
      data: { status: 'FAILED', approvalDecision: 'REJECTED', decidedById: tenant.userId, decidedAt: now, completedAt: now, errorCode: 'APPROVAL_REJECTED', errorMessage: 'A person rejected this step' },
    });
    if (!res.count) throw new ConflictException({ code: 'NOT_WAITING_APPROVAL', message: 'This step is not waiting for an approval' });
    await this.event(runId, tenant.businessId, 'step.rejected', { stepKey, actorId: tenant.userId });
    await this.audit.record({ action: 'run.step_rejected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'AgentRun', entityId: runId, metadata: { stepKey } });
    await this.failRun(runId, tenant.businessId, 'APPROVAL_REJECTED', 'A person rejected a step');
    return this.get(tenant, runId);
  }

  private async findStep(tenant: TenantContext, runId: string, key: string) {
    const step = await this.prisma.agentRunStep.findFirst({ where: { runId, key, businessId: tenant.businessId } });
    if (!step) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run or step not found' });
    return step;
  }

  // ─── Operator controls (Phase N3) ───────────────────────────────────────────────

  private async load(tenant: Actor, runId: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, businessId: tenant.businessId }, include: { steps: true } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    return run;
  }

  private conflict(code: string, message: string) {
    return new ConflictException({ code, message });
  }

  /** Stops new steps from starting. A step already running finishes; approvals can still be given and are applied on resume. */
  async pause(tenant: TenantContext, runId: string) {
    const run = await this.load(tenant, runId);
    const res = await this.prisma.agentRun.updateMany({ where: { id: run.id, status: { in: ACTIVE } }, data: { status: 'PAUSED' } });
    if (!res.count) throw this.conflict('NOT_PAUSABLE', 'Only a run in progress can be paused');
    await this.event(run.id, run.businessId, 'run.paused', { actorId: tenant.userId });
    await this.audit.record({ action: 'run.paused', actorId: tenant.userId, businessId: run.businessId, entityType: 'AgentRun', entityId: run.id });
    return this.get(tenant, run.id);
  }

  async resume(tenant: TenantContext, runId: string) {
    const run = await this.load(tenant, runId);
    const has = (st: string) => run.steps.some((x) => x.status === st);
    const status: AgentRunStatus = has('RUNNING') ? 'RUNNING' : has('WAITING_APPROVAL') ? 'WAITING_APPROVAL' : run.steps.some((x) => DONE_STEP.includes(x.status)) ? 'RUNNING' : 'PENDING';
    const res = await this.prisma.agentRun.updateMany({ where: { id: run.id, status: 'PAUSED' }, data: { status } });
    if (!res.count) throw this.conflict('NOT_PAUSED', 'This run is not paused');
    await this.event(run.id, run.businessId, 'run.resumed', { actorId: tenant.userId });
    await this.audit.record({ action: 'run.resumed', actorId: tenant.userId, businessId: run.businessId, entityType: 'AgentRun', entityId: run.id });
    await this.queue.wake(run.id);
    return this.get(tenant, run.id);
  }

  /**
   * Stops a run for good. Steps that have not started are cancelled. An outward step that is running cannot be taken back,
   * so while one is in flight the cancellation is refused: wait for its result, which is then recorded.
   */
  async cancel(tenant: TenantContext, runId: string) {
    const run = await this.load(tenant, runId);
    if (TERMINAL.includes(run.status)) throw this.conflict('RUN_FINISHED', 'This run is already finished');
    if (run.steps.some((x) => x.status === 'RUNNING' && (this.registry.get(x.adapter)?.external ?? true))) {
      throw this.conflict('STEP_IN_FLIGHT', 'A step that acts outside TOUMA is running: wait for its result before cancelling');
    }
    const now = new Date();
    const res = await this.prisma.agentRun.updateMany({ where: { id: run.id, status: { in: COUNTED } }, data: { status: 'CANCELLED', completedAt: now, errorCode: 'CANCELLED', errorMessage: 'Cancelled by a person' } });
    if (!res.count) throw this.conflict('RUN_FINISHED', 'This run is already finished');
    await this.prisma.agentRunStep.updateMany({ where: { runId: run.id, status: { in: ['PENDING', 'WAITING_APPROVAL'] } }, data: { status: 'CANCELLED', completedAt: now } });
    await this.event(run.id, run.businessId, 'run.cancelled', { actorId: tenant.userId });
    await this.audit.record({ action: 'run.cancelled', actorId: tenant.userId, businessId: run.businessId, entityType: 'AgentRun', entityId: run.id });
    return this.get(tenant, run.id);
  }

  /**
   * Puts a failed run (the dead-letter list) back in progress. Failed steps start over; a step that acts outside TOUMA
   * needs a NEW approval, and one whose outcome is unknown cannot be retried until a person has resolved it.
   */
  async retry(tenant: TenantContext, runId: string) {
    const run = await this.load(tenant, runId);
    if (run.status !== 'FAILED') throw this.conflict('NOT_FAILED', 'Only a failed run can be retried');
    const failed = run.steps.filter((x) => x.status === 'FAILED');
    if (failed.some((x) => x.errorCode === 'OUTCOME_UNKNOWN')) throw this.conflict('OUTCOME_UNKNOWN_UNRESOLVED', 'Resolve the step whose outcome is unknown before retrying');
    const res = await this.prisma.$transaction(async (tx) => {
      await lockTenantQuota(tx, 'runs', tenant.businessId);
      const active = await tx.agentRun.count({ where: { businessId: tenant.businessId, status: { in: COUNTED } } });
      if (active >= this.env.ORCHESTRATOR_MAX_ACTIVE_RUNS_PER_BUSINESS) throw quotaExceeded('RUN_LIMIT_REACHED', 'Too many runs are in progress');
      return tx.agentRun.updateMany({ where: { id: run.id, status: 'FAILED' }, data: { status: 'PENDING', errorCode: null, errorMessage: null, completedAt: null, deadLetteredAt: null } });
    });
    if (!res.count) throw this.conflict('NOT_FAILED', 'Only a failed run can be retried');
    for (const st of failed) {
      await this.prisma.agentRunStep.updateMany({
        where: { id: st.id, status: 'FAILED' },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null, completedAt: null, ...(st.requiresApproval ? { approvalDecision: null, decidedById: null, decidedAt: null } : {}) },
      });
    }
    await this.event(run.id, run.businessId, 'run.retried', { actorId: tenant.userId, detail: { steps: failed.length } });
    await this.audit.record({ action: 'run.retried', actorId: tenant.userId, businessId: run.businessId, entityType: 'AgentRun', entityId: run.id, metadata: { steps: failed.length } });
    await this.queue.wake(run.id);
    return this.get(tenant, run.id);
  }

  /**
   * A person settles a step whose outcome is unknown (the worker stopped or the call timed out while it acted outside TOUMA).
   * EXECUTED: it did happen, mark the step done. NOT_EXECUTED: it did not, so the step may run again, after a new approval.
   * Either way the run stays FAILED until it is retried.
   */
  async resolve(tenant: TenantContext, runId: string, stepKey: string, resolution: 'EXECUTED' | 'NOT_EXECUTED') {
    const step = await this.findStep(tenant, runId, stepKey);
    const now = new Date();
    const data: Prisma.AgentRunStepUpdateManyMutationInput =
      resolution === 'EXECUTED'
        ? { status: 'COMPLETED', output: { resolvedManually: true, outcome: 'EXECUTED' }, completedAt: now, errorCode: null, errorMessage: null }
        : { status: 'PENDING', attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null, completedAt: null, approvalDecision: null, decidedById: null, decidedAt: null };
    const res = await this.prisma.agentRunStep.updateMany({ where: { id: step.id, status: 'FAILED', errorCode: 'OUTCOME_UNKNOWN' }, data });
    if (!res.count) throw this.conflict('NOT_UNKNOWN_OUTCOME', 'This step is not waiting for the outcome to be resolved');
    await this.event(runId, tenant.businessId, 'step.outcome_resolved', { stepKey, actorId: tenant.userId, detail: { resolution } });
    await this.audit.record({ action: 'run.step_outcome_resolved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'AgentRun', entityId: runId, metadata: { stepKey, resolution } });
    return this.get(tenant, runId);
  }

  // ─── Worker side ───────────────────────────────────────────────────────────────

  /** Moves a run forward as far as it can go: runs ready steps, holds approval steps, completes or fails the run. Safe to call at any time and concurrently. */
  async advance(runId: string): Promise<void> {
    for (let round = 0; round < MAX_ADVANCE_ROUNDS; round++) {
      const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, include: { steps: true } });
      if (!run || TERMINAL.includes(run.status) || run.status === 'PAUSED') return;

      const failed = run.steps.find((s) => s.status === 'FAILED');
      if (failed) {
        await this.failRun(run.id, run.businessId, failed.errorCode ?? 'STEP_FAILED', failed.errorMessage ?? 'A step failed');
        return;
      }
      if (run.steps.every((s) => DONE_STEP.includes(s.status))) {
        await this.completeRun(run);
        return;
      }
      if (!(await this.requesterAllowed(run))) {
        await this.failRun(run.id, run.businessId, 'REQUESTER_NOT_ALLOWED', 'The user who started this run is no longer allowed to use AI');
        return;
      }

      const byKey = new Map(run.steps.map((s) => [s.key, s]));
      const now = new Date();
      const ready = run.steps.filter((s) => s.status === 'PENDING' && s.dependsOn.every((d) => DONE_STEP.includes(byKey.get(d)?.status ?? '')) && (!s.nextAttemptAt || s.nextAttemptAt <= now));
      const conditionContext: ConditionContext = { input: run.input as Record<string, unknown>, trigger: (run.triggerData as Record<string, unknown> | null) ?? {}, steps: Object.fromEntries(run.steps.map((x) => [x.key, { output: x.output as Record<string, unknown> | null }])) };
      let progressed = false;
      for (const step of ready) {
        if (step.condition && !evaluateCondition(step.condition as unknown as Condition, conditionContext)) {
          const skipped = await this.prisma.agentRunStep.updateMany({ where: { id: step.id, status: 'PENDING' }, data: { status: 'SKIPPED', completedAt: new Date() } });
          if (skipped.count) {
            await this.event(run.id, run.businessId, 'step.skipped', { stepKey: step.key, detail: { reason: 'condition' } });
            progressed = true;
          }
          continue;
        }
        if (step.requiresApproval && step.approvalDecision !== 'APPROVED') {
          const held = await this.prisma.agentRunStep.updateMany({ where: { id: step.id, status: 'PENDING' }, data: { status: 'WAITING_APPROVAL' } });
          if (held.count) {
            await this.event(run.id, run.businessId, 'step.waiting_approval', { stepKey: step.key });
            progressed = true;
          }
          continue;
        }
        const claim = await this.prisma.agentRunStep.updateMany({
          // The run must still be active at claim time: a cancel or a pause that just committed wins.
          where: { id: step.id, status: 'PENDING', run: { status: { in: ACTIVE } } },
          data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 }, nextAttemptAt: null },
        });
        if (!claim.count) continue; // another worker got it
        progressed = true;
        await this.execute(run, step, byKey);
      }
      await this.syncStatus(run.id);
      if (!progressed) return;
    }
  }

  private async execute(run: RunWithSteps, step: AgentRunStep, byKey: Map<string, AgentRunStep>) {
    const adapter = this.registry.get(step.adapter);
    const attempt = step.attempts + 1;
    if (!adapter) return this.failStep(run, step, attempt, new RunStepError('ADAPTER_NOT_FOUND', 'No adapter is registered for this step'), false);
    // Defence in depth: whatever the plan says, an outward step never runs without a recorded approval.
    if (adapter.external && step.approvalDecision !== 'APPROVED') {
      return this.failStep(run, step, attempt, new RunStepError('APPROVAL_REQUIRED', 'This step needs a human approval'), true);
    }
    await this.event(run.id, run.businessId, 'step.started', { stepKey: step.key, detail: { attempt } });
    try {
      const outputs: Record<string, Record<string, unknown>> = {};
      for (const d of step.dependsOn) outputs[d] = (byKey.get(d)?.output as Record<string, unknown> | null) ?? {};
      const out = await withTimeout(
        adapter.execute({ runId: run.id, stepKey: step.key, businessId: run.businessId, idempotencyKey: `${run.id}:${step.key}`, input: run.input as Record<string, unknown>, outputs }),
        this.env.ORCHESTRATOR_STEP_TIMEOUT_MS,
      );
      const done = await this.prisma.agentRunStep.updateMany({
        where: { id: step.id, status: 'RUNNING' },
        data: { status: 'COMPLETED', output: out as Prisma.InputJsonObject, completedAt: new Date(), errorCode: null, errorMessage: null },
      });
      if (done.count) await this.event(run.id, run.businessId, 'step.completed', { stepKey: step.key, detail: { attempt } });
      else this.logger.warn(`Run ${run.id} step ${step.key}: result discarded, the step was reclaimed meanwhile`);
    } catch (err) {
      const e = err instanceof RunStepError ? err : new RunStepError('STEP_ERROR', 'The step failed unexpectedly', false);
      // Server-side log: codes only, never the error message of an adapter and never the input.
      this.logger.warn(`Run ${run.id} step ${step.key} attempt ${attempt} failed: ${e.code}`);
      await this.failStep(run, step, attempt, e, adapter.external);
    }
  }

  private async failStep(run: AgentRun, step: AgentRunStep, attempt: number, e: RunStepError, external: boolean) {
    // A timeout of an outward action leaves its outcome unknown: it must not be retried, a person decides.
    const code = external && e.code === 'STEP_TIMEOUT' ? 'OUTCOME_UNKNOWN' : e.code;
    const retry = e.retryable && !external && attempt < step.maxAttempts;
    if (retry) {
      const delay = (step.backoffMs ?? this.env.ORCHESTRATOR_STEP_BACKOFF_MS) * 2 ** (attempt - 1);
      const res = await this.prisma.agentRunStep.updateMany({
        where: { id: step.id, status: 'RUNNING' },
        data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() + delay), errorCode: code, errorMessage: e.message.slice(0, 300) },
      });
      if (res.count) {
        await this.event(run.id, run.businessId, 'step.retry_scheduled', { stepKey: step.key, detail: { attempt, code, delayMs: delay } });
        await this.queue.wake(run.id, delay);
      }
      return;
    }
    const res = await this.prisma.agentRunStep.updateMany({
      where: { id: step.id, status: 'RUNNING' },
      data: { status: 'FAILED', completedAt: new Date(), errorCode: code, errorMessage: e.message.slice(0, 300) },
    });
    if (res.count) await this.event(run.id, run.businessId, 'step.failed', { stepKey: step.key, detail: { attempt, code } });
  }

  private async requesterAllowed(run: AgentRun): Promise<boolean> {
    if (!run.createdById) return false;
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: run.createdById, businessId: run.businessId } } });
    return Boolean(m && m.status === 'ACTIVE' && roleHasPermission(m.role, 'ai.use'));
  }

  /** Derives the run status from its steps. FAILED and COMPLETED are set explicitly by failRun / completeRun. */
  private async syncStatus(runId: string) {
    const steps = await this.prisma.agentRunStep.findMany({ where: { runId }, select: { status: true } });
    const has = (s: string) => steps.some((x) => x.status === s);
    const status: AgentRunStatus = has('RUNNING') ? 'RUNNING' : has('WAITING_APPROVAL') ? 'WAITING_APPROVAL' : steps.some((x) => DONE_STEP.includes(x.status)) ? 'RUNNING' : 'PENDING';
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true, startedAt: true } });
    if (!run || TERMINAL.includes(run.status) || run.status === status) return;
    await this.prisma.agentRun.updateMany({ where: { id: runId, status: { in: ACTIVE } }, data: { status, ...(status !== 'PENDING' && !run.startedAt ? { startedAt: new Date() } : {}) } });
  }

  private async completeRun(run: AgentRun) {
    const res = await this.prisma.agentRun.updateMany({ where: { id: run.id, status: { in: ACTIVE } }, data: { status: 'COMPLETED', completedAt: new Date(), errorCode: null, errorMessage: null, ...(run.startedAt ? {} : { startedAt: new Date() }) } });
    if (!res.count) return;
    await this.event(run.id, run.businessId, 'run.completed');
    await this.audit.record({ action: 'run.completed', businessId: run.businessId, entityType: 'AgentRun', entityId: run.id });
    await this.notifyFinished(run.id);
  }

  private async failRun(runId: string, businessId: string, code: string, message: string) {
    const res = await this.prisma.agentRun.updateMany({ where: { id: runId, status: { in: ACTIVE } }, data: { status: 'FAILED', completedAt: new Date(), errorCode: code, errorMessage: message.slice(0, 300), deadLetteredAt: new Date() } });
    if (!res.count) return;
    await this.event(runId, businessId, 'run.failed', { detail: { code } });
    await this.audit.record({ action: 'run.failed', businessId, entityType: 'AgentRun', entityId: runId, metadata: { code } });
    await this.notifyFinished(runId);
  }

  private finishedListener?: RunFinished;

  /** The workflow engine registers here to chain workflows on internal events (a hook, so the two services do not depend on each other). */
  setFinishedListener(fn: RunFinished) {
    this.finishedListener = fn;
  }

  private async notifyFinished(runId: string) {
    if (!this.finishedListener) return;
    try {
      const r = await this.prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true, businessId: true, workflowId: true, createdById: true, status: true, errorCode: true } });
      if (r?.workflowId && (r.status === 'COMPLETED' || r.status === 'FAILED')) await this.finishedListener({ id: r.id, businessId: r.businessId, workflowId: r.workflowId, createdById: r.createdById, status: r.status, errorCode: r.errorCode });
    } catch (e) {
      this.logger.warn(`finished listener failed: ${(e as Error).name}`);
    }
  }

  private event(runId: string, businessId: string, type: string, extra: { stepKey?: string; actorId?: string; detail?: Prisma.InputJsonObject } = {}) {
    return this.prisma.agentRunEvent.create({ data: { runId, businessId, type, stepKey: extra.stepKey, actorId: extra.actorId, detail: extra.detail } });
  }

  /**
   * Crash recovery, run by the worker on a timer.
   *  - A step RUNNING past its lease belongs to a dead worker. An internal step goes back to PENDING (its attempt counts);
   *    a step that acts outside TOUMA is FAILED with an unknown outcome and is NEVER run again by the system.
   *  - Runs in progress that nobody advanced recently (lost wake-up, delayed retry whose job disappeared) are woken.
   */
  async reconcile(now = new Date()): Promise<{ recovered: number; failed: number; woken: number }> {
    let recovered = 0;
    let failed = 0;
    const lease = new Date(now.getTime() - this.env.ORCHESTRATOR_STEP_LEASE_SECONDS * 1000);
    const stale = await this.prisma.agentRunStep.findMany({ where: { status: 'RUNNING', startedAt: { lt: lease } }, take: 100 });
    for (const step of stale) {
      const external = this.registry.get(step.adapter)?.external ?? true;
      if (!external && step.attempts < step.maxAttempts) {
        const res = await this.prisma.agentRunStep.updateMany({ where: { id: step.id, status: 'RUNNING', startedAt: { lt: lease } }, data: { status: 'PENDING', nextAttemptAt: null } });
        if (res.count) {
          recovered++;
          await this.event(step.runId, step.businessId, 'step.recovered', { stepKey: step.key, detail: { attempts: step.attempts } });
          await this.queue.wake(step.runId);
        }
      } else {
        const code = external ? 'OUTCOME_UNKNOWN' : 'LEASE_EXPIRED';
        const res = await this.prisma.agentRunStep.updateMany({
          where: { id: step.id, status: 'RUNNING', startedAt: { lt: lease } },
          data: { status: 'FAILED', completedAt: now, errorCode: code, errorMessage: external ? 'The worker stopped while this step was running: its outcome is unknown and a person must check it' : 'The step kept being interrupted' },
        });
        if (res.count) {
          failed++;
          await this.event(step.runId, step.businessId, 'step.failed', { stepKey: step.key, detail: { code } });
          await this.failRun(step.runId, step.businessId, code, 'A step was interrupted');
        }
      }
    }
    const quiet = new Date(now.getTime() - 60_000);
    const idle = await this.prisma.agentRun.findMany({ where: { status: { in: ['PENDING', 'RUNNING'] }, updatedAt: { lt: quiet } }, select: { id: true }, take: 100 });
    for (const r of idle) await this.queue.wake(r.id);
    return { recovered, failed, woken: idle.length };
  }
}
