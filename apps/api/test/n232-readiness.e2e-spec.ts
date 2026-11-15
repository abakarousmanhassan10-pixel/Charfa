import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SimulatedPaymentProvider } from '../src/billing/providers/simulated.provider';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * N23.2: OpenAI engine + billing readiness, together. Mock OpenAI (real SDK, built-in HTTP mock) and the simulated payment provider.
 * Server-side subscription authorization is ON here (BILLING_ENFORCEMENT_ENABLED); it is OFF by default everywhere else.
 */
const SECRET = 'n232-webhook-secret-0123456789';
const FOUNDER = 'founder-n232@example.com';
const sim = new SimulatedPaymentProvider(SECRET);

describe('OpenAI + billing readiness (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  const vars: Record<string, string> = { AI_MONTHLY_GENERATIONS_PER_BUSINESS: '300', AI_PROVIDER: 'mock-openai', AI_JOB_BACKOFF_MS: '30', BILLING_ENABLED: 'true', BILLING_ENFORCEMENT_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: SECRET, FOUNDER_EMAILS: FOUNDER };
  const run = Date.now(); // provider event ids are stored forever: unique per run
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  const code = (r: request.Response) => r.body.code ?? r.body.error?.code;
  const trial = (c: Ctx) => request(h.http).post('/api/v1/billing/trial').set(as(c)).send({ plan: 'BUSINESS' });
  const analyze = (c: Ctx, itemId: string) => request(h.http).post('/api/v1/ai/product-analysis').set(as(c)).send({ language: 'en', itemType: 'PRODUCT', itemId })
    .expect((r) => { if (r.status === 429) throw new Error(`429 ${JSON.stringify(r.body)}`); });

  beforeAll(async () => {
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    // The plan row is shared with other suites and its limits drive the AI quota: use the BUSINESS plan with explicit, generous limits.
    await prisma.plan.upsert({ where: { code: 'BUSINESS' }, update: { limits: { aiGenerationsPerMonth: 300 } }, create: { code: 'BUSINESS', name: 'BUSINESS', priceAmount: '99.00', limits: { aiGenerationsPerMonth: 300 } } });
    app = await startApp();
    h = aiHelpers(app);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('end to end: product data -> analysis -> description, labelled as simulated, with an audit trail free of secrets', async () => {
    const t = await h.tenant('Chain Shop');
    await trial(t).expect(201);
    const status = (await request(h.http).get('/api/v1/ai/status').set(as(t)).expect(200)).body;
    expect(status).toMatchObject({ configured: true, mode: 'simulated', provider: 'mock-openai' }); // what the web banner shows
    const a = await analyze(t, t.productId).expect(202);
    const analysis = (await h.settled(t, a.body.id)).body;
    expect(analysis).toMatchObject({ status: 'SUCCEEDED', provider: 'mock-openai' });
    expect(analysis.output).toBeTruthy();
    const submitted = await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId, purpose: 'EDUCATIONAL' }).expect(202);
    const description = (await h.settled(t, submitted.body.id)).body;
    expect(description).toMatchObject({ status: 'SUCCEEDED', provider: 'mock-openai' });
    // Audit: who, what, which model; never a prompt, a key or a card.
    const logs = await prisma.auditLog.findMany({ where: { businessId: t.businessId, action: { in: ['ai.generation_submitted', 'billing.trial_started'] } } });
    expect(logs.map((l) => l.action).sort()).toEqual(['ai.generation_submitted', 'ai.generation_submitted', 'billing.trial_started']);
    expect(JSON.stringify(logs)).not.toMatch(/sk-|secret|password|Bearer|\b\d{13,19}\b/i);
  });

  it('server-side authorization: no access without trial or subscription, access during the trial, none after it ends', async () => {
    const t = await h.tenant('Gate Shop');
    const before = await analyze(t, t.productId).expect(402);
    expect(code(before)).toBe('SUBSCRIPTION_REQUIRED');
    expect(await prisma.aIGeneration.count({ where: { businessId: t.businessId } })).toBe(0); // nothing queued, nothing reserved
    // The browser cannot claim access: no header, query or body field changes the decision.
    await request(h.http).post('/api/v1/ai/product-analysis').set({ ...as(t), 'X-Subscription': 'active', 'X-Plan': 'BUSINESS' }).send({ language: 'en', itemType: 'PRODUCT', itemId: t.productId }).expect(402);
    // Reading stays possible without a subscription.
    await request(h.http).get('/api/v1/ai/status').set(as(t)).expect(200);
    await request(h.http).get('/api/v1/ai/generations').set(as(t)).expect(200);

    await trial(t).expect(201);
    const ok = await analyze(t, t.productId).expect(202);
    await h.settled(t, ok.body.id);
    // Trial expiration.
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect(code(await analyze(t, t.productId).expect(402))).toBe('SUBSCRIPTION_REQUIRED');
    expect((await request(h.http).get('/api/v1/billing/status').set(as(t)).expect(200)).body.entitlement).toMatchObject({ state: 'EXPIRED', hasAccess: false });
  });

  it('cancellation keeps access until the paid period ends; failed payments end it; payment restores it', async () => {
    const t = await h.tenant('Lifecycle Gate');
    await request(h.http).post('/api/v1/billing/trial').set(as(t)).send({ plan: 'BUSINESS', billingMode: 'AUTO', autoRenewConsent: true }).expect(201);
    await request(h.http).post('/api/v1/billing/card-setup').set(as(t)).send({ returnUrl: 'https://app.example.com/b' }).expect(201);
    const row = () => prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } });
    const sim2 = (path: string, body: object = {}) => request(h.http).post(`/api/v1/billing/simulator/${path}`).set(as(t)).send(body);
    const deliver = (e: Parameters<SimulatedPaymentProvider['sign']>[0]) => { const s = sim.sign(e); return request(h.http).post('/api/v1/billing/webhooks/simulated').set(s.headers).set('Content-Type', 'application/json').send(s.rawBody.toString()); };
    await deliver({ id: `pm1-n232-${run}`, type: 'payment_method.attached', customerRef: (await row()).providerCustomerId!, paymentMethodRef: 'sim_pm_n232' }).expect(200);
    await request(h.http).post('/api/v1/billing/subscribe').set(as(t)).expect(201);
    await sim2('due', { outcome: 'success' }).expect(200); // the first paid period, confirmed by the provider
    await h.settled(t, (await analyze(t, t.productId).expect(202)).body.id);

    await request(h.http).post('/api/v1/billing/cancel').set(as(t)).expect(200);
    await h.settled(t, (await analyze(t, t.productId).expect(202)).body.id); // canceled but paid period not over: still allowed
    await sim2('rewind', { days: '40' }).expect(200);
    await sim2('process-due').expect(200);
    expect((await row()).status).toBe('EXPIRED');
    await analyze(t, t.productId).expect(402); // period over

    // A new AUTO subscription cycle for the same business: pay by hand, then fail repeatedly, then recover.
    const session = (await request(h.http).post('/api/v1/billing/renewals').set(as(t)).send({ returnUrl: 'https://app.example.com/b' }).expect(201)).body;
    await sim2('confirm', { paymentId: session.paymentId, outcome: 'success' }).expect(200);
    await h.settled(t, (await analyze(t, t.productId).expect(202)).body.id);
    await prisma.subscription.update({ where: { id: (await row()).id }, data: { billingMode: 'AUTO', providerSubscriptionId: (await row()).providerSubscriptionId ?? 'sim_sub_n232', cancelAtPeriodEnd: false } });
    for (let i = 0; i < 3; i++) await sim2('due', { outcome: 'declined' }).expect(200);
    expect((await row()).status).toBe('GRACE_PERIOD'); // retries exhausted: access continues during the grace days
    await h.settled(t, (await analyze(t, t.productId).expect(202)).body.id);
    await sim2('rewind', { days: '5' }).expect(200);
    await sim2('process-due').expect(200);
    expect((await row()).status).toBe('EXPIRED');
    await analyze(t, t.productId).expect(402); // grace over
    const retry = (await request(h.http).post('/api/v1/billing/renewals').set(as(t)).send({ returnUrl: 'https://app.example.com/b' }).expect(201)).body;
    await sim2('confirm', { paymentId: retry.paymentId, outcome: 'success' }).expect(200);
    await h.settled(t, (await analyze(t, t.productId).expect(202)).body.id);
  });

  it('the founder keeps feature access with no subscription at all; only a verified e-mail counts', async () => {
    const u = await register(app, FOUNDER);
    const b = (await request(h.http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Founder Gate', type: 'RESTAURANT', currency: 'USD', city: 'Istanbul', country: 'TR' }).expect(201)).body;
    const c: Ctx = { token: u.accessToken, businessId: b.id };
    const p = (await request(h.http).post('/api/v1/products').set(as(c)).send({ name: 'Founder tea', price: '5', status: 'ACTIVE', features: ['Loose leaf'], benefits: ['Calming'] }).expect(201)).body;
    await analyze(c, p.id).expect(402); // e-mail not verified yet: no privilege
    await prisma.user.update({ where: { email: FOUNDER }, data: { emailVerifiedAt: new Date() } });
    await h.settled(c, (await analyze(c, p.id).expect(202)).body.id);
    expect(await prisma.subscription.count({ where: { businessId: c.businessId } })).toBe(0);
  });

  it('tenants cannot use each other\'s subscription', async () => {
    const paid = await h.tenant('Paid Shop');
    const other = await h.tenant('Other Shop');
    await trial(paid).expect(201);
    await analyze(other, other.productId).expect(402);
    await request(h.http).post('/api/v1/ai/product-analysis').set({ Authorization: `Bearer ${other.token}`, 'X-Business-Id': paid.businessId }).send({ language: 'en', itemType: 'PRODUCT', itemId: paid.productId }).expect(404);
  });
});
