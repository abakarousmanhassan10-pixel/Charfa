import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as } from './ai-helpers';
import { creativeHelpers } from './creative-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/** Passage au réel (prepared, nothing enabled): a platform-wide monthly spending cap across ALL clients, and a secret-free go-live report for platform administrators. */
const CAP = '100000'; // micro-USD: with the test price of 0.04 USD per image (40 000), two images fit and a third does not
const ENV: Record<string, string> = { CREATIVE_PLATFORM_MONTHLY_CAP_MICROS: CAP, CREATIVE_DAILY_IMAGES_PER_BUSINESS: '5', CREATIVE_RATE_LIMIT_PER_MINUTE: '1000', CREATIVE_MAX_INFLIGHT_PER_BUSINESS: '50' };

describe('go-live guard (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let n = 0;
  const tenant = () => h.tenant(`Cap ${++n}`);
  const admin = async (role: 'SUPER_ADMIN' | 'SUPPORT' | 'USER') => {
    const u = await register(app);
    await prisma.user.update({ where: { email: u.email }, data: { platformRole: role } });
    return { token: u.accessToken as string, businessId: '' };
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('the platform cap is shared by every client: once the money of the month is spent, another client is refused, with no totals revealed', async () => {
    const a = await tenant();
    const b = await tenant();
    for (let i = 0; i < 2; i++) await h.finished(a, (await h.submitImage(a).expect(202)).body.id); // 2 x 40 000 = 80 000 of 100 000
    const refused = await h.submitImage(b).expect(402);
    expect(refused.body.code).toBe('CREATIVE_PLATFORM_CAP_REACHED');
    expect(refused.body.usage).toBeUndefined(); // a client never learns the platform's spend
    expect(refused.body.message).not.toMatch(/\d{4,}|spent|cap/i);
    expect(await prisma.creativeGeneration.count({ where: { businessId: b.businessId } })).toBe(0); // nothing queued, nothing reserved
    const q = (await request(h.http).get('/api/v1/creative/quota').set(as(b)).expect(200)).body;
    expect(q.images).toMatchObject({ used: 0, reserved: 0 });
  });

  it('simultaneous requests from several clients can never exceed the platform cap', async () => {
    await prisma.creativeGeneration.deleteMany({}); // a clean month for this test
    const ts = await Promise.all([tenant(), tenant(), tenant()]);
    const results = await Promise.all(ts.flatMap((t) => [h.submitImage(t), h.submitImage(t)]));
    const ok = results.filter((r) => r.status === 202);
    expect(ok.length).toBe(2); // 3 x 40 000 would be 120 000 > 100 000
    expect(results.filter((r) => r.status === 402).every((r) => r.body.code === 'CREATIVE_PLATFORM_CAP_REACHED')).toBe(true);
    const spent = await prisma.creativeGeneration.aggregate({ _sum: { estimatedCostMicros: true } });
    expect(Number(spent._sum.estimatedCostMicros ?? 0n) + 0).toBeLessThanOrEqual(100000);
  });

  it('the go-live report is for platform administrators only and never contains a secret', async () => {
    const user = await admin('USER');
    const support = await admin('SUPPORT');
    const root = await admin('SUPER_ADMIN');
    await request(h.http).get('/api/v1/admin/go-live').set(as(user)).expect(403);
    await request(h.http).get('/api/v1/admin/go-live').expect(401);
    for (const who of [support, root]) {
      const r = (await request(h.http).get('/api/v1/admin/go-live').set(as(who)).expect(200)).body;
      expect({ overall: r.overall, blockers: r.blockers, modes: r.capabilities.map((c: { id: string; mode: string }) => `${c.id}:${c.mode}`) }).toMatchObject({ overall: 'SIMULATION' });
      expect(r.capabilities.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['ai-text', 'creative-images', 'creative-videos', 'social-publishing', 'billing', 'storage', 'email', 'environment']));
      expect(r.capabilities.find((c: { id: string }) => c.id === 'creative-images')).toMatchObject({ mode: 'simulated' });
      const text = JSON.stringify(r);
      for (const secret of [process.env.JWT_ACCESS_SECRET, process.env.JWT_REFRESH_SECRET, process.env.TOKEN_ENCRYPTION_KEY, process.env.DATABASE_URL]) if (secret) expect(text).not.toContain(secret);
    }
  });
});
