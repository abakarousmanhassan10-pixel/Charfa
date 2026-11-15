import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CreativeProviderError, FakeImageProvider } from '@touma/creative';
import { CreativeQueueService } from '../src/creative/creative-queue';
import { IMAGE_PROVIDER, VIDEO_PROVIDER } from '../src/creative/creative-providers';
import { CreativeUsageService } from '../src/creative/creative-usage.service';
import { CreativeWorkerService } from '../src/creative/creative-worker.service';
import { as, type Ctx } from './ai-helpers';
import { creativeHelpers } from './creative-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/** N26: 5 advertising images and 5 advertising videos per client and per local day, separate, shared by the whole business, reserved atomically and counted on delivery. Simulated providers only. */
const ENV: Record<string, string> = { CREATIVE_DAILY_IMAGES_PER_BUSINESS: '5', CREATIVE_DAILY_VIDEOS_PER_BUSINESS: '5', CREATIVE_RATE_LIMIT_PER_MINUTE: '1000', CREATIVE_MAX_INFLIGHT_PER_BUSINESS: '50', CREATIVE_RESERVATION_TTL_MINUTES: '5' };
const DAY = 86_400_000;

describe('Creative Studio: daily advertising quotas (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let usage: CreativeUsageService;
  let worker: CreativeWorkerService;
  let queue: CreativeQueueService;
  let image: FakeImageProvider;
  let n = 0;
  const tenant = () => h.tenant(`Quota ${++n}`);
  const quota = async (c: Ctx) => (await request(h.http).get('/api/v1/creative/quota').set(as(c)).expect(200)).body;
  const gen = async (c: Ctx, body: Record<string, unknown> = {}) => h.finished(c, (await h.submitImage(c, body).expect(202)).body.id);
  const vid = async (c: Ctx, body: Record<string, unknown> = {}) => h.finished(c, (await h.submitVideo(c, body).expect(202)).body.id);
  const q = () => queue as unknown as { q: { pause(): Promise<void>; resume(): Promise<void> } };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
    usage = app.get(CreativeUsageService);
    worker = app.get(CreativeWorkerService);
    queue = app.get(CreativeQueueService);
    image = app.get(IMAGE_PROVIDER) as FakeImageProvider;
    app.get(VIDEO_PROVIDER);
  });
  beforeEach(() => image.reset());
  afterAll(async () => { await q().q.resume().catch(() => undefined); await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('starts at 0/5 for images and 0/5 for videos with the next reset; a normal generation consumes one credit', async () => {
    const t = await tenant();
    const s0 = await quota(t);
    expect(s0).toMatchObject({ images: { used: 0, limit: 5, remaining: 5 }, videos: { used: 0, limit: 5, remaining: 5 }, timezone: expect.any(String) });
    expect(new Date(s0.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(s0.resetsAt).getTime() - Date.now()).toBeLessThanOrEqual(DAY + 3_600_000);
    await gen(t);
    await vid(t);
    expect(await quota(t)).toMatchObject({ images: { used: 1, remaining: 4, completed: 1, reserved: 0 }, videos: { used: 1, remaining: 4 } });
    // The same figures are in the studio status.
    expect((await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200)).body.daily.images.used).toBe(1);
  });

  it('the limit blocks new generations with the clear message and the reset time; images and videos are separate and not interchangeable', async () => {
    const t = await tenant();
    for (let i = 0; i < 5; i++) await gen(t);
    const blocked = await h.submitImage(t).expect(429);
    expect(blocked.body).toMatchObject({ code: 'CREATIVE_DAILY_LIMIT', usage: { kind: 'IMAGE', limit: 5, used: 5 } });
    expect(blocked.body.usage.resetsAt).toBeTruthy();
    expect(blocked.body.message).toMatch(/used all your image creations available today/);
    expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(5); // nothing was created or queued
    // Videos are untouched by exhausted images, and vice versa.
    await vid(t);
    expect(await quota(t)).toMatchObject({ images: { remaining: 0 }, videos: { used: 1, remaining: 4 } });
    for (let i = 0; i < 4; i++) await vid(t);
    await h.submitVideo(t).expect(429).expect((r) => expect(r.body).toMatchObject({ code: 'CREATIVE_DAILY_LIMIT', usage: { kind: 'VIDEO' } }));
  });

  it('a generation of several media consumes one credit per delivered image; a request that does not fit is refused whole', async () => {
    const t = await tenant();
    const g = await gen(t, { count: 3 });
    expect(g.outputs).toHaveLength(3);
    expect((await quota(t)).images).toMatchObject({ used: 3, remaining: 2 });
    await h.submitImage(t, { count: 3 }).expect(429);
    expect((await quota(t)).images.used).toBe(3); // the refused request held nothing
    await gen(t, { count: 2 });
    expect((await quota(t)).images).toMatchObject({ used: 5, remaining: 0 });
    // A video is one credit whatever its length.
    await vid(t, { seconds: 12 });
    expect((await quota(t)).videos.used).toBe(1);
  });

  it('simultaneous requests can never exceed the limit: 8 parallel image requests, exactly 5 accepted', async () => {
    const t = await tenant();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.submitImage(t)));
    expect(results.filter((r) => r.status === 202)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 202)) await h.finished(t, r.body.id);
    expect((await quota(t)).images).toMatchObject({ used: 5, completed: 5, reserved: 0 });
    // Users and agents of the same business share one quota: a second member cannot add credits.
    const member = await h.member(t, 'EDITOR');
    await h.submitImage(member).expect(429);
  });

  it('a provider failure gives the credits back; a partial delivery counts only what was delivered; a retry never counts twice', async () => {
    const t = await tenant();
    image.enqueue(new CreativeProviderError('bad_request', 'rejected', 400));
    const failed = await gen(t, { count: 2 });
    expect(failed.status).toBe('FAILED');
    expect((await quota(t)).images).toMatchObject({ used: 0, remaining: 5, reserved: 0 });
    // Transient errors then success: three provider attempts, two credits, counted once.
    image.reset();
    image.enqueue(new CreativeProviderError('rate_limit', 'busy', 429), new CreativeProviderError('server', 'down', 503));
    const ok = await gen(t, { count: 2 });
    expect(ok).toMatchObject({ status: 'SUCCEEDED', job: { attempts: 3 } });
    expect((await quota(t)).images).toMatchObject({ used: 2, completed: 2, reserved: 0 });
    // The provider returns fewer images than requested: only the delivered one is counted.
    image.reset();
    image.enqueue(async (req) => { const r = await new FakeImageProvider().generate({ ...req, count: 1 }); return r; });
    const partial = await gen(t, { count: 3 });
    expect(partial.outputs.length).toBeLessThan(3);
    expect((await quota(t)).images.used).toBe(2 + partial.outputs.length);
  });

  it('cancelling a generation that has not started releases its credits at once; a running one cannot be cancelled', async () => {
    const t = await tenant();
    await q().q.pause();
    const res = await h.submitImage(t, { count: 2 }).expect(202);
    expect((await quota(t)).images).toMatchObject({ used: 2, reserved: 2 });
    const c = (await request(h.http).post(`/api/v1/creative/generations/${res.body.id}/cancel`).set(as(t)).send({}).expect(200)).body;
    expect(c).toMatchObject({ status: 'FAILED', errorCode: 'CREATIVE_CANCELLED' });
    expect((await quota(t)).images).toMatchObject({ used: 0, remaining: 5 });
    await request(h.http).post(`/api/v1/creative/generations/${res.body.id}/cancel`).set(as(t)).send({}).expect(409);
    await q().q.resume();
    const done = await gen(t);
    await request(h.http).post(`/api/v1/creative/generations/${done.id}/cancel`).set(as(t)).send({}).expect(409); // finished
    const other = await tenant();
    await request(h.http).post(`/api/v1/creative/generations/${done.id}/cancel`).set(as(other)).send({}).expect(404);
  });

  it('an interrupted task releases its reservation after the maximum reservation time', async () => {
    const t = await tenant();
    await q().q.pause();
    const res = await h.submitImage(t, { count: 3 }).expect(202);
    expect((await quota(t)).images.reserved).toBe(3);
    await prisma.creativeGeneration.update({ where: { id: res.body.id }, data: { queuedAt: new Date(Date.now() - 10 * 60_000) } });
    expect((await worker.reconcile()).expired).toBeGreaterThanOrEqual(1);
    expect((await quota(t)).images).toMatchObject({ used: 0, reserved: 0 });
    expect((await prisma.creativeGeneration.findUniqueOrThrow({ where: { id: res.body.id } })).errorCode).toBe('RESERVATION_EXPIRED');
    await q().q.resume();
  });

  it('the quota renews at local midnight and earlier media is kept; each client resets in its own timezone', async () => {
    const t = await tenant();
    const g = await gen(t, { count: 2 });
    expect((await quota(t)).images.used).toBe(2);
    const now = new Date();
    const today = await usage.dailyStatus(t.businessId, now);
    const tomorrow = await usage.dailyStatus(t.businessId, new Date(new Date(today.resetsAt).getTime() + 60_000));
    expect(tomorrow.dayKey).not.toBe(today.dayKey);
    expect(tomorrow.images).toMatchObject({ used: 0, remaining: 5 });
    expect(await prisma.creativeOutput.count({ where: { generationId: g.id } })).toBe(2); // media is never deleted at renewal
    const justBefore = await usage.dailyStatus(t.businessId, new Date(new Date(today.resetsAt).getTime() - 60_000));
    expect(justBefore.dayKey).toBe(today.dayKey);
    expect(justBefore.images.used).toBe(2);
    // Another timezone resets at another instant.
    const far = await tenant();
    await prisma.business.update({ where: { id: far.businessId }, data: { timezone: 'Pacific/Kiritimati' } });
    const a = await usage.dailyStatus(far.businessId, now);
    const b = await usage.dailyStatus(t.businessId, now);
    if ((await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).timezone !== 'Pacific/Kiritimati') expect(a.resetsAt).not.toBe(b.resetsAt);
    expect(a.timezone).toBe('Pacific/Kiritimati');
  });

  it('changing the timezone does not buy quota: it applies at the next midnight and only once per 30 days', async () => {
    const t = await tenant();
    await prisma.business.update({ where: { id: t.businessId }, data: { timezone: 'UTC' } });
    await quota(t); // the quota clock is created on the current timezone
    for (let i = 0; i < 5; i++) await gen(t);
    await h.submitImage(t).expect(429);
    await request(h.http).patch(`/api/v1/businesses/${t.businessId}`).set(as(t)).send({ timezone: 'Pacific/Kiritimati' }).expect(200);
    await h.submitImage(t).expect(429); // still exhausted right after the change
    const s = await quota(t);
    expect(s.timezone).toBe('UTC');
    expect(s.timezoneChange).toMatchObject({ applied: false, businessTimezone: 'Pacific/Kiritimati' });
    // Even after the 30-day delay the new zone only starts at the next reset of the old one.
    await prisma.creativeQuotaClock.update({ where: { businessId: t.businessId }, data: { changedAt: new Date(Date.now() - 40 * DAY) } });
    const later = await usage.dailyStatus(t.businessId, new Date());
    expect(later.timezone).toBe('UTC');
    expect(later.timezoneChange.pendingTimezone).toBe('Pacific/Kiritimati');
    expect(later.images.used).toBe(5);
    const afterReset = await usage.dailyStatus(t.businessId, new Date(new Date(later.resetsAt).getTime() + 60_000));
    expect(afterReset.timezone).toBe('Pacific/Kiritimati');
    expect(afterReset.images.used).toBe(0);
  });

  it('other ways around the quota fail: a new idempotency key, deleting media, another request path', async () => {
    const t = await tenant();
    for (let i = 0; i < 5; i++) await gen(t);
    await h.submitImage(t, {}, '11111111-1111-4111-8111-111111111111').expect(429);
    await h.submitImage(t, {}, '22222222-2222-4222-8222-222222222222').expect(429);
    const first = await prisma.creativeGeneration.findFirstOrThrow({ where: { businessId: t.businessId } });
    await request(h.http).delete(`/api/v1/creative/generations/${first.id}`).set(as(t)).expect((r) => expect([200, 204]).toContain(r.status));
    await h.submitImage(t).expect(429); // deleting a creation does not give its credit back
    // A variation is a generation like any other.
    const done = await prisma.creativeGeneration.findFirstOrThrow({ where: { businessId: t.businessId, status: 'SUCCEEDED', NOT: { id: first.id } } });
    await request(h.http).post(`/api/v1/creative/generations/${done.id}/variations`).set(as(t)).send({ count: 1 }).expect(429);
  });

  it('clients are isolated: one business exhausting its quota does not affect another', async () => {
    const a = await tenant(); const b = await tenant();
    for (let i = 0; i < 5; i++) await gen(a);
    await h.submitImage(a).expect(429);
    expect((await quota(b)).images.used).toBe(0);
    await gen(b);
    expect((await quota(b)).images.used).toBe(1);
    expect((await quota(a)).images.used).toBe(5);
  });

  it('the money available is checked as well: free quota does not authorize a generation the budget cannot pay', async () => {
    const t = await tenant();
    // Test prices: 0.04 USD per image = 40,000 micro-USD. A 100,000 budget pays for two.
    await h.withPlan(t.businessId, { creativeBudgetMicrosPerMonth: 100_000 });
    await gen(t); await gen(t);
    const r = await h.submitImage(t).expect(402);
    expect(r.body).toMatchObject({ code: 'CREATIVE_BUDGET_EXCEEDED', usage: { budgetMicros: 100_000 } });
    expect((await quota(t)).images).toMatchObject({ used: 2, remaining: 3 }); // quota is free, money is not
    expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(2);
    // A request whose cost alone exceeds what is left is refused, not partly run.
    await h.submitImage(t, { count: 1 }).expect(402);
  });

  it('administrators change a plan\'s limits (daily images, daily videos, budget); others cannot; subscriptions follow at once', async () => {
    const t = await tenant();
    await h.withPlan(t.businessId, {});
    const admin = await register(app);
    await prisma.user.update({ where: { email: admin.email }, data: { platformRole: 'SUPER_ADMIN' } });
    const put = (c: { token?: string; accessToken?: string }, b: object) => request(h.http).put('/api/v1/admin/creative/plan-limits/STARTER').set('Authorization', `Bearer ${c.token ?? c.accessToken}`).send(b);
    await put(t, { creativeImagesPerDay: 1 }).expect(403);
    await put(admin, { creativeImagesPerDay: -1 }).expect(400);
    await put(admin, { unknown: 1 }).expect(400);
    await put(admin, {}).expect(400);
    const res = (await put(admin, { creativeImagesPerDay: 2, creativeVideosPerDay: 1 }).expect(200)).body;
    expect(res.limits).toMatchObject({ creativeImagesPerDay: 2, creativeVideosPerDay: 1 });
    expect(await quota(t)).toMatchObject({ images: { limit: 2 }, videos: { limit: 1 } });
    await gen(t, { count: 2 });
    await h.submitImage(t).expect(429);
    await vid(t);
    await h.submitVideo(t).expect(429);
    expect(await prisma.auditLog.count({ where: { action: 'creative.plan_limits_changed' } })).toBeGreaterThanOrEqual(1);
    await put(admin, { creativeImagesPerDay: 5, creativeVideosPerDay: 5 }).expect(200);
  });
});
