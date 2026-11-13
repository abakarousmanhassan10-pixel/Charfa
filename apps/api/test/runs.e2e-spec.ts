import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { SimulatedRunAdapters } from '../src/runs/run-adapters';
import { RunsService } from '../src/runs/runs.service';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * AI Orchestrator MVP: persistence, tenant isolation, RBAC, idempotency, approval gate, retries, crash recovery.
 * Real PostgreSQL, Redis and BullMQ. The adapters are the built-in simulations: no model, no external action.
 */
describe('AI Orchestrator MVP (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let adapters: SimulatedRunAdapters;
  let runs: RunsService;
  let h: ReturnType<typeof aiHelpers>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
    adapters = app.get(SimulatedRunAdapters);
    runs = app.get(RunsService);
    h = aiHelpers(app);
  });
  beforeEach(async () => {
    // Runs started by the previous test may still be executing in the background: wait until nothing is in flight before counting calls.
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await prisma.agentRun.count({ where: { status: { in: ['PENDING', 'RUNNING'] }, steps: { none: { status: 'FAILED' } } } })) > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    adapters.reset();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const body = (topic = 'Autumn launch') => ({ template: 'simulated-content-launch', input: { topic } });
  const create = (c: Ctx, b: unknown = body(), key: string = `k-${randomUUID()}`) => request(http).post('/api/v1/runs').set(as(c)).set('Idempotency-Key', key).send(b as object);
  const get = (c: Ctx, id: string) => request(http).get(`/api/v1/runs/${id}`).set(as(c));

  async function until(c: Ctx, id: string, status: string, timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await get(c, id).expect(200);
      if (r.body.status === status) return r.body;
      if (Date.now() > end) throw new Error(`run ${id} is ${r.body.status}, expected ${status}`);
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  type StepView = { key: string; status: string; attempts: number; errorCode?: string | null; approvalDecision?: string | null };
  const step = (run: { steps: StepView[] }, key: string) => run.steps.find((s) => s.key === key) as StepView;
  async function userId(email: string) {
    return (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  }
  /** A run written straight to the database, to reproduce states a crash would leave behind. */
  async function plant(businessId: string, createdById: string | null, steps: Array<{ key: string; adapter: string; dependsOn?: string[]; status: string; requiresApproval?: boolean; approved?: boolean; attempts?: number; startedAt?: Date; output?: object }>, run: { status?: 'PENDING' | 'RUNNING'; updatedAt?: Date } = {}) {
    return prisma.agentRun.create({
      data: {
        businessId, createdById, template: 'simulated-content-launch', templateVersion: 1, status: run.status ?? 'RUNNING', idempotencyKey: `plant-${randomUUID()}`, requestHash: 'x', input: { topic: 'Planted' },
        ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
        steps: { create: steps.map((s) => ({ businessId, key: s.key, adapter: s.adapter, dependsOn: s.dependsOn ?? [], status: s.status as 'PENDING', requiresApproval: s.requiresApproval ?? false, approvalDecision: s.approved ? 'APPROVED' : null, attempts: s.attempts ?? 0, maxAttempts: 3, startedAt: s.startedAt, output: s.output })) },
      },
    });
  }
  const tenMinAgo = () => new Date(Date.now() - 10 * 60_000);

  describe('access control and tenant isolation', () => {
    it('requires authentication, membership and the right permission', async () => {
      const t = await h.tenant('Café Awa');
      await request(http).post('/api/v1/runs').set('Idempotency-Key', 'k-unauth-0001').send(body()).expect(401);
      const outsider = await register(app);
      await create({ token: outsider.accessToken, businessId: t.businessId }).expect(404); // not a member: the tenant does not even exist for them
      const viewer = await h.member(t, 'VIEWER');
      await create(viewer).expect(403);
      await request(http).get('/api/v1/runs').set(as(viewer)).expect(403);
      const editor = await h.member(t, 'EDITOR');
      const created = await create(editor).expect(201);
      const waiting = await until(editor, created.body.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'publish').status).toBe('WAITING_APPROVAL');
      // Creating is not approving: an editor lacks content.approve.
      await request(http).post(`/api/v1/runs/${created.body.id}/steps/publish/approve`).set(as(editor)).expect(403);
      await request(http).post(`/api/v1/runs/${created.body.id}/steps/publish/reject`).set(as(editor)).expect(403);
      const admin = await h.member(t, 'ADMIN');
      await request(http).post(`/api/v1/runs/${created.body.id}/steps/publish/approve`).set(as(admin)).expect(200);
      await until(admin, created.body.id, 'COMPLETED');
    });

    it('never shows, changes or approves another business\'s runs', async () => {
      const a = await h.tenant('Café A');
      const b = await h.tenant('Café B');
      const r = await create(a).expect(201);
      await until(a, r.body.id, 'WAITING_APPROVAL');
      await get(b, r.body.id).expect(404);
      await request(http).get(`/api/v1/runs/${r.body.id}/events`).set(as(b)).expect(404);
      await request(http).post(`/api/v1/runs/${r.body.id}/steps/publish/approve`).set(as(b)).expect(404);
      await request(http).post(`/api/v1/runs/${r.body.id}/steps/publish/reject`).set(as(b)).expect(404);
      expect((await request(http).get('/api/v1/runs').set(as(b)).expect(200)).body.total).toBe(0);
      expect((await request(http).get('/api/v1/runs').set(as(a)).expect(200)).body.items.map((x: { id: string }) => x.id)).toContain(r.body.id);
      // A forged business header with the wrong token is refused.
      await request(http).get(`/api/v1/runs/${r.body.id}`).set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId }).expect(404);
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: r.body.id } })).businessId).toBe(a.businessId);
      expect((await prisma.agentRunStep.findMany({ where: { runId: r.body.id } })).every((s) => s.businessId === a.businessId)).toBe(true);
    });
  });

  describe('execution, approval and history', () => {
    it('runs the plan, waits for a human before the outward step, runs it once after approval, and records a clean history', async () => {
      const t = await h.tenant('Café Awa');
      const created = await create(t, body('Secret-ish launch topic 12345')).expect(201);
      expect(created.body).toMatchObject({ template: 'simulated-content-launch', status: expect.stringMatching(/PENDING|RUNNING|WAITING_APPROVAL/) });
      const waiting = await until(t, created.body.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'analyze').status).toBe('COMPLETED');
      expect(step(waiting, 'draft').status).toBe('COMPLETED');
      expect(step(waiting, 'publish').status).toBe('WAITING_APPROVAL');
      expect(adapters.calls['simulated.external-action'] ?? 0).toBe(0); // nothing outward before approval

      await request(http).post(`/api/v1/runs/${created.body.id}/steps/publish/approve`).set(as(t)).expect(200);
      // Several wake-ups racing with the worker: the step must still run exactly once.
      await Promise.all(Array.from({ length: 6 }, () => runs.advance(created.body.id)));
      const done = await until(t, created.body.id, 'COMPLETED');
      expect(step(done, 'publish')).toMatchObject({ status: 'COMPLETED', approvalDecision: 'APPROVED', attempts: 1 });
      expect(adapters.calls).toEqual({ 'simulated.analyze': 1, 'simulated.draft': 1, 'simulated.external-action': 1 });

      const events = (await request(http).get(`/api/v1/runs/${created.body.id}/events`).set(as(t)).expect(200)).body as Array<{ type: string; stepKey: string | null }>;
      const types = events.map((e) => e.type);
      for (const expected of ['run.created', 'step.started', 'step.completed', 'step.waiting_approval', 'step.approved', 'run.completed']) expect(types).toContain(expected);
      expect(types.indexOf('step.waiting_approval')).toBeLessThan(types.indexOf('step.approved'));
      // No business input in the history or the audit trail.
      expect(JSON.stringify(events)).not.toContain('Secret-ish');
      const audit = await prisma.auditLog.findMany({ where: { entityId: created.body.id } });
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['run.created', 'run.step_approved', 'run.completed']));
      expect(JSON.stringify(audit)).not.toContain('Secret-ish');
    });

    it('a second approval or approving a step that is not waiting is a 409; a rejection fails the run and the step never runs', async () => {
      const t = await h.tenant('Café Awa');
      const r = await create(t).expect(201);
      await until(t, r.body.id, 'WAITING_APPROVAL');
      await request(http).post(`/api/v1/runs/${r.body.id}/steps/analyze/approve`).set(as(t)).expect(409);
      await request(http).post(`/api/v1/runs/${r.body.id}/steps/nope/approve`).set(as(t)).expect(404);
      const rej = await request(http).post(`/api/v1/runs/${r.body.id}/steps/publish/reject`).set(as(t)).expect(200);
      expect(rej.body).toMatchObject({ status: 'FAILED', errorCode: 'APPROVAL_REJECTED' });
      expect(step(rej.body, 'publish')).toMatchObject({ status: 'FAILED', approvalDecision: 'REJECTED', errorCode: 'APPROVAL_REJECTED' });
      await request(http).post(`/api/v1/runs/${r.body.id}/steps/publish/approve`).set(as(t)).expect(409);
      await runs.advance(r.body.id);
      expect(adapters.calls['simulated.external-action'] ?? 0).toBe(0);

      const r2 = await create(t, body('Second')).expect(201);
      await until(t, r2.body.id, 'WAITING_APPROVAL');
      await request(http).post(`/api/v1/runs/${r2.body.id}/steps/publish/approve`).set(as(t)).expect(200);
      await request(http).post(`/api/v1/runs/${r2.body.id}/steps/publish/approve`).set(as(t)).expect(409);
      await until(t, r2.body.id, 'COMPLETED');
      expect(adapters.calls['simulated.external-action']).toBe(1);
    });

    it('refuses to run an outward step without a recorded approval even if the plan was tampered with', async () => {
      const t = await h.tenant('Café Awa');
      const run = await plant(t.businessId, await userId(t.userEmail), [
        { key: 'draft', adapter: 'simulated.draft', status: 'COMPLETED', output: {} },
        { key: 'publish', adapter: 'simulated.external-action', dependsOn: ['draft'], status: 'PENDING', requiresApproval: false },
      ]);
      await runs.advance(run.id);
      const after = await get(t, run.id).expect(200);
      expect(step(after.body, 'publish')).toMatchObject({ status: 'FAILED', errorCode: 'APPROVAL_REQUIRED' });
      expect(after.body.status).toBe('FAILED');
      expect(adapters.calls['simulated.external-action'] ?? 0).toBe(0);
    });

    it('lists runs with a status filter and pagination', async () => {
      const t = await h.tenant('Café Awa');
      const r = await create(t).expect(201);
      await until(t, r.body.id, 'WAITING_APPROVAL');
      const waiting = await request(http).get('/api/v1/runs?status=WAITING_APPROVAL&pageSize=1').set(as(t)).expect(200);
      expect(waiting.body).toMatchObject({ total: 1, pageSize: 1 });
      expect((await request(http).get('/api/v1/runs?status=COMPLETED').set(as(t)).expect(200)).body.total).toBe(0);
      await request(http).get('/api/v1/runs?status=BOGUS').set(as(t)).expect(400);
    });
  });

  describe('idempotency, validation and limits', () => {
    it('replays the same key and request without creating or executing anything twice', async () => {
      const t = await h.tenant('Café Awa');
      const key = `k-${randomUUID()}`;
      const first = await create(t, body(), key).expect(201);
      const again = await create(t, body(), key).expect(200);
      expect(again.body.id).toBe(first.body.id);
      await until(t, first.body.id, 'WAITING_APPROVAL');
      expect(await prisma.agentRun.count({ where: { businessId: t.businessId } })).toBe(1);
      expect(adapters.calls['simulated.analyze']).toBe(1);
      // Same key with another request is refused; the same key in another business is independent.
      expect((await create(t, body('Different'), key).expect(409)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const other = await h.tenant('Café B');
      await create(other, body(), key).expect(201);
      // Concurrent identical requests produce one run.
      const k2 = `k-${randomUUID()}`;
      const results = await Promise.all(Array.from({ length: 4 }, () => create(t, body('Race'), k2)));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    });

    it('requires a valid Idempotency-Key and strictly validated input', async () => {
      const t = await h.tenant('Café Awa');
      await request(http).post('/api/v1/runs').set(as(t)).send(body()).expect(400);
      await request(http).post('/api/v1/runs').set(as(t)).set('Idempotency-Key', 'short').send(body()).expect(400);
      await request(http).post('/api/v1/runs').set(as(t)).set('Idempotency-Key', 'has spaces in it!!').send(body()).expect(400);
      for (const bad of [
        { template: 'nope', input: { topic: 'x' } },
        { template: 'simulated-content-launch' },
        { template: 'simulated-content-launch', input: {} },
        { template: 'simulated-content-launch', input: { topic: 'a'.repeat(201) } },
        { template: 'simulated-content-launch', input: { topic: 'ok', plan: ['x'] } },
        { template: 'simulated-content-launch', input: [] },
        { template: 'simulated-content-launch', input: { topic: 'ok' }, steps: [{ adapter: 'x' }] },
      ]) await create(t, bad).expect(400);
      expect(await prisma.agentRun.count({ where: { businessId: t.businessId } })).toBe(0);
    });

    it('limits the runs a business can have in progress', async () => {
      const t = await h.tenant('Café Awa');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await create(t, body(`Topic ${i}`)).expect(201)).body.id);
      const refused = await create(t, body('One too many')).expect(429);
      expect(refused.body.code).toBe('RUN_LIMIT_REACHED');
      await until(t, ids[0]!, 'WAITING_APPROVAL');
      await request(http).post(`/api/v1/runs/${ids[0]}/steps/publish/reject`).set(as(t)).expect(200); // finishing a run frees a slot
      await create(t, body('Now fine')).expect(201);
    });
  });

  describe('retries and errors', () => {
    it('retries a transient failure with backoff and then succeeds', async () => {
      const t = await h.tenant('Café Awa');
      adapters.failNext('simulated.draft', 1, true, 'PROVIDER_BUSY');
      const r = await create(t).expect(201);
      const waiting = await until(t, r.body.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'draft')).toMatchObject({ status: 'COMPLETED', attempts: 2 });
      expect(adapters.calls['simulated.draft']).toBe(2);
      expect(adapters.calls['simulated.analyze']).toBe(1); // finished steps are not redone
      const types = (await request(http).get(`/api/v1/runs/${r.body.id}/events`).set(as(t)).expect(200)).body.map((e: { type: string }) => e.type);
      expect(types).toContain('step.retry_scheduled');
    });

    it('fails at once on a permanent error, and after the bounded number of attempts on a transient one', async () => {
      const t = await h.tenant('Café Awa');
      adapters.failNext('simulated.analyze', 1, false, 'BAD_INPUT');
      const permanent = await create(t, body('Permanent')).expect(201);
      const failed = await until(t, permanent.body.id, 'FAILED');
      expect(failed).toMatchObject({ errorCode: 'BAD_INPUT' });
      expect(step(failed, 'analyze')).toMatchObject({ status: 'FAILED', attempts: 1, errorCode: 'BAD_INPUT' });
      expect(adapters.calls['simulated.analyze']).toBe(1);
      expect(adapters.calls['simulated.draft'] ?? 0).toBe(0);

      adapters.reset();
      adapters.failNext('simulated.draft', 10, true, 'PROVIDER_BUSY');
      const exhausted = await create(t, body('Exhausted')).expect(201);
      const f2 = await until(t, exhausted.body.id, 'FAILED');
      expect(step(f2, 'draft')).toMatchObject({ status: 'FAILED', attempts: 3, errorCode: 'PROVIDER_BUSY' });
      expect(adapters.calls['simulated.draft']).toBe(3);
      expect(step(f2, 'publish').status).toBe('PENDING'); // never reached
    });

    it('treats a step that takes too long as a transient failure', async () => {
      const t = await h.tenant('Café Awa');
      adapters.slowNext('simulated.analyze', 1500, 1);
      const r = await create(t).expect(201);
      const waiting = await until(t, r.body.id, 'WAITING_APPROVAL', 15_000);
      expect(step(waiting, 'analyze')).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    });

    it('fails the run when the requesting user is no longer allowed to use AI', async () => {
      const t = await h.tenant('Café Awa');
      const outsider = await register(app);
      const run = await plant(t.businessId, await userId(outsider.email), [{ key: 'analyze', adapter: 'simulated.analyze', status: 'PENDING' }]);
      await runs.advance(run.id);
      expect((await get(t, run.id).expect(200)).body).toMatchObject({ status: 'FAILED', errorCode: 'REQUESTER_NOT_ALLOWED' });
      expect(adapters.calls['simulated.analyze'] ?? 0).toBe(0);
    });
  });

  describe('resuming after an interruption', () => {
    it('re-runs only the interrupted internal step, never the finished ones', async () => {
      const t = await h.tenant('Café Awa');
      const run = await plant(t.businessId, await userId(t.userEmail), [
        { key: 'analyze', adapter: 'simulated.analyze', status: 'COMPLETED', output: { summary: 'done' } },
        { key: 'draft', adapter: 'simulated.draft', dependsOn: ['analyze'], status: 'RUNNING', attempts: 1, startedAt: tenMinAgo() },
        { key: 'publish', adapter: 'simulated.external-action', dependsOn: ['draft'], status: 'PENDING', requiresApproval: true },
      ]);
      expect(await runs.reconcile()).toMatchObject({ recovered: 1, failed: 0 });
      const waiting = await until(t, run.id, 'WAITING_APPROVAL');
      expect(step(waiting, 'draft')).toMatchObject({ status: 'COMPLETED', attempts: 2 });
      expect(adapters.calls['simulated.analyze'] ?? 0).toBe(0);
      expect(adapters.calls['simulated.draft']).toBe(1);
      expect(adapters.calls['simulated.external-action'] ?? 0).toBe(0);
    });

    it('never re-runs an outward step after a crash: its outcome is unknown and a person must look', async () => {
      const t = await h.tenant('Café Awa');
      const run = await plant(t.businessId, await userId(t.userEmail), [
        { key: 'draft', adapter: 'simulated.draft', status: 'COMPLETED', output: {} },
        { key: 'publish', adapter: 'simulated.external-action', dependsOn: ['draft'], status: 'RUNNING', requiresApproval: true, approved: true, attempts: 1, startedAt: tenMinAgo() },
      ]);
      expect(await runs.reconcile()).toMatchObject({ failed: 1 });
      await runs.advance(run.id);
      const after = (await get(t, run.id).expect(200)).body;
      expect(after).toMatchObject({ status: 'FAILED', errorCode: 'OUTCOME_UNKNOWN' });
      expect(step(after, 'publish')).toMatchObject({ status: 'FAILED', errorCode: 'OUTCOME_UNKNOWN' });
      expect(adapters.calls['simulated.external-action'] ?? 0).toBe(0);
    });

    it('wakes a run whose queue message was lost', async () => {
      const t = await h.tenant('Café Awa');
      const run = await plant(t.businessId, await userId(t.userEmail), [
        { key: 'analyze', adapter: 'simulated.analyze', status: 'PENDING' },
        { key: 'publish', adapter: 'simulated.external-action', dependsOn: ['analyze'], status: 'PENDING', requiresApproval: true },
      ], { status: 'PENDING', updatedAt: new Date(Date.now() - 5 * 60_000) });
      expect((await runs.reconcile()).woken).toBeGreaterThanOrEqual(1);
      await until(t, run.id, 'WAITING_APPROVAL');
      expect(adapters.calls['simulated.analyze']).toBe(1);
    });
  });
});
