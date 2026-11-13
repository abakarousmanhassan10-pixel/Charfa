import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { STRONG_PASSWORD, prisma, register, resetDb, startApp } from './helpers';

/**
 * Phase N8, end to end across modules with local fixtures and simulated providers (no model, no network):
 * login → product (catalog) → workflow run (analysis → draft → human approval → calendar step) → execution status →
 * control center. The calendar step is a simulation in this codebase: the test asserts that honestly.
 */
describe('Cross-module scenario (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let platform: { token: string };

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
    const u = await register(app);
    await prisma.user.update({ where: { email: u.email }, data: { platformRole: 'SUPER_ADMIN' } });
    platform = { token: u.accessToken };
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const DEF = {
    triggers: [{ type: 'manual' }],
    input: { topic: { type: 'string', required: true, maxLength: 200 } },
    steps: [
      { key: 'product_analysis', adapter: 'simulated.product-analysis' },
      { key: 'content_draft', adapter: 'simulated.content-draft', dependsOn: ['product_analysis'] },
      { key: 'calendar_schedule', adapter: 'simulated.calendar-schedule', dependsOn: ['content_draft'], requiresApproval: true },
    ],
  };
  const getRun = (c: Ctx, id: string) => request(http).get(`/api/v1/runs/${id}`).set(as(c));
  async function until(c: Ctx, id: string, status: string) {
    const end = Date.now() + 10_000;
    for (;;) {
      const r = (await getRun(c, id).expect(200)).body;
      if (r.status === status) return r;
      if (Date.now() > end) throw new Error(`run ${id} is ${r.status}, expected ${status}`);
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  const ops = (m: 'get' | 'post', path: string) => request(http)[m](`/api/v1/admin/ops${path}`).set('Authorization', `Bearer ${platform.token}`);

  it('login → catalog product → analysis → draft → human approval → calendar step → status → monitoring', async () => {
    // 1. A real login (not the token returned by registration).
    const email = `n8-${Date.now()}@example.com`;
    await register(app, email);
    const login = await request(http).post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);
    const h = aiHelpers(app);
    const t = await h.tenant('Integration Shop'); // owner with a business, a catalog product and a service
    const product = await prisma.product.findFirstOrThrow({ where: { businessId: t.businessId } });
    expect(login.body.accessToken).toEqual(expect.any(String));
    expect((await request(http).get('/api/v1/users/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(200)).body.email).toBe(email);

    // 2. The workflow works on the catalog product's name; creating is not approving.
    const editor = await h.member(t, 'EDITOR');
    const admin = await h.member(t, 'ADMIN');
    const wf = (await request(http).post('/api/v1/workflows').set(as(admin)).send({ name: 'Launch', definition: DEF }).expect(201)).body;
    await request(http).post(`/api/v1/workflows/${wf.id}/activate`).set(as(admin)).expect(200);
    const key = 'n8-scenario-key-0001';
    const start = () => request(http).post(`/api/v1/workflows/${wf.id}/executions`).set(as(editor)).set('Idempotency-Key', key).send({ input: { topic: product.name } });
    const run = (await start().expect(201)).body;
    expect((await start()).body.id).toBe(run.id); // idempotency: the same key never starts a second run

    const waiting = await until(editor, run.id, 'WAITING_APPROVAL');
    const st = (r: { steps: Array<{ key: string; status: string }> }, k: string) => r.steps.find((s) => s.key === k)!;
    expect([st(waiting, 'product_analysis').status, st(waiting, 'content_draft').status, st(waiting, 'calendar_schedule').status]).toEqual(['COMPLETED', 'COMPLETED', 'WAITING_APPROVAL']);
    await request(http).post(`/api/v1/runs/${run.id}/steps/calendar_schedule/approve`).set(as(editor)).expect(403);
    await request(http).post(`/api/v1/runs/${run.id}/steps/calendar_schedule/approve`).set(as(admin)).expect(200);
    const done = await until(admin, run.id, 'COMPLETED');

    // 3. Execution status; and what the "calendar scheduling" step really did.
    expect(st(done, 'calendar_schedule')).toMatchObject({ status: 'COMPLETED', approvalDecision: 'APPROVED' });
    const out = (done.steps.find((s: { key: string }) => s.key === 'calendar_schedule') as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({ simulated: true, scheduled: false });
    expect(await prisma.calendarEvent.count({ where: { businessId: t.businessId } })).toBe(0); // NOT wired to the real calendar module

    // 4. Isolation: another business sees nothing of this run, a tenant owner is no platform administrator.
    const other = await h.tenant('Other Shop');
    await getRun(other, run.id).expect(404);
    await request(http).post(`/api/v1/runs/${run.id}/steps/calendar_schedule/approve`).set(as(other)).expect(404);
    await request(http).get('/api/v1/admin/ops/overview').set(as(admin)).expect(403);

    // 5. Monitoring: the control center measures the runs queue and the database for real.
    const collect = (await ops('post', '/collect').expect(201)).body;
    expect(collect).toMatchObject({ sampled: 5, unavailable: 0 });
    const ov = (await ops('get', '/overview').expect(200)).body;
    expect(ov).toMatchObject({ dataSource: 'measured', database: { state: 'up' }, redis: { state: 'up' }, openAlerts: 0 });
    expect(ov.queues.find((q: { queue: string }) => q.queue === 'touma.runs')).toMatchObject({ source: 'measured', counts: { failed: 0, waiting: 0 } });
    const hist = (await ops('get', '/queues/history?queue=touma.runs').expect(200)).body;
    expect(hist.items.length).toBeGreaterThanOrEqual(1);
    // Nothing the tenant typed reaches the platform view.
    expect(JSON.stringify([ov, hist])).not.toContain(product.name);
  });
});
