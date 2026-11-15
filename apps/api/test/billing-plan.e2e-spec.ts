import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { PAYMENT_PROVIDER } from '../src/billing/billing-provider';
import { MockPaymentProvider } from '../src/billing/providers/simulated.provider';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * N27: plan entitlements (agents, features, quotas, expiry) enforced on the server; events that arrive out of order; provider failures with the mock.
 * Mock provider only: no money, no card, no network.
 */
const SECRET = 'n27-webhook-secret-0123456789';
const FOUNDER = 'founder-n27@example.com';
const RUN = Date.now();
const RETURN = 'https://app.example.com/billing';
const AGENTS = {
  STARTER: ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'CONTENT_CREATOR', 'CUSTOMER_SUPPORT', 'SCHEDULER'],
  PRO: ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'MARKETING_STRATEGIST', 'CONTENT_CREATOR', 'VISUAL_CREATOR', 'SCHEDULER', 'CUSTOMER_SUPPORT', 'PERFORMANCE_ANALYST'],
  BUSINESS: ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'MARKETING_STRATEGIST', 'CONTENT_CREATOR', 'VISUAL_CREATOR', 'VIDEO_CREATOR', 'SCHEDULER', 'CUSTOMER_SUPPORT', 'PERFORMANCE_ANALYST'],
};
const FEATURES = {
  STARTER: ['ai', 'calendar', 'sales'],
  PRO: ['ai', 'calendar', 'sales', 'creative', 'market', 'campaigns', 'workflows'],
  BUSINESS: ['ai', 'calendar', 'sales', 'creative', 'market', 'campaigns', 'workflows', 'intelligence', 'autopilot'],
};

describe('Plan entitlements, out-of-order events and provider failures (mock provider)', () => {
  const saved: Record<string, string | undefined> = {};
  const vars: Record<string, string> = { BILLING_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: SECRET, FOUNDER_EMAILS: FOUNDER, BILLING_ENFORCEMENT_ENABLED: 'true', BILLING_GRACE_DAYS: '3', BILLING_MAX_FAILED_PAYMENTS: '3', AI_MONTHLY_GENERATIONS_PER_BUSINESS: '300' };
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  let mock: MockPaymentProvider;
  let ent: EntitlementsService;
  const code = (r: request.Response) => r.body.code ?? r.body.error?.code;
  const api = (m: 'get' | 'post', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/billing/${path}`).set(as(c)); return body ? r.send(body) : m === 'post' ? r.send({}) : r; };
  const row = (c: Ctx) => prisma.subscription.findUniqueOrThrow({ where: { businessId: c.businessId } });
  const deliver = (event: Parameters<MockPaymentProvider['sign']>[0]) => { const s = mock.sign(event); return request(h.http).post('/api/v1/billing/webhooks/simulated').set(s.headers).set('Content-Type', 'application/json').send(s.rawBody.toString()); };
  const id = (() => { let n = 0; return (p: string) => `${p}_${RUN}_${++n}`; })();
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const onPlan = async (name: string, plan: 'STARTER' | 'PRO' | 'BUSINESS') => { const c = await h.tenant(name); await api('post', 'trial', c, { plan }).expect(201); return c; };
  const strategy = (c: Ctx) => request(h.http).post('/api/v1/ai/marketing-strategy').set(as(c)).send({ language: 'en', platforms: ['INSTAGRAM'] });
  const analysis = (c: Ctx) => request(h.http).post('/api/v1/ai/business-analysis').set(as(c)).send({ language: 'en' });

  beforeAll(async () => {
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    for (const [c, minor] of [['STARTER', 1900], ['PRO', 4900], ['BUSINESS', 9900]] as const) {
      const limits = { agents: AGENTS[c], features: FEATURES[c], aiGenerationsPerMonth: 300, salesInteractionsPerMonth: c === 'STARTER' ? 2 : 500 };
      await prisma.plan.upsert({ where: { code: c }, update: { priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, currency: 'USD', isActive: true, limits }, create: { code: c, name: c, priceAmount: String(minor / 100), priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, limits } });
    }
    app = await startApp();
    h = aiHelpers(app);
    mock = app.get<MockPaymentProvider>(PAYMENT_PROVIDER);
    ent = app.get(EntitlementsService);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('agents: a plan includes only its agents; the server refuses the others with 402 and queues nothing', async () => {
    const starter = await onPlan('Agents Starter', 'STARTER');
    const pro = await onPlan('Agents Pro', 'PRO');
    await h.settled(starter, (await analysis(starter).expect(202)).body.id); // BUSINESS_ANALYST is in STARTER
    const refused = await strategy(starter).expect(402);
    expect(code(refused)).toBe('AGENT_NOT_IN_PLAN');
    expect(refused.body.message).toMatch(/not included in your plan/);
    expect(await prisma.aIGeneration.count({ where: { businessId: starter.businessId, task: 'MARKETING_STRATEGY' } })).toBe(0);
    await h.settled(pro, (await strategy(pro).expect(202)).body.id); // MARKETING_STRATEGIST is in PRO
    // The browser cannot widen its plan.
    await request(h.http).post('/api/v1/ai/marketing-strategy').set({ ...as(starter), 'X-Plan': 'BUSINESS', 'X-Features': 'all' }).send({ language: 'en', platforms: ['INSTAGRAM'], plan: 'BUSINESS' }).expect((r) => expect([402, 400]).toContain(r.status));
  });

  it('features: modules outside the plan answer 402; the plan summary lists agents, features and usage', async () => {
    const starter = await onPlan('Feat Starter', 'STARTER');
    const pro = await onPlan('Feat Pro', 'PRO');
    const biz = await onPlan('Feat Business', 'BUSINESS');
    const get = (c: Ctx, path: string) => request(h.http).get(`/api/v1${path}`).set(as(c));
    expect(code(await get(starter, '/campaigns').expect(402))).toBe('FEATURE_NOT_IN_PLAN');
    await get(pro, '/campaigns').expect(200);
    expect(code(await get(pro, '/intelligence/overview').expect(402))).toBe('FEATURE_NOT_IN_PLAN');
    await get(biz, '/intelligence/overview').expect(200);
    const s = (await api('get', 'status', pro).expect(200)).body.entitlements;
    expect(s).toMatchObject({ enforced: true, source: 'plan', plan: 'PRO', agents: { max: 8 }, usage: { aiGenerations: { used: 0, limit: 300 }, salesInteractions: { used: 0, limit: 500 } } });
    expect(s.features).toEqual(FEATURES.PRO);
    expect(s.agents.allowed).not.toContain('VIDEO_CREATOR');
  });

  it('sales-assistant quota: counted per business and month, refused with 429 at the plan limit, other businesses unaffected', async () => {
    const a = await onPlan('Quota A', 'STARTER'); // limit 2
    const b = await onPlan('Quota B', 'STARTER');
    await ent.assertSalesInteraction(a.businessId);
    for (let i = 0; i < 2; i++) await prisma.aIUsage.create({ data: { businessId: a.businessId, agent: 'CUSTOMER_SUPPORT', provider: 'fake', model: 'm', operation: 'sales_reply', success: true } });
    await prisma.aIUsage.create({ data: { businessId: a.businessId, agent: 'CUSTOMER_SUPPORT', provider: 'fake', model: 'm', operation: 'sales_reply', success: false } }); // failures do not count
    expect(await ent.salesInteractionsUsed(a.businessId)).toBe(2);
    await expect(ent.assertSalesInteraction(a.businessId)).rejects.toMatchObject({ status: 429, response: { code: 'PLAN_QUOTA_REACHED', quota: 'salesInteractions', used: 2, limit: 2 } });
    await ent.assertSalesInteraction(b.businessId);
    expect((await api('get', 'status', a).expect(200)).body.entitlements.usage.salesInteractions).toEqual({ used: 2, limit: 2 });
  });

  it('expiry: paid actions are suspended (402) but history, usage and billing stay readable; paying restores them', async () => {
    const c = await onPlan('Expiry', 'PRO');
    await h.settled(c, (await analysis(c).expect(202)).body.id);
    await prisma.subscription.update({ where: { businessId: c.businessId }, data: { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect(code(await analysis(c).expect(402))).toBe('SUBSCRIPTION_REQUIRED');
    for (const path of ['/ai/status', '/ai/generations']) await request(h.http).get(`/api/v1${path}`).set(as(c)).expect(200);
    for (const path of ['status', 'history', 'invoices']) await api('get', path, c).expect(200);
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    await deliver({ id: id('evt'), type: 'payment.succeeded', paymentRef: p.providerPaymentId, reference: p.idempotencyKey!, amount: '49.00', currency: 'USD' }).expect(200);
    await h.settled(c, (await analysis(c).expect(202)).body.id);
  });

  it('the founder gets the highest plan with no subscription; another business is unaffected by it', async () => {
    const u = await register(app, FOUNDER);
    await prisma.user.update({ where: { email: FOUNDER }, data: { emailVerifiedAt: new Date() } });
    const b = (await request(h.http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Founder N27', type: 'RESTAURANT', currency: 'USD', city: 'Istanbul', country: 'TR' }).expect(201)).body;
    const f: Ctx = { token: u.accessToken, businessId: b.id };
    await h.settled(f, (await strategy(f).expect(202)).body.id);
    await request(h.http).get('/api/v1/intelligence/overview').set(as(f)).expect(200);
    expect((await api('get', 'status', f).expect(200)).body.entitlements).toMatchObject({ source: 'founder', plan: 'BUSINESS' });
    expect(await prisma.subscription.count({ where: { businessId: f.businessId } })).toBe(0);
    const other = await h.tenant('NotFounder');
    expect(code(await strategy(other).expect(402))).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('events out of order: a late failure, a late cancellation and a late duplicate failure never undo a confirmed payment', async () => {
    const c = await onPlan('OutOfOrder', 'STARTER');
    await api('post', 'mode', c, { billingMode: 'AUTO', autoRenewConsent: true }).expect(200);
    await api('post', 'card-setup', c, { returnUrl: RETURN }).expect(201);
    const sub0 = await row(c);
    await deliver({ id: id('pm'), type: 'payment_method.attached', customerRef: sub0.providerCustomerId!, paymentMethodRef: 'sim_pm_ooo' }).expect(200);
    await api('post', 'subscribe', c).expect(201);
    const subRef = (await row(c)).providerSubscriptionId!;
    const sinceTrial = (await row(c)).currentPeriodEnd!;
    // The success (T2) is processed first, then a failure that happened earlier (T1) arrives.
    const t1 = iso(-120_000); const t2 = iso(-60_000);
    await deliver({ id: id('ok'), type: 'payment.succeeded', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD', occurredAt: t2 }).expect(200);
    const paid = await row(c);
    expect(paid.status).toBe('ACTIVE');
    expect(paid.currentPeriodEnd!.getTime()).toBeGreaterThan(sinceTrial.getTime());
    const failedPay = id('pay');
    await deliver({ id: id('late'), type: 'payment.failed', subscriptionRef: subRef, paymentRef: failedPay, amount: '19.00', currency: 'USD', occurredAt: t1 }).expect(200);
    let r = await row(c);
    expect(r).toMatchObject({ status: 'ACTIVE', failedPaymentCount: 0 });
    expect(r.currentPeriodEnd!.getTime()).toBe(paid.currentPeriodEnd!.getTime());
    expect((await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: failedPay } })).status).toBe('FAILED'); // recorded for the history
    // A cancellation that predates the confirmed payment is flagged, not applied.
    await deliver({ id: id('can'), type: 'subscription.canceled', subscriptionRef: subRef, occurredAt: t1 }).expect(200);
    expect((await row(c)).status).toBe('ACTIVE');
    expect(await prisma.subscriptionAuditLog.count({ where: { businessId: c.businessId, action: 'stale_event_ignored' } })).toBe(2);
    // A failure reported for a payment that was already confirmed is ignored too.
    const okPay = (await prisma.payment.findFirstOrThrow({ where: { businessId: c.businessId, status: 'SUCCEEDED' } })).providerPaymentId;
    await deliver({ id: id('dup'), type: 'payment.failed', subscriptionRef: subRef, paymentRef: okPay, amount: '19.00', currency: 'USD' }).expect(200);
    r = await row(c);
    expect(r).toMatchObject({ status: 'ACTIVE', failedPaymentCount: 0 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: okPay } })).status).toBe('SUCCEEDED');
    // A newer failure does count (the next renewal).
    await deliver({ id: id('new'), type: 'payment.failed', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD', occurredAt: iso(60_000) }).expect(200);
    expect((await row(c)).status).toBe('PAST_DUE');
    // A payment confirmed before the card notification still adopts everything (any order).
    const c2 = await onPlan('AnyOrder', 'STARTER');
    await api('post', 'mode', c2, { billingMode: 'AUTO', autoRenewConsent: true }).expect(200);
    await api('post', 'card-setup', c2, { returnUrl: RETURN }).expect(201);
    const cust = (await row(c2)).providerCustomerId!;
    await deliver({ id: id('ok'), type: 'payment.succeeded', customerRef: cust, paymentRef: id('pay'), amount: '19.00', currency: 'USD' }).expect(200);
    await deliver({ id: id('pm'), type: 'payment_method.attached', customerRef: cust, paymentMethodRef: 'sim_pm_late', occurredAt: iso(-3_600_000) }).expect(200);
    expect(await row(c2)).toMatchObject({ status: 'ACTIVE', paymentMethodRef: 'sim_pm_late' });
  });

  it('provider failure with the mock: 503, nothing charged or stored, an incident for the administrators, recovery on the next try', async () => {
    const c = await onPlan('MockOutage', 'STARTER');
    const before = await prisma.payment.count({ where: { businessId: c.businessId } });
    mock.injectFailure(new Error('socket hang up 10.1.2.3'), 1);
    const down = await api('post', 'renewals', c, { returnUrl: RETURN }).expect(503);
    expect(code(down)).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(down.body)).not.toMatch(/socket|10\.1\.2\.3/);
    expect(await prisma.payment.count({ where: { businessId: c.businessId } })).toBe(before);
    expect((await row(c)).status).toBe('ACTIVE');
    expect(await prisma.subscriptionAuditLog.count({ where: { businessId: c.businessId, action: 'provider_unavailable' } })).toBe(1);
    // The mode switch to MANUAL also depends on the provider when a schedule exists: it fails closed and keeps the subscription as it was.
    await api('post', 'mode', c, { billingMode: 'AUTO', autoRenewConsent: true }).expect(200);
    await api('post', 'card-setup', c, { returnUrl: RETURN }).expect(201);
    await deliver({ id: id('pm'), type: 'payment_method.attached', customerRef: (await row(c)).providerCustomerId!, paymentMethodRef: 'sim_pm_x' }).expect(200);
    await api('post', 'subscribe', c).expect(201);
    mock.injectFailure(new Error('timeout'), 1);
    await api('post', 'mode', c, { billingMode: 'MANUAL' }).expect(503);
    expect(await row(c)).toMatchObject({ billingMode: 'AUTO' });
    expect((await row(c)).providerSubscriptionId).toBeTruthy();
    await api('post', 'mode', c, { billingMode: 'MANUAL' }).expect(200); // recovered
    mock.clearFailure();
  });

  it('administrators can list subscriptions by state and review incidents; others cannot', async () => {
    const c = await onPlan('AdminList', 'STARTER');
    const user = await prisma.user.findFirstOrThrow({ where: { memberships: { some: { businessId: c.businessId } } } });
    await request(h.http).get('/api/v1/admin/billing/subscriptions').set(as(c)).expect(403);
    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'SUPPORT' } });
    const list = (await request(h.http).get('/api/v1/admin/billing/subscriptions?status=ACTIVE&pageSize=100').set(as(c)).expect(200)).body;
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((i: { status: string }) => i.status === 'ACTIVE')).toBe(true);
    expect(list.items[0]).toEqual(expect.objectContaining({ business: expect.any(String), plan: expect.any(String), amountMinor: expect.any(Number) }));
    await request(h.http).get('/api/v1/admin/billing/subscriptions?status=BOGUS').set(as(c)).expect(400);
    const inc = (await request(h.http).get('/api/v1/admin/billing/incidents').set(as(c)).expect(200)).body;
    expect(inc.counts.stale_event_ignored).toBeGreaterThanOrEqual(2);
    expect(inc.counts.provider_unavailable).toBeGreaterThanOrEqual(1);
    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'USER' } });
  });
});
