import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';
import { MockAnalyticsProvider } from '../src/learning/analytics-provider';
import { seedHistory } from '../src/learning/demo-history';
import { ANALYTICS_PROVIDER } from '../src/learning/performance.service';
import { PrismaService } from '../src/prisma/prisma.service';

/** N22 phase A: simulated collection and storage of metrics. Everything is simulated; nothing is sent to or read from a platform. */
const ENV: Record<string, string> = { LEARNING_ENABLED: 'true', ANALYTICS_PROVIDER: 'mock', ANALYTICS_MATURITY_HOURS: '48', LEARNING_RATE_LIMIT_PER_MINUTE: '1000' };

describe('Learning: performance analytics (simulated)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let provider: MockAnalyticsProvider;
  let n = 0;
  const api = (m: 'get' | 'post', path: string, c: Ctx) => request(h.http)[m](`/api/v1/learning/${path}`).set(as(c)).send(m === 'post' ? {} : undefined);

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    app = await startApp();
    h = socialHelpers(app);
    provider = app.get<MockAnalyticsProvider>(ANALYTICS_PROVIDER);
  });
  beforeEach(() => { provider.down = false; provider.delayHours = 24; });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  async function biz(platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' = 'INSTAGRAM') {
    const owner = await h.tenant(`Learn ${++n}`);
    const viewer = await h.member(owner, 'VIEWER');
    const account = await h.connect(owner, platform);
    return { owner, viewer, account };
  }
  const seed = (b: Awaited<ReturnType<typeof biz>>, platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', count = 30, now?: Date) => seedHistory(app.get(PrismaService), { businessId: b.owner.businessId, socialAccountId: b.account.id, platform, count, now });

  it('collects simulated statistics for 30 historical posts over several weeks, labelled simulated, with provenance', async () => {
    const b = await biz();
    await api('post', 'demo/history', b.owner).expect(201).expect((r) => expect(r.body).toEqual({ created: 30, simulated: true }));
    const sum = (await api('post', 'performance/collect', b.owner).expect(200)).body;
    expect(sum).toMatchObject({ considered: 30, collected: 30, pendingMaturity: 0, failed: 0 });
    const [ig] = (await api('get', 'performance', b.owner).expect(200)).body;
    expect(ig).toMatchObject({ platform: 'INSTAGRAM', posts: 30, evidence: 'SIMULATED', measured: 30 });
    expect(ig.metrics.likes.n).toBe(30);
    expect(ig.metrics.reach.n).toBe(30);
    expect(ig.engagementRate.n).toBe(30);
    const posts = (await api('get', 'performance/posts', b.owner).expect(200)).body;
    expect(posts).toHaveLength(30);
    expect(posts[0]).toMatchObject({ origin: 'SIMULATED', matured: true, measurement: { provider: 'mock-analytics', period: 'LIFETIME', freshness: 'FRESH' } });
    expect(posts[0].measurement.collectedAt).toBeTruthy();
    const series = (await api('get', 'performance/series', b.owner).expect(200)).body;
    expect(series.length).toBeGreaterThanOrEqual(6); // several weeks of readings
    expect(series.every((s: { origin: string }) => s.origin === 'SIMULATED')).toBe(true);
    // collecting again updates the same rows: no duplicates
    await api('post', 'performance/collect', b.owner).expect(200);
    expect(await prisma.analyticsSnapshot.count({ where: { businessId: b.owner.businessId, period: 'LIFETIME' } })).toBe(30);
  });

  it('a business with no data gets empty answers, not zeros', async () => {
    const b = await biz();
    expect((await api('get', 'performance', b.owner).expect(200)).body).toEqual([]);
    expect((await api('get', 'performance/series', b.owner).expect(200)).body).toEqual([]);
    expect((await api('post', 'performance/collect', b.owner).expect(200)).body).toMatchObject({ considered: 0, collected: 0 });
  });

  it('metrics the platform does not give stay null, never zero (TikTok: no impressions, saves or watch time)', async () => {
    const b = await biz('TIKTOK');
    await seed(b, 'TIKTOK', 6);
    await api('post', 'performance/collect', b.owner).expect(200);
    const [tt] = (await api('get', 'performance', b.owner).expect(200)).body;
    expect(tt.metrics.views.n).toBe(6);
    for (const m of ['impressions', 'saves', 'avgWatchSeconds', 'linkClicks', 'conversions']) expect(tt.metrics[m]).toEqual({ n: 0, total: null, mean: null });
    const snap = await prisma.analyticsSnapshot.findFirstOrThrow({ where: { businessId: b.owner.businessId, period: 'LIFETIME' } });
    expect(snap.saves).toBeNull();
    expect(snap.avgWatchSeconds).toBeNull();
  });

  it('delayed metrics: a post inside the maturity window is not measured; once old enough but still inside the platform delay it is stored as unavailable with the reason', async () => {
    const b = await biz();
    const now = new Date();
    await seed(b, 'INSTAGRAM', 1, new Date(now.getTime() + (-10 / 24 + 4) * 86_400_000 + 0)); // published about 4 days - 10h... adjusted below
    const pub = await prisma.publication.findFirstOrThrow({ where: { businessId: b.owner.businessId } });
    await prisma.publication.update({ where: { id: pub.id }, data: { publishedAt: new Date(now.getTime() - 10 * 3_600_000) } });
    expect(((await api('post', 'performance/collect', b.owner).expect(200)).body)).toMatchObject({ considered: 1, pendingMaturity: 1, collected: 0 });
    expect(await prisma.analyticsSnapshot.count({ where: { businessId: b.owner.businessId } })).toBe(0);
    const [p] = (await api('get', 'performance/posts', b.owner).expect(200)).body;
    expect(p).toMatchObject({ matured: false, measurement: null });
    // Mature by TOUMA's rule (48h) but the simulated platform still reports nothing (delay 5 days): unavailable, with the reason.
    await prisma.publication.update({ where: { id: pub.id }, data: { publishedAt: new Date(now.getTime() - 3 * 86_400_000) } });
    provider.delayHours = 24 * 5;
    expect((await api('post', 'performance/collect', b.owner).expect(200)).body).toMatchObject({ unavailable: 1, collected: 0 });
    const [q] = (await api('get', 'performance/posts', b.owner).expect(200)).body;
    expect(q.metrics.likes).toBeNull();
    expect(q.engagementRate).toBeNull();
    expect(q.measurement.unavailableReason).toMatch(/METRICS_DELAYED/);
    // Later the numbers arrive and replace the empty reading.
    provider.delayHours = 24;
    await api('post', 'performance/collect', b.owner).expect(200);
    const [r] = (await api('get', 'performance/posts', b.owner).expect(200)).body;
    expect(r.metrics.likes).toBeGreaterThan(0);
    expect(r.measurement.unavailableReason).toBeNull();
  });

  it('an unreachable source is recorded as unavailable (no zeros), counted as failed, and recovers on the next collection', async () => {
    const b = await biz();
    await seed(b, 'INSTAGRAM', 4);
    provider.down = true;
    expect((await api('post', 'performance/collect', b.owner).expect(200)).body).toMatchObject({ considered: 4, collected: 0, failed: 4 });
    const posts = (await api('get', 'performance/posts', b.owner).expect(200)).body;
    expect(posts.every((p: { metrics: { likes: number | null }; measurement: { unavailableReason: string } }) => p.metrics.likes === null && /transient/.test(p.measurement.unavailableReason))).toBe(true);
    provider.down = false;
    expect((await api('post', 'performance/collect', b.owner).expect(200)).body).toMatchObject({ collected: 4, failed: 0 });
  });

  it('tenant isolation and permissions: another business sees nothing; a viewer reads but cannot collect; the flag off hides the API', async () => {
    const a = await biz();
    const other = await biz();
    await seed(a, 'INSTAGRAM', 5);
    await api('post', 'performance/collect', a.owner).expect(200);
    expect((await api('get', 'performance/posts', other.owner).expect(200)).body).toEqual([]);
    expect((await api('get', 'performance', a.viewer).expect(200)).body).toHaveLength(1);
    await api('post', 'performance/collect', a.viewer).expect(403);
    await api('post', 'demo/history', a.viewer).expect(403);
    process.env.LEARNING_ENABLED = 'false';
    const app2 = await startApp();
    try { await request(app2.getHttpServer()).get('/api/v1/learning/performance').set(as(a.owner)).expect(404); } finally { await app2.close(); process.env.LEARNING_ENABLED = 'true'; }
  });
});
