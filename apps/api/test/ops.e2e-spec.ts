import type { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { bullConnection } from '../src/ai/ai-queue';
import { OPS_QUEUE_NAMES, OpsService, type QueueReading } from '../src/admin/ops.service';
import { APP_ENV, type AppEnv } from '../src/config';
import { REDIS } from '../src/health/redis.provider';
import { aiHelpers, as } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * Operations control center (Phase N6), vertical slice: real BullMQ job counts → sampled history → authenticated platform
 * endpoints → one configurable queue-failure alert with deduplication, acknowledgement and resolution.
 */
describe('Operations control center (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let ops: OpsService;
  let superAdmin: { token: string; id: string };
  let support: { token: string; id: string };
  let n = 0;

  const get = (c: { token: string }, path: string) => request(http).get(`/api/v1/admin/ops${path}`).set(as({ token: c.token, businessId: '' }));
  const send = (m: 'post' | 'put', c: { token: string }, path: string, body?: object) => request(http)[m](`/api/v1/admin/ops${path}`).set(as({ token: c.token, businessId: '' })).send(body ?? {});
  async function admin(role: 'SUPER_ADMIN' | 'SUPPORT') {
    const u = await register(app);
    await prisma.user.update({ where: { email: u.email }, data: { platformRole: role } });
    return { token: u.accessToken as string, id: (await prisma.user.findUniqueOrThrow({ where: { email: u.email } })).id };
  }
  /** Replaces what BullMQ reports: the alert logic is tested against exact numbers, the aggregation against real jobs. */
  const fakeCounts = (failedByQueue: Record<string, number | null>) =>
    jest.spyOn(ops, 'readCounts').mockImplementation(async () =>
      OPS_QUEUE_NAMES.map((queue): QueueReading => (failedByQueue[queue] === null ? { queue, source: 'unavailable', counts: null, reason: 'unreachable' } : { queue, source: 'measured', counts: { waiting: 0, active: 0, delayed: 0, failed: failedByQueue[queue] ?? 0, completed: 0 } })));
  const AI = OPS_QUEUE_NAMES[0]!;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
    ops = app.get(OpsService);
    superAdmin = await admin('SUPER_ADMIN');
    support = await admin('SUPPORT');
  });
  beforeEach(async () => {
    await prisma.opsAlert.deleteMany();
    await prisma.opsAlertRule.deleteMany();
    await prisma.opsQueueSample.deleteMany();
    await prisma.notification.deleteMany({ where: { type: 'ops.queue_failed' } });
    await app.get(REDIS).del('touma:ops:collect-lock');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('authorization and tenant isolation', () => {
    it('refuses anonymous callers and tenant users; support reads but cannot change anything', async () => {
      await request(http).get('/api/v1/admin/ops/overview').expect(401);
      const h = aiHelpers(app);
      const t = await h.tenant(`Shop ${++n}`); // an OWNER of a business is still not a platform administrator
      for (const path of ['/overview', '/queues/history', '/alert-rules', '/alerts']) await get({ token: t.token }, path).expect(403);
      await send('post', { token: t.token }, '/collect').expect(403);
      await send('put', { token: t.token }, '/alert-rules', { threshold: 1 }).expect(403);

      for (const path of ['/overview', '/queues/history', '/alert-rules', '/alerts']) await get(support, path).expect(200);
      await send('post', support, '/collect').expect(403);
      await send('put', support, '/alert-rules', { threshold: 1 }).expect(403);
      await send('post', support, '/alerts/x/acknowledge').expect(403);
      await send('post', support, '/alerts/x/resolve').expect(403);
    });

    it('re-reads the role on every request: a demoted administrator loses access at once', async () => {
      const tmp = await admin('SUPER_ADMIN');
      await get(tmp, '/overview').expect(200);
      await prisma.user.update({ where: { id: tmp.id }, data: { platformRole: 'USER' } });
      await get(tmp, '/overview').expect(403);
    });

    it('exposes queue names and counts only: no tenant content, identifiers or secrets; tenant members never get ops notifications', async () => {
      const h = aiHelpers(app);
      const t = await h.tenant('Secret Shop Name');
      fakeCounts({ [AI]: 50 });
      await send('post', superAdmin, '/collect').expect(201);
      const all = JSON.stringify([(await get(superAdmin, '/overview')).body, (await get(superAdmin, '/queues/history')).body, (await get(superAdmin, '/alerts')).body, (await get(superAdmin, '/alert-rules')).body]);
      expect(all).not.toContain(t.businessId);
      expect(all).not.toContain('Secret Shop Name');
      expect(all).not.toMatch(/redis:\/\/|password|secret|token/i);
      const owner = await prisma.membership.findFirstOrThrow({ where: { businessId: t.businessId } });
      expect(await prisma.notification.count({ where: { userId: owner.userId, type: 'ops.queue_failed' } })).toBe(0);
      expect(await prisma.notification.count({ where: { type: 'ops.queue_failed', businessId: { not: null } } })).toBe(0);
    });
  });

  describe('metrics', () => {
    it('aggregates the real BullMQ job counts of a queue and labels them as measured', async () => {
      const q = new Queue('touma.calendar', { connection: bullConnection(app.get<AppEnv>(APP_ENV)) });
      try {
        await q.add('probe', {}, { delay: 3_600_000 });
        await q.add('probe', {}, { delay: 3_600_000 });
        const direct = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        const res = (await send('post', superAdmin, '/collect').expect(201)).body;
        expect(res).toMatchObject({ sampled: 5, unavailable: 0 });
        const hist = (await get(superAdmin, '/queues/history?queue=touma.calendar').expect(200)).body;
        expect(hist.items).toHaveLength(1);
        expect(hist.items[0]).toMatchObject({ queue: 'touma.calendar', delayed: direct.delayed, failed: direct.failed, waiting: direct.waiting, active: direct.active });
        expect(hist.items[0].delayed).toBeGreaterThanOrEqual(2);
        const ov = (await get(superAdmin, '/overview').expect(200)).body;
        expect(ov).toMatchObject({ dataSource: 'measured', database: { state: 'up', source: 'measured' }, redis: { state: 'up' } });
        expect(ov.queues).toHaveLength(5);
        const cal = ov.queues.find((x: { queue: string }) => x.queue === 'touma.calendar');
        expect(cal).toMatchObject({ source: 'measured', counts: { delayed: direct.delayed } });
        expect(cal.worker.state).toMatch(/up|stale|unknown/);
        expect(new Date(ov.capturedAt).toISOString()).toBe(ov.capturedAt); // UTC ISO timestamps
      } finally {
        await q.drain(true);
        await q.close();
      }
    });

    it('reads worker heartbeats: fresh is up, old is stale, absent is unknown', async () => {
      const redis = app.get(REDIS);
      await redis.set('touma:worker:heartbeat', String(Date.now() - 600_000), 'EX', 60);
      await redis.del('touma:calendar-worker:heartbeat');
      await redis.set('touma:ai-worker:heartbeat', String(Date.now()), 'EX', 60);
      const ov = (await get(superAdmin, '/overview').expect(200)).body;
      expect(ov.maintenanceWorker.state).toBe('stale');
      expect(ov.queues.find((x: { queue: string }) => x.queue === 'touma.calendar').worker).toEqual({ state: 'unknown', lastHeartbeat: null });
      expect(ov.queues.find((x: { queue: string }) => x.queue === AI).worker.state).toBe('up');
      await redis.del('touma:worker:heartbeat', 'touma:ai-worker:heartbeat');
    });

    it('missing telemetry is reported as unavailable, never as zero, and writes no sample', async () => {
      fakeCounts({ [AI]: null, 'touma.social': null, 'touma.creative': null, 'touma.calendar': null, 'touma.runs': null });
      const res = (await send('post', superAdmin, '/collect').expect(201)).body;
      expect(res).toMatchObject({ sampled: 0, unavailable: 5, alertsRaised: 0 });
      expect(await prisma.opsQueueSample.count()).toBe(0);
      const ov = (await get(superAdmin, '/overview').expect(200)).body;
      expect(ov.queues.every((x: { source: string; counts: unknown }) => x.source === 'unavailable' && x.counts === null)).toBe(true);
      expect(ov.redis.state).toBe('unavailable');
    });

    it('a failing store never breaks the caller; a second instance within the interval is skipped; samples are paginated and bounded', async () => {
      jest.spyOn(prisma.opsQueueSample, 'count'); // (the app uses its own client: the failure below is injected through the service)
      const spy = jest.spyOn((ops as unknown as { prisma: typeof prisma }).prisma.opsQueueSample, 'createMany').mockRejectedValueOnce(new Error('db down'));
      const r = await ops.collect({ force: true });
      expect(r).toMatchObject({ sampled: 0 }); // contained
      spy.mockRestore();
      expect((await ops.collect()).skipped).toBeUndefined();
      expect((await ops.collect()).skipped).toBe('locked');

      await prisma.opsQueueSample.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ queue: AI, capturedAt: new Date(Date.now() - 30 * 86_400_000 - i * 1000), waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 })) });
      await ops.collect({ force: true });
      expect(await prisma.opsQueueSample.count({ where: { capturedAt: { lt: new Date(Date.now() - 8 * 86_400_000) } } })).toBe(0); // retention (7 days)
      for (let i = 0; i < 4; i++) await ops.collect({ force: true });
      const p1 = (await get(superAdmin, '/queues/history?queue=touma.ai&hours=24&pageSize=2&page=1').expect(200)).body;
      expect(p1).toMatchObject({ pageSize: 2, items: expect.any(Array) });
      expect(p1.items).toHaveLength(2);
      expect(p1.pageCount).toBe(Math.ceil(p1.total / 2));
      await get(superAdmin, '/queues/history?pageSize=1000').expect(400);
      await get(superAdmin, '/queues/history?queue=touma.unknown').expect(400);
      await get(superAdmin, '/queues/history?hours=999').expect(400);
    });
  });

  describe('queue failure alert', () => {
    it('raises one alert for a lasting condition, counts occurrences, notifies each administrator once and allows acknowledgement and resolution', async () => {
      fakeCounts({ [AI]: 12 }); // default threshold: 10 failed jobs
      expect((await ops.collect({ force: true })).alertsRaised).toBe(1);
      expect((await ops.collect({ force: true })).alertsRaised).toBe(0);
      await ops.collect({ force: true });
      const list = (await get(superAdmin, '/alerts?status=OPEN').expect(200)).body;
      expect(list.total).toBe(1);
      expect(list.items[0]).toMatchObject({ queue: AI, status: 'OPEN', observed: 12, threshold: 10, occurrences: 3 });
      const admins = await prisma.user.count({ where: { platformRole: { in: ['SUPER_ADMIN', 'SUPPORT'] } } });
      expect(await prisma.notification.count({ where: { type: 'ops.queue_failed' } })).toBe(admins); // once per administrator, not per sample
      expect((await prisma.notification.findFirstOrThrow({ where: { type: 'ops.queue_failed' } })).businessId).toBeNull();

      const id = list.items[0].id;
      expect((await send('post', superAdmin, `/alerts/${id}/acknowledge`).expect(201)).body).toMatchObject({ status: 'ACKNOWLEDGED' });
      await send('post', superAdmin, `/alerts/${id}/acknowledge`).expect(409);
      await ops.collect({ force: true }); // an acknowledged alert is still the same alert
      expect(await prisma.opsAlert.count()).toBe(1);
      expect((await prisma.opsAlert.findUniqueOrThrow({ where: { id } })).occurrences).toBe(4);

      expect((await send('post', superAdmin, `/alerts/${id}/resolve`, { note: 'Restarted the worker' }).expect(201)).body).toMatchObject({ status: 'RESOLVED', resolution: 'Restarted the worker' });
      await send('post', superAdmin, `/alerts/${id}/resolve`).expect(409);
      await send('post', superAdmin, '/alerts/unknown/resolve').expect(404);
      await send('post', superAdmin, `/alerts/${id}/resolve`, { note: 'x'.repeat(301) }).expect(400);
      expect(await prisma.auditLog.count({ where: { action: { in: ['admin.ops_alert_ack', 'admin.ops_alert_resolve'] }, actorId: superAdmin.id } })).toBe(2);

      await ops.collect({ force: true }); // the condition still holds after a manual resolution: a new alert, notified again
      expect(await prisma.opsAlert.count()).toBe(2);
      expect(await prisma.opsAlert.count({ where: { status: 'OPEN' } })).toBe(1);
    });

    it('clears itself when the queue recovers, leaves alerts untouched when telemetry is missing, and fires again on a new incident', async () => {
      fakeCounts({ [AI]: 12 });
      await ops.collect({ force: true });
      fakeCounts({ [AI]: null });
      await ops.collect({ force: true });
      expect((await prisma.opsAlert.findFirstOrThrow()).status).toBe('OPEN'); // unknown is not "recovered"
      fakeCounts({ [AI]: 3 });
      await ops.collect({ force: true });
      expect(await prisma.opsAlert.findFirstOrThrow()).toMatchObject({ status: 'RESOLVED', resolution: 'CLEARED', dedupeKey: null });
      fakeCounts({ [AI]: 20 });
      expect((await ops.collect({ force: true })).alertsRaised).toBe(1);
      expect(await prisma.opsAlert.count()).toBe(2);
    });

    it('is configurable: a queue rule overrides the default, can be disabled, and is validated and audited', async () => {
      await get(superAdmin, '/alert-rules').expect(200); // creates the default rule
      expect((await get(superAdmin, '/alert-rules')).body.items).toEqual([expect.objectContaining({ queue: null, threshold: 10, enabled: true })]);
      const rule = (await send('put', superAdmin, '/alert-rules', { queue: AI, threshold: 50 }).expect(200)).body;
      expect(rule).toMatchObject({ queue: AI, threshold: 50, enabled: true });
      fakeCounts({ [AI]: 12, 'touma.social': 12 });
      await ops.collect({ force: true });
      const open = await prisma.opsAlert.findMany({ where: { status: 'OPEN' } });
      expect(open.map((a) => a.queue)).toEqual(['touma.social']); // ai: 12 < 50; social uses the default (10)
      await send('put', superAdmin, '/alert-rules', { queue: null, threshold: 10, enabled: false }).expect(200);
      await ops.collect({ force: true });
      expect(await prisma.opsAlert.count({ where: { status: 'OPEN' } })).toBe(0); // disabled: no stale alert stays open

      await send('put', superAdmin, '/alert-rules', { queue: 'touma.nope', threshold: 5 }).expect(400);
      await send('put', superAdmin, '/alert-rules', { threshold: 0 }).expect(400);
      await send('put', superAdmin, '/alert-rules', { threshold: 5, extra: 1 }).expect(400);
      expect(await prisma.auditLog.count({ where: { action: 'admin.ops_rule_set', actorId: superAdmin.id } })).toBe(2);
    });

    it('two simultaneous collections still produce a single alert', async () => {
      fakeCounts({ [AI]: 30 });
      await Promise.all([ops.collect({ force: true }), ops.collect({ force: true }), ops.collect({ force: true })]);
      expect(await prisma.opsAlert.count()).toBe(1);
      expect((await prisma.opsAlert.findFirstOrThrow()).occurrences).toBeGreaterThanOrEqual(1);
      expect(await prisma.notification.count({ where: { type: 'ops.queue_failed', userId: superAdmin.id } })).toBe(1);
    });
  });
});
