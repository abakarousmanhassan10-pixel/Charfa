import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { SimulatedRunAdapters } from '../src/runs/run-adapters';
import { RunsService } from '../src/runs/runs.service';
import { RunsWorkerService } from '../src/runs/runs-worker.service';
import { WorkflowSchedulerService } from '../src/workflows/workflow-scheduler.service';
import { WorkflowsService } from '../src/workflows/workflows.service';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * Workflow engine (Phase N3) on top of the orchestrator: versions, triggers, conditions, retries, approvals, dead letters,
 * pause / cancel, recovery and worker restart. Real PostgreSQL, Redis and BullMQ; adapters are the built-in simulations.
 */
describe('Workflow engine (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let adapters: SimulatedRunAdapters;
  let runs: RunsService;
  let workflows: WorkflowsService;
  let scheduler: WorkflowSchedulerService;
  let h: ReturnType<typeof aiHelpers>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
    adapters = app.get(SimulatedRunAdapters);
    runs = app.get(RunsService);
    workflows = app.get(WorkflowsService);
    scheduler = app.get(WorkflowSchedulerService);
    h = aiHelpers(app);
  });
  beforeEach(async () => {
    // Runs of the previous test may still be executing: wait until nothing is in flight before counting adapter calls.
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await prisma.agentRun.count({ where: { status: { in: ['PENDING', 'RUNNING'] }, steps: { none: { status: 'FAILED' } } } })) > 0) await new Promise((r) => setTimeout(r, 25));
    adapters.reset();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────────
  type StepView = { key: string; status: string; attempts: number; errorCode?: string | null; approvalDecision?: string | null; output?: unknown };
  type RunView = { id: string; status: string; errorCode?: string | null; workflowId?: string; workflowVersion?: number; triggerType?: string; deadLetteredAt?: string | null; steps: StepView[] };
  const step = (run: { steps: StepView[] }, key: string) => run.steps.find((s) => s.key === key) as StepView;
  const uniq = (p = 'WF') => `${p} ${randomUUID().slice(0, 8)}`;

  const LAUNCH = (over: Record<string, unknown> = {}) => ({
    triggers: [{ type: 'manual' }],
    input: { topic: { type: 'string', required: true, maxLength: 200 }, channel: { type: 'string', maxLength: 30 } },
    steps: [
      { key: 'product_analysis', adapter: 'simulated.product-analysis' },
      { key: 'content_draft', adapter: 'simulated.content-draft', dependsOn: ['product_analysis'] },
      { key: 'calendar_schedule', adapter: 'simulated.calendar-schedule', dependsOn: ['content_draft'], requiresApproval: true },
    ],
    ...over,
  });
  const INTERNAL = (over: Record<string, unknown> = {}) => ({ triggers: [{ type: 'manual' }], steps: [{ key: 'analysis', adapter: 'simulated.product-analysis' }], ...over });

  const defWith = (c: Ctx, definition: unknown, name = uniq()) => request(http).post('/api/v1/workflows').set(as(c)).send({ name, definition });
  async function makeWorkflow(c: Ctx, definition: unknown = LAUNCH(), activate = true) {
    const res = await defWith(c, definition).expect(201);
    if (activate) await request(http).post(`/api/v1/workflows/${res.body.id}/activate`).set(as(c)).expect(200);
    return res.body as { id: string; name: string };
  }
  const start = (c: Ctx, id: string, input: unknown = { topic: 'Autumn launch' }, key: string = `k-${randomUUID()}`) => request(http).post(`/api/v1/workflows/${id}/executions`).set(as(c)).set('Idempotency-Key', key).send({ input });
  const getRun = (c: Ctx, id: string) => request(http).get(`/api/v1/runs/${id}`).set(as(c));
  async function until(c: Ctx, id: string, status: string, timeoutMs = 10_000): Promise<RunView> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await getRun(c, id).expect(200);
      if (r.body.status === status) return r.body;
      if (Date.now() > end) throw new Error(`run ${id} is ${r.body.status}, expected ${status}`);
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  const approve = (c: Ctx, runId: string, key = 'calendar_schedule') => request(http).post(`/api/v1/runs/${runId}/steps/${key}/approve`).set(as(c));
  const op = (c: Ctx, runId: string, what: 'pause' | 'resume' | 'cancel' | 'retry') => request(http).post(`/api/v1/runs/${runId}/${what}`).set(as(c));
  const userId = async (email: string) => (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function plant(businessId: string, createdById: string, steps: Array<{ key: string; adapter: string; dependsOn?: string[]; status: string; requiresApproval?: boolean; approved?: boolean; attempts?: number; startedAt?: Date; errorCode?: string }>, run: { status?: 'RUNNING' | 'FAILED' } = {}) {
    return prisma.agentRun.create({
      data: {
        businessId, createdById, template: 'workflow:planted', templateVersion: 1, status: run.status ?? 'RUNNING', idempotencyKey: `plant-${randomUUID()}`, requestHash: 'x', input: { topic: 'Planted' },
        steps: { create: steps.map((s) => ({ businessId, key: s.key, adapter: s.adapter, dependsOn: s.dependsOn ?? [], status: s.status as 'PENDING', requiresApproval: s.requiresApproval ?? false, approvalDecision: s.approved ? 'APPROVED' : null, attempts: s.attempts ?? 0, maxAttempts: 3, startedAt: s.startedAt, errorCode: s.errorCode, output: s.status === 'COMPLETED' ? {} : undefined })) },
      },
    });
  }

  // ─── definitions: RBAC, versioning, isolation, safety ─────────────────────────
  describe('definitions', () => {
    it('limits who can define, activate and read workflows', async () => {
      const t = await h.tenant('Café Awa');
      await request(http).post('/api/v1/workflows').send({ name: 'x', definition: LAUNCH() }).expect(401);
      const viewer = await h.member(t, 'VIEWER');
      const editor = await h.member(t, 'EDITOR');
      const admin = await h.member(t, 'ADMIN');
      await defWith(viewer, LAUNCH()).expect(403);
      await defWith(editor, LAUNCH()).expect(403); // defining what may run on its own is a management decision
      const wf = (await defWith(admin, LAUNCH(), 'Launch').expect(201)).body;
      expect(wf).toMatchObject({ name: 'Launch', currentVersion: 1, isActive: false });
      await defWith(admin, LAUNCH(), 'Launch').expect(409); // names are unique per business
      await request(http).get('/api/v1/workflows').set(as(viewer)).expect(403);
      expect((await request(http).get('/api/v1/workflows').set(as(editor)).expect(200)).body.total).toBe(1);
      await request(http).get(`/api/v1/workflows/${wf.id}`).set(as(editor)).expect(200);
      await request(http).post(`/api/v1/workflows/${wf.id}/activate`).set(as(editor)).expect(403);
      await request(http).put(`/api/v1/workflows/${wf.id}`).set(as(editor)).send({ definition: LAUNCH() }).expect(403);
      expect((await request(http).post(`/api/v1/workflows/${wf.id}/activate`).set(as(admin)).expect(200)).body.isActive).toBe(true);
      expect((await request(http).post(`/api/v1/workflows/${wf.id}/deactivate`).set(as(admin)).expect(200)).body.isActive).toBe(false);
    });

    it('keeps every version, runs executions on the version they started from, and never edits history', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t);
      const first = (await start(t, wf.id).expect(201)).body as RunView;
      expect(first).toMatchObject({ workflowId: wf.id, workflowVersion: 1, triggerType: 'manual' });
      await until(t, first.id, 'WAITING_APPROVAL');

      // v2 adds a step; the running execution keeps its three steps.
      const v2 = LAUNCH({ steps: [...LAUNCH().steps, { key: 'extra', adapter: 'simulated.content-draft', dependsOn: ['calendar_schedule'] }] });
      const saved = (await request(http).put(`/api/v1/workflows/${wf.id}`).set(as(t)).send({ definition: v2 }).expect(200)).body;
      expect(saved.currentVersion).toBe(2);
      const detail = (await request(http).get(`/api/v1/workflows/${wf.id}`).set(as(t)).expect(200)).body;
      expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(detail.definition.steps).toHaveLength(4);
      const v1 = (await request(http).get(`/api/v1/workflows/${wf.id}/versions/1`).set(as(t)).expect(200)).body;
      expect(v1.definition.steps).toHaveLength(3);

      await approve(t, first.id).expect(200);
      const done = await until(t, first.id, 'COMPLETED');
      expect(done.steps).toHaveLength(3);
      expect(done.workflowVersion).toBe(1);
      const second = (await start(t, wf.id).expect(201)).body as RunView;
      expect(second.workflowVersion).toBe(2);
      expect(second.steps).toHaveLength(4);
      await request(http).get(`/api/v1/workflows/${wf.id}/versions/9`).set(as(t)).expect(404);
    });

    it('is isolated between businesses', async () => {
      const a = await h.tenant('Café A');
      const b = await h.tenant('Café B');
      const wf = await makeWorkflow(a);
      const run = (await start(a, wf.id).expect(201)).body as RunView;
      await until(a, run.id, 'WAITING_APPROVAL');
      await request(http).get(`/api/v1/workflows/${wf.id}`).set(as(b)).expect(404);
      await request(http).put(`/api/v1/workflows/${wf.id}`).set(as(b)).send({ definition: LAUNCH() }).expect(404);
      await request(http).post(`/api/v1/workflows/${wf.id}/activate`).set(as(b)).expect(404);
      await request(http).post(`/api/v1/workflows/${wf.id}/deactivate`).set(as(b)).expect(404);
      await start(b, wf.id).expect(404);
      await request(http).get(`/api/v1/workflows/${wf.id}/executions`).set(as(b)).expect(404);
      await request(http).get(`/api/v1/workflows/${wf.id}/versions/1`).set(as(b)).expect(404);
      expect((await request(http).get('/api/v1/workflows').set(as(b)).expect(200)).body.total).toBe(0);
      // Runs, their controls and the dead-letter list are scoped too.
      await getRun(b, run.id).expect(404);
      await approve(b, run.id).expect(404);
      for (const what of ['pause', 'resume', 'cancel', 'retry'] as const) await op(b, run.id, what).expect(404);
      expect((await request(http).get('/api/v1/runs?deadLettered=true').set(as(b)).expect(200)).body.total).toBe(0);
      // The same workflow name can exist in both businesses.
      await defWith(b, LAUNCH(), wf.name).expect(201);
    });

    it('refuses definitions that could run code, reach out, skip an approval or loop', async () => {
      const t = await h.tenant('Café Awa');
      const bad: unknown[] = [
        LAUNCH({ steps: [{ key: 'a', adapter: 'simulated.product-analysis', command: 'rm -rf /' }] }),
        LAUNCH({ steps: [{ key: 'a', adapter: 'http.fetch' }] }),
        LAUNCH({ steps: [{ key: 'a', adapter: 'simulated.calendar-schedule', requiresApproval: false }] }),
        LAUNCH({ steps: [{ key: 'a', adapter: 'simulated.product-analysis', dependsOn: ['b'] }, { key: 'b', adapter: 'simulated.product-analysis', dependsOn: ['a'] }] }),
        LAUNCH({ steps: [{ key: 'a', adapter: 'simulated.product-analysis', condition: { field: 'env.AWS_SECRET', op: 'exists' } }] }),
        LAUNCH({ steps: [{ key: 'a', adapter: 'simulated.product-analysis', condition: { field: 'input.x', op: 'eq', value: { $code: 'x' } } }] }),
        LAUNCH({ triggers: [{ type: 'webhook' }] }),
        LAUNCH({ triggers: [{ type: 'schedule', everyMinutes: 0 }] }),
        LAUNCH({ steps: Array.from({ length: 11 }, (_, i) => ({ key: `s${i}`, adapter: 'simulated.product-analysis' })) }),
        { ...LAUNCH(), onComplete: 'process.exit()' },
      ];
      for (const d of bad) await defWith(t, d).expect(400);
      expect((await request(http).get('/api/v1/workflows').set(as(t)).expect(200)).body.total).toBe(0);
      const ok = await makeWorkflow(t);
      await request(http).put(`/api/v1/workflows/${ok.id}`).set(as(t)).send({ definition: bad[0] }).expect(400);
      expect((await request(http).get(`/api/v1/workflows/${ok.id}`).set(as(t)).expect(200)).body.currentVersion).toBe(1);
    });
  });

  // ─── the demonstration workflow ───────────────────────────────────────────────
  describe('first workflow: product analysis → content draft → human approval → calendar scheduling', () => {
    it('runs the analysis and the draft, waits for a person, then schedules once; history and audit hold no business input', async () => {
      const t = await h.tenant('Café Awa');
      const editor = await h.member(t, 'EDITOR');
      const admin = await h.member(t, 'ADMIN');
      const wf = await makeWorkflow(t);
      const created = await start(editor, wf.id, { topic: 'Confidential-topic-98765', channel: 'instagram' }).expect(201);
      const waiting = await until(editor, created.body.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'product_analysis').status).toBe('COMPLETED');
      expect(step(waiting, 'content_draft').status).toBe('COMPLETED');
      expect(step(waiting, 'calendar_schedule').status).toBe('WAITING_APPROVAL');
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      await approve(editor, created.body.id).expect(403); // creating is not approving
      await approve(admin, created.body.id).expect(200);
      await Promise.all(Array.from({ length: 5 }, () => runs.advance(created.body.id)));
      const done = await until(admin, created.body.id, 'COMPLETED');
      expect(step(done, 'calendar_schedule')).toMatchObject({ status: 'COMPLETED', approvalDecision: 'APPROVED', attempts: 1 });
      expect(adapters.calls).toEqual({ 'simulated.product-analysis': 1, 'simulated.content-draft': 1, 'simulated.calendar-schedule': 1 });

      const events = (await request(http).get(`/api/v1/runs/${created.body.id}/events`).set(as(admin)).expect(200)).body as Array<{ type: string }>;
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['run.created', 'step.completed', 'step.waiting_approval', 'step.approved', 'run.completed']));
      expect(JSON.stringify(events)).not.toContain('Confidential-topic');
      const audit = await prisma.auditLog.findMany({ where: { businessId: t.businessId } });
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['workflow.created', 'workflow.activated', 'run.created', 'run.step_approved', 'run.completed']));
      expect(JSON.stringify(audit)).not.toContain('Confidential-topic');
      const list = (await request(http).get(`/api/v1/workflows/${wf.id}/executions`).set(as(admin)).expect(200)).body;
      expect(list.items.map((r: { id: string }) => r.id)).toEqual([created.body.id]);
    });

    it('needs an active workflow, a manual trigger and valid input, and never starts the same request twice', async () => {
      const t = await h.tenant('Café Awa');
      const inactive = await makeWorkflow(t, LAUNCH(), false);
      expect((await start(t, inactive.id).expect(409)).body.code).toBe('WORKFLOW_INACTIVE');
      const scheduleOnly = await makeWorkflow(t, LAUNCH({ triggers: [{ type: 'schedule', everyMinutes: 60 }] }));
      expect((await start(t, scheduleOnly.id).expect(409)).body.code).toBe('TRIGGER_NOT_ALLOWED');

      const wf = await makeWorkflow(t);
      await request(http).post(`/api/v1/workflows/${wf.id}/executions`).set(as(t)).send({ input: { topic: 'x' } }).expect(400); // no key
      await request(http).post(`/api/v1/workflows/${wf.id}/executions`).set(as(t)).set('Idempotency-Key', 'short').send({ input: { topic: 'x' } }).expect(400);
      for (const input of [{}, { topic: 'x', surprise: 1 }, { topic: 7 }, { topic: 'a'.repeat(201) }, { topic: 'a\u0000b' }, [] as unknown]) await start(t, wf.id, input).expect(400);
      expect(await prisma.agentRun.count({ where: { businessId: t.businessId, workflowId: wf.id } })).toBe(0);

      const key = `k-${randomUUID()}`;
      const first = await start(t, wf.id, { topic: 'Same' }, key).expect(201);
      const again = await start(t, wf.id, { topic: 'Same' }, key).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect((await start(t, wf.id, { topic: 'Different' }, key).expect(409)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      await until(t, first.body.id, 'WAITING_APPROVAL');
      expect(adapters.calls['simulated.product-analysis']).toBe(1);
      const k2 = `k-${randomUUID()}`;
      const raced = await Promise.all(Array.from({ length: 4 }, () => start(t, wf.id, { topic: 'Race' }, k2)));
      expect(new Set(raced.map((r) => r.body.id)).size).toBe(1);
    });
  });

  // ─── conditions and retry policy ──────────────────────────────────────────────
  describe('conditions and retry policy', () => {
    it('skips a step whose condition is false and lets its dependents continue', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t, LAUNCH({
        steps: [
          { key: 'product_analysis', adapter: 'simulated.product-analysis' },
          { key: 'content_draft', adapter: 'simulated.content-draft', dependsOn: ['product_analysis'], condition: { all: [{ field: 'input.channel', op: 'eq', value: 'instagram' }, { field: 'steps.product_analysis.output.score', op: 'gt', value: 50 }] } },
          { key: 'calendar_schedule', adapter: 'simulated.calendar-schedule', dependsOn: ['content_draft'], requiresApproval: true },
        ],
      }));
      const skipped = (await start(t, wf.id, { topic: 'T', channel: 'facebook' }).expect(201)).body as RunView;
      const w1 = await until(t, skipped.id, 'WAITING_APPROVAL');
      expect(step(w1, 'content_draft').status).toBe('SKIPPED');
      expect(step(w1, 'calendar_schedule').status).toBe('WAITING_APPROVAL');
      expect(adapters.calls['simulated.content-draft'] ?? 0).toBe(0);
      const types = (await request(http).get(`/api/v1/runs/${skipped.id}/events`).set(as(t)).expect(200)).body.map((e: { type: string }) => e.type);
      expect(types).toContain('step.skipped');
      await approve(t, skipped.id).expect(200);
      await until(t, skipped.id, 'COMPLETED');

      const ran = (await start(t, wf.id, { topic: 'T', channel: 'instagram' }).expect(201)).body as RunView;
      const w2 = await until(t, ran.id, 'WAITING_APPROVAL');
      expect(step(w2, 'content_draft').status).toBe('COMPLETED');
      expect(adapters.calls['simulated.content-draft']).toBe(1);
    });

    it('applies the retry policy of each step: transient failures back off, then the step fails after its own attempt limit', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t, INTERNAL({ steps: [{ key: 'analysis', adapter: 'simulated.product-analysis', retry: { maxAttempts: 2, backoffMs: 20 } }] }));
      adapters.failNext('simulated.product-analysis', 1, true, 'PROVIDER_BUSY');
      const ok = (await start(t, wf.id, {}).expect(201)).body as RunView;
      const done = await until(t, ok.id, 'COMPLETED');
      expect(step(done, 'analysis')).toMatchObject({ status: 'COMPLETED', attempts: 2 });

      adapters.reset();
      adapters.failNext('simulated.product-analysis', 9, true, 'PROVIDER_BUSY');
      const bad = (await start(t, wf.id, {}).expect(201)).body as RunView;
      const failed = await until(t, bad.id, 'FAILED');
      expect(step(failed, 'analysis')).toMatchObject({ status: 'FAILED', attempts: 2, errorCode: 'PROVIDER_BUSY' }); // 2, not the environment default of 3
      expect(adapters.calls['simulated.product-analysis']).toBe(2);
    });
  });

  // ─── triggers ─────────────────────────────────────────────────────────────────
  describe('scheduled trigger', () => {
    it('starts a due schedule exactly once, as the person who activated it, and not when deactivated', async () => {
      const t = await h.tenant('Café Awa');
      const admin = await h.member(t, 'ADMIN');
      const wf = await makeWorkflow(admin, INTERNAL({ triggers: [{ type: 'schedule', everyMinutes: 1 }], defaultInput: {}, input: {} }));
      const def = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: wf.id } });
      expect(def.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 30_000); // armed one interval ahead, not firing now
      await prisma.workflowDefinition.update({ where: { id: wf.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
      const results = await Promise.all(Array.from({ length: 5 }, () => workflows.runDueSchedules()));
      expect(results.reduce((n, r) => n + r.started, 0)).toBe(1); // five workers racing on one slot
      const created = await prisma.agentRun.findMany({ where: { workflowId: wf.id } });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ triggerType: 'schedule', createdById: admin.userId });
      await until(admin, created[0]!.id, 'COMPLETED');
      expect((await scheduler.tick()).started).toBe(0); // the slot moved forward
      await request(http).post(`/api/v1/workflows/${wf.id}/deactivate`).set(as(admin)).expect(200);
      await prisma.workflowDefinition.update({ where: { id: wf.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
      expect((await workflows.runDueSchedules()).started).toBe(0);
      expect(await prisma.agentRun.count({ where: { workflowId: wf.id } })).toBe(1);
    });

    it('a schedule that cannot start (tenant limit) is skipped and audited, not retried in a loop', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t, INTERNAL({ triggers: [{ type: 'schedule', everyMinutes: 1 }] }));
      const big = await makeWorkflow(t, LAUNCH());
      for (let i = 0; i < 5; i++) await start(t, big.id, { topic: `T${i}` }).expect(201); // five runs waiting for approval fill the tenant's limit
      await prisma.workflowDefinition.update({ where: { id: wf.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
      expect(await workflows.runDueSchedules()).toMatchObject({ started: 0, skipped: 1 });
      expect(await prisma.auditLog.count({ where: { action: 'workflow.schedule_skipped', entityId: wf.id } })).toBe(1);
      expect((await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: wf.id } })).nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('internal event trigger', () => {
    it('starts matching workflows once per event id, applies the condition, and never crosses businesses', async () => {
      const a = await h.tenant('Café A');
      const b = await h.tenant('Café B');
      const defn = INTERNAL({ triggers: [{ type: 'event', event: 'product.created', condition: { field: 'trigger.price', op: 'gte', value: 100 } }] });
      const wfA = await makeWorkflow(a, defn);
      const wfB = await makeWorkflow(b, defn);

      expect(await workflows.emit(a.businessId, 'product.created', 'evt-1', { price: 150, name: 'Bissap', nested: { x: 1 } })).toEqual({ started: 1, duplicates: 0, skipped: 0 });
      expect(await workflows.emit(a.businessId, 'product.created', 'evt-1', { price: 150, name: 'Bissap', nested: { x: 1 } })).toEqual({ started: 0, duplicates: 1, skipped: 0 });
      expect((await workflows.emit(a.businessId, 'product.created', 'evt-1', { price: 999 })).duplicates).toBe(1); // same id, other payload: still no second run
      expect(await workflows.emit(a.businessId, 'product.created', 'evt-2', { price: 50 })).toMatchObject({ started: 0, skipped: 1 }); // condition false
      expect(await workflows.emit(a.businessId, 'product.updated', 'evt-3', { price: 500 })).toMatchObject({ started: 0 }); // other event type
      await Promise.all(Array.from({ length: 4 }, () => workflows.emit(a.businessId, 'product.created', 'evt-4', { price: 200 })));

      const runsA = await prisma.agentRun.findMany({ where: { workflowId: wfA.id }, orderBy: { createdAt: 'asc' } });
      expect(runsA).toHaveLength(2); // evt-1 and evt-4, once each
      expect(runsA[0]).toMatchObject({ triggerType: 'event', triggerData: { price: 150, name: 'Bissap' } });
      expect(JSON.stringify(runsA[0]!.triggerData)).not.toContain('nested');
      expect(await prisma.agentRun.count({ where: { workflowId: wfB.id } })).toBe(0); // business B never reacts to A's events
      expect(await workflows.emit(b.businessId, 'product.created', 'evt-1', { price: 150 })).toMatchObject({ started: 1 }); // and its own event ids are its own
      await expect(workflows.emit(a.businessId, 'user.deleted' as never, 'evt-9')).rejects.toThrow();
      await expect(workflows.emit(a.businessId, 'product.created', 'bad id with spaces')).rejects.toThrow();
    });

    it('chains workflows on completion events, but a workflow never reacts to its own result', async () => {
      const t = await h.tenant('Café Awa');
      const first = await makeWorkflow(t, LAUNCH());
      const follower = await makeWorkflow(t, INTERNAL({ triggers: [{ type: 'event', event: 'workflow.execution.completed' }] }));
      const run = (await start(t, first.id).expect(201)).body as RunView;
      await until(t, run.id, 'WAITING_APPROVAL');
      expect(await prisma.agentRun.count({ where: { workflowId: follower.id } })).toBe(0);
      await approve(t, run.id).expect(200);
      await until(t, run.id, 'COMPLETED');
      const end = Date.now() + 8000;
      let followerRuns = await prisma.agentRun.findMany({ where: { workflowId: follower.id } });
      while (!followerRuns.length && Date.now() < end) {
        await sleep(40);
        followerRuns = await prisma.agentRun.findMany({ where: { workflowId: follower.id } });
      }
      expect(followerRuns).toHaveLength(1);
      expect(followerRuns[0]).toMatchObject({ triggerType: 'event', triggerData: { workflowId: first.id, runId: run.id } });
      await until(t, followerRuns[0]!.id, 'COMPLETED');
      await sleep(400); // the follower's own completion event must not start it again
      expect(await prisma.agentRun.count({ where: { workflowId: follower.id } })).toBe(1);
    });
  });

  // ─── operator controls ────────────────────────────────────────────────────────
  describe('pause, resume and cancel', () => {
    it('pauses before the next step starts, applies approvals only after resume, and resumes', async () => {
      const t = await h.tenant('Café Awa');
      const admin = await h.member(t, 'ADMIN');
      const editor = await h.member(t, 'EDITOR');
      const wf = await makeWorkflow(t);
      adapters.slowNext('simulated.product-analysis', 500, 1);
      const run = (await start(t, wf.id).expect(201)).body as RunView;
      await sleep(150); // the analysis is running
      await op(editor, run.id, 'pause').expect(403);
      expect((await op(admin, run.id, 'pause').expect(200)).body.status).toBe('PAUSED');
      await sleep(900); // the analysis finishes, but nothing new may start
      expect(adapters.calls['simulated.content-draft'] ?? 0).toBe(0);
      expect((await getRun(t, run.id).expect(200)).body.status).toBe('PAUSED');
      await op(admin, run.id, 'pause').expect(409);
      await op(admin, run.id, 'resume').expect(200);
      await until(t, run.id, 'WAITING_APPROVAL');
      await op(admin, run.id, 'resume').expect(409);

      await op(admin, run.id, 'pause').expect(200);
      await approve(admin, run.id).expect(200); // recorded, but it cannot run while paused
      await sleep(400);
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      expect((await getRun(t, run.id).expect(200)).body.status).toBe('PAUSED');
      await op(admin, run.id, 'resume').expect(200);
      await until(t, run.id, 'COMPLETED');
      expect(adapters.calls['simulated.calendar-schedule']).toBe(1);
    });

    it('cancels a run, cancels its unfinished steps, and never lets a late approval run anything', async () => {
      const t = await h.tenant('Café Awa');
      const admin = await h.member(t, 'ADMIN');
      const editor = await h.member(t, 'EDITOR');
      const wf = await makeWorkflow(t);
      const run = (await start(t, wf.id).expect(201)).body as RunView;
      await until(t, run.id, 'WAITING_APPROVAL');
      await op(editor, run.id, 'cancel').expect(403);
      const cancelled = (await op(admin, run.id, 'cancel').expect(200)).body as RunView;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', errorCode: 'CANCELLED' });
      expect(step(cancelled, 'calendar_schedule').status).toBe('CANCELLED');
      expect(step(cancelled, 'product_analysis').status).toBe('COMPLETED'); // finished work stays as it was
      await approve(admin, run.id).expect(409);
      await op(admin, run.id, 'cancel').expect(409);
      await op(admin, run.id, 'pause').expect(409);
      await op(admin, run.id, 'retry').expect(409);
      await runs.advance(run.id);
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      // A cancelled run frees its slot.
      for (let i = 0; i < 4; i++) await start(t, wf.id, { topic: `T${i}` }).expect(201);
      await start(t, wf.id, { topic: 'fifth' }).expect(201);
    });

    it('refuses to cancel while a step that acts outside TOUMA is running: its result cannot be taken back', async () => {
      const t = await h.tenant('Café Awa');
      const run = await plant(t.businessId, await userId(t.userEmail), [
        { key: 'draft', adapter: 'simulated.content-draft', status: 'COMPLETED' },
        { key: 'calendar_schedule', adapter: 'simulated.calendar-schedule', dependsOn: ['draft'], status: 'RUNNING', requiresApproval: true, approved: true, attempts: 1, startedAt: new Date() },
      ]);
      expect((await op(t, run.id, 'cancel').expect(409)).body.code).toBe('STEP_IN_FLIGHT');
      expect((await getRun(t, run.id).expect(200)).body.status).toBe('RUNNING');
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'FAILED' } }); // leave nothing in flight for the next test
    });

    it('counts paused runs against the tenant limit', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await start(t, wf.id, { topic: `T${i}` }).expect(201)).body.id);
      expect((await start(t, wf.id, { topic: 'six' }).expect(429)).body.code).toBe('RUN_LIMIT_REACHED');
      await until(t, ids[0]!, 'WAITING_APPROVAL');
      await op(t, ids[0]!, 'pause').expect(200);
      await start(t, wf.id, { topic: 'still full' }).expect(429);
    });
  });

  // ─── failure handling: dead letters, retry, unknown outcomes ──────────────────
  describe('dead letters and recovery', () => {
    it('lists failed runs, retries them safely, and asks for a new approval before any outward step', async () => {
      const t = await h.tenant('Café Awa');
      const admin = await h.member(t, 'ADMIN');
      const editor = await h.member(t, 'EDITOR');
      const wf = await makeWorkflow(t);
      adapters.failNext('simulated.product-analysis', 1, false, 'BAD_DATA');
      const run = (await start(t, wf.id).expect(201)).body as RunView;
      const failed = await until(t, run.id, 'FAILED');
      expect(failed).toMatchObject({ errorCode: 'BAD_DATA' });
      expect(failed.deadLetteredAt).toBeTruthy();
      const dead = (await request(http).get('/api/v1/runs?deadLettered=true').set(as(t)).expect(200)).body;
      expect(dead.items.map((r: { id: string }) => r.id)).toEqual([run.id]);
      await op(editor, run.id, 'retry').expect(403);
      await op(admin, run.id, 'retry').expect(200);
      const waiting = await until(t, run.id, 'WAITING_APPROVAL');
      expect(waiting.deadLetteredAt).toBeNull();
      expect(step(waiting, 'product_analysis')).toMatchObject({ status: 'COMPLETED', attempts: 1 }); // started over
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      await op(admin, run.id, 'retry').expect(409); // no longer failed
      expect((await request(http).get('/api/v1/runs?deadLettered=true').set(as(t)).expect(200)).body.total).toBe(0);
      await approve(admin, run.id).expect(200);
      await until(t, run.id, 'COMPLETED');
      expect(adapters.calls['simulated.calendar-schedule']).toBe(1);
      const types = (await request(http).get(`/api/v1/runs/${run.id}/events`).set(as(t)).expect(200)).body.map((e: { type: string }) => e.type);
      expect(types).toContain('run.retried');
    });

    it('a rejected approval can be retried, but only with a new approval', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t);
      const run = (await start(t, wf.id).expect(201)).body as RunView;
      await until(t, run.id, 'WAITING_APPROVAL');
      await request(http).post(`/api/v1/runs/${run.id}/steps/calendar_schedule/reject`).set(as(t)).expect(200);
      expect((await getRun(t, run.id).expect(200)).body).toMatchObject({ status: 'FAILED', errorCode: 'APPROVAL_REJECTED' });
      await op(t, run.id, 'retry').expect(200);
      const waiting = await until(t, run.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'calendar_schedule')).toMatchObject({ status: 'WAITING_APPROVAL', approvalDecision: null });
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
    });

    it('never retries or re-runs an outward step with an unknown outcome: a person resolves it first', async () => {
      const t = await h.tenant('Café Awa');
      const me = await userId(t.userEmail);
      const old = new Date(Date.now() - 10 * 60_000);
      const stuck = () => plant(t.businessId, me, [
        { key: 'draft', adapter: 'simulated.content-draft', status: 'COMPLETED' },
        { key: 'calendar_schedule', adapter: 'simulated.calendar-schedule', dependsOn: ['draft'], status: 'RUNNING', requiresApproval: true, approved: true, attempts: 1, startedAt: old },
      ]);

      // Not executed: the step needs a NEW approval, then runs once.
      const a = await stuck();
      expect(await runs.reconcile()).toMatchObject({ failed: 1 });
      const failedA = (await getRun(t, a.id).expect(200)).body as RunView;
      expect(failedA).toMatchObject({ status: 'FAILED', errorCode: 'OUTCOME_UNKNOWN' });
      expect(failedA.deadLetteredAt).toBeTruthy();
      expect((await op(t, a.id, 'retry').expect(409)).body.code).toBe('OUTCOME_UNKNOWN_UNRESOLVED');
      await request(http).post(`/api/v1/runs/${a.id}/steps/draft/resolve`).set(as(t)).send({ resolution: 'EXECUTED' }).expect(409); // only an unknown outcome can be resolved
      await request(http).post(`/api/v1/runs/${a.id}/steps/calendar_schedule/resolve`).set(as(t)).send({ resolution: 'MAYBE' }).expect(400);
      await request(http).post(`/api/v1/runs/${a.id}/steps/calendar_schedule/resolve`).set(as(t)).send({ resolution: 'NOT_EXECUTED' }).expect(200);
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      await op(t, a.id, 'retry').expect(200);
      const waitingA = await until(t, a.id, 'WAITING_APPROVAL');
      expect(step(waitingA, 'calendar_schedule')).toMatchObject({ status: 'WAITING_APPROVAL', approvalDecision: null });
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      await approve(t, a.id).expect(200);
      await until(t, a.id, 'COMPLETED');
      expect(adapters.calls['simulated.calendar-schedule']).toBe(1);

      // Executed: the step is marked done by a person and the system never runs it.
      adapters.reset();
      const b = await stuck();
      await runs.reconcile();
      await request(http).post(`/api/v1/runs/${b.id}/steps/calendar_schedule/resolve`).set(as(t)).send({ resolution: 'EXECUTED' }).expect(200);
      await op(t, b.id, 'retry').expect(200);
      const doneB = await until(t, b.id, 'COMPLETED');
      expect(step(doneB, 'calendar_schedule')).toMatchObject({ status: 'COMPLETED', output: { resolvedManually: true, outcome: 'EXECUTED' } });
      expect(adapters.calls['simulated.calendar-schedule'] ?? 0).toBe(0);
      const types = (await request(http).get(`/api/v1/runs/${b.id}/events`).set(as(t)).expect(200)).body.map((e: { type: string }) => e.type);
      expect(types).toContain('step.outcome_resolved');
    });

    it('a timeout of an outward step is an unknown outcome, never an automatic retry', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t);
      adapters.slowNext('simulated.calendar-schedule', 1500, 1); // longer than ORCHESTRATOR_STEP_TIMEOUT_MS in the test environment
      const run = (await start(t, wf.id).expect(201)).body as RunView;
      await until(t, run.id, 'WAITING_APPROVAL');
      await approve(t, run.id).expect(200);
      const failed = await until(t, run.id, 'FAILED', 15_000);
      expect(failed.errorCode).toBe('OUTCOME_UNKNOWN');
      expect(step(failed, 'calendar_schedule')).toMatchObject({ status: 'FAILED', attempts: 1, errorCode: 'OUTCOME_UNKNOWN' });
      await sleep(300);
      expect(adapters.calls['simulated.calendar-schedule']).toBe(1);
    });

    it('fails a workflow run when the person it runs as is no longer allowed to use AI', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t, INTERNAL({ triggers: [{ type: 'schedule', everyMinutes: 1 }] }));
      const outsider = await register(app);
      await prisma.workflowDefinition.update({ where: { id: wf.id }, data: { activatedById: await userId(outsider.email), nextRunAt: new Date(Date.now() - 1000) } });
      expect((await workflows.runDueSchedules()).started).toBe(1);
      const created = await prisma.agentRun.findFirstOrThrow({ where: { workflowId: wf.id } });
      expect((await until(t, created.id, 'FAILED')).errorCode).toBe('REQUESTER_NOT_ALLOWED');
      expect(adapters.calls['simulated.product-analysis'] ?? 0).toBe(0);
    });
  });

  // ─── worker restart ───────────────────────────────────────────────────────────
  describe('worker restart', () => {
    it('keeps queued work while the worker is down and finishes it, without duplicates, after it comes back', async () => {
      const t = await h.tenant('Café Awa');
      const wf = await makeWorkflow(t);
      const worker = app.get(RunsWorkerService);
      await worker.onApplicationShutdown(); // the worker process stops
      let run: RunView;
      try {
        run = (await start(t, wf.id).expect(201)).body as RunView;
        await sleep(700);
        expect((await getRun(t, run.id).expect(200)).body.status).toBe('PENDING'); // accepted and stored, not executed
        expect(adapters.calls['simulated.product-analysis'] ?? 0).toBe(0);
      } finally {
        await worker.start(); // the worker process comes back
      }
      const waiting = await until(t, run.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'product_analysis').attempts).toBe(1);
      expect(adapters.calls).toEqual({ 'simulated.product-analysis': 1, 'simulated.content-draft': 1 });
      await approve(t, run.id).expect(200);
      await until(t, run.id, 'COMPLETED');
      expect(adapters.calls['simulated.calendar-schedule']).toBe(1);
    });
  });
});
