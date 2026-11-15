import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SimulatedPaymentProvider } from '../src/billing/providers/simulated.provider';
import { aiHelpers, as } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * N24 billing preparation, simulation only: a test provider moves no money, sees no card and calls no network.
 * Covers the 72-hour trial, hosted card capture (no card data), monthly subscription, cancellation, verified webhooks, founder lifetime
 * access, tenant isolation, and the disabled / unverified-Payoneer behaviours.
 */
const SECRET = 'n24-webhook-secret-0123456789';
const FOUNDER = 'founder-n24@example.com';
const sim = new SimulatedPaymentProvider(SECRET);

function withEnv(vars: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  return {
    apply() { for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    restore() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

async function ensurePlans() {
  for (const [code, price] of [['STARTER', '19.00'], ['PRO', '49.00']] as const) {
    await prisma.plan.upsert({ where: { code }, update: {}, create: { code, name: code, priceAmount: price, limits: {} } });
  }
}

describe('Billing (simulated provider)', () => {
  const env = withEnv({ BILLING_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: SECRET, FOUNDER_EMAILS: FOUNDER });
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  let fetchSpy: jest.SpyInstance;
  const post = (path: string, c: { token: string; businessId: string }, body: object = {}) => request(h.http).post(`/api/v1/billing/${path}`).set(as(c)).send(body);
  const deliver = (event: Parameters<SimulatedPaymentProvider['sign']>[0], at?: Date) => {
    const s = sim.sign(event, at);
    return request(h.http).post('/api/v1/billing/webhooks/simulated').set(s.headers).set('Content-Type', 'application/json').send(s.rawBody.toString());
  };

  beforeAll(async () => {
    env.apply();
    await resetDb();
    await ensurePlans();
    app = await startApp();
    h = aiHelpers(app);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterAll(async () => { fetchSpy.mockRestore(); await app.close(); await prisma.$disconnect(); env.restore(); });

  it('status is read-only: it creates no subscription', async () => {
    const t = await h.tenant('Bill Shop');
    const s = (await request(h.http).get('/api/v1/billing/status').set(as(t)).expect(200)).body;
    expect(s).toMatchObject({ enabled: true, entitlement: { state: 'NONE', hasAccess: false }, subscription: null });
    expect(s.provider).toMatchObject({ id: 'simulated', live: false, verifiedAgainstOfficialDocs: false });
    expect(await prisma.subscription.count({ where: { businessId: t.businessId } })).toBe(0);
  });

  it('full lifecycle: 72h trial, hosted card, monthly subscription, payments, failure, cancellation', async () => {
    const t = await h.tenant('Lifecycle Shop');
    const before = Date.now();
    const trial = (await post('trial', t, { plan: 'STARTER' }).expect(201)).body;
    expect(trial.entitlement).toMatchObject({ state: 'TRIALING', hasAccess: true });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } });
    const hours = (row.trialEndsAt!.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(71.99);
    expect(hours).toBeLessThan(72.1);
    await post('trial', t, { plan: 'STARTER' }).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('TRIAL_ALREADY_USED'));

    await post('subscribe', t).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('CARD_REQUIRED'));
    const setup = (await post('card-setup', t, { returnUrl: 'https://app.example.com/billing' }).expect(201)).body;
    expect(Object.keys(setup)).toEqual(['hostedUrl']);
    expect(setup.hostedUrl).toMatch(/^https:\/\/simulated\.invalid\//);
    const customerRef = (await prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } })).providerCustomerId!;
    expect(customerRef).toMatch(/^sim_cus_/);

    await deliver({ id: 'evt_pm_1', type: 'payment_method.attached', customerRef, paymentMethodRef: 'sim_pm_1' }).expect(200);
    const subscribed = (await post('subscribe', t).expect(201)).body;
    expect(subscribed.subscription).toMatchObject({ status: 'TRIALING', cardSaved: true }); // not ACTIVE until the provider says so
    const subRef = (await prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } })).providerSubscriptionId!;

    const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await deliver({ id: 'evt_act_1', type: 'subscription.activated', subscriptionRef: subRef, periodEnd: end }).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } })).status).toBe('ACTIVE');
    await deliver({ id: 'evt_pay_1', type: 'payment.succeeded', subscriptionRef: subRef, paymentRef: 'sim_pay_1', amount: '19.00', currency: 'USD', periodEnd: end }).expect(200);
    expect(await prisma.payment.findMany({ where: { businessId: t.businessId }, select: { status: true, amount: true } })).toEqual([{ status: 'SUCCEEDED', amount: expect.anything() }]);
    // Redelivery of the same event changes nothing.
    expect((await deliver({ id: 'evt_pay_1', type: 'payment.succeeded', subscriptionRef: subRef, paymentRef: 'sim_pay_1', amount: '19.00', currency: 'USD' }).expect(200)).body).toMatchObject({ duplicate: true });
    expect(await prisma.payment.count({ where: { businessId: t.businessId } })).toBe(1);

    await deliver({ id: 'evt_pay_2', type: 'payment.failed', subscriptionRef: subRef, paymentRef: 'sim_pay_2', amount: '19.00', currency: 'USD' }).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } })).status).toBe('PAST_DUE');

    const canceled = (await post('cancel', t).expect(200)).body;
    expect(canceled.subscription.cancelAtPeriodEnd).toBe(true);
    await deliver({ id: 'evt_can_1', type: 'subscription.canceled', subscriptionRef: subRef }).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId: t.businessId } })).status).toBe('CANCELED');

    // No card data anywhere in the database rows or API answers; no network request was made.
    const dump = JSON.stringify([await prisma.subscription.findMany({ where: { businessId: t.businessId } }), await prisma.payment.findMany({ where: { businessId: t.businessId } }), await prisma.webhookEvent.findMany({ where: { payload: { path: ['subscriptionRef'], equals: subRef } } })]);
    expect(dump).not.toMatch(/(?<![\w-])\d{13,19}(?![\w-])|cvc|cvv|card_?number/i); // a card number, not an id or timestamp
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only the owner can change billing; an admin can read it', async () => {
    const t = await h.tenant('Role Shop');
    const admin = await h.member(t, 'ADMIN');
    await request(h.http).get('/api/v1/billing/status').set(as(admin)).expect(200);
    await post('trial', admin, { plan: 'STARTER' }).expect(403);
    const viewer = await h.member(t, 'VIEWER');
    await request(h.http).get('/api/v1/billing/status').set(as(viewer)).expect(403);
  });

  it('tenants are isolated', async () => {
    const a = await h.tenant('Iso A');
    const b = await h.tenant('Iso B');
    await post('trial', a, { plan: 'PRO' }).expect(201);
    expect((await request(h.http).get('/api/v1/billing/status').set(as(b)).expect(200)).body.subscription).toBeNull();
    // A token for B naming A's business is refused.
    await request(h.http).get('/api/v1/billing/status').set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId }).expect(404); // existence is not revealed
  });

  it('rejects webhooks that cannot prove their sender and stores nothing', async () => {
    const ev = { id: 'evt_bad', type: 'payment.succeeded' as const, subscriptionRef: 'x' };
    const good = sim.sign(ev);
    const url = '/api/v1/billing/webhooks/simulated';
    const send = (headers: Record<string, string>, body: Buffer) => request(h.http).post(url).set(headers).set('Content-Type', 'application/json').send(body.toString());
    await send(good.headers, good.rawBody).expect(200); // control: the untouched delivery is accepted
    await send({}, good.rawBody).expect(401); // no signature
    await send(good.headers, Buffer.from(good.rawBody.toString().replace('payment.succeeded', 'subscription.canceled'))).expect(401); // tampered body
    await send(new SimulatedPaymentProvider('another-secret-0123456789').sign(ev).headers, good.rawBody).expect(401); // wrong secret
    const old = sim.sign(ev, new Date(Date.now() - 10 * 60_000));
    await send(old.headers, old.rawBody).expect(401); // replayed after 5 minutes
    await request(h.http).post('/api/v1/billing/webhooks/payoneer').send({}).expect(404); // not the configured provider
    await request(h.http).post('/api/v1/billing/webhooks/unknown').send({}).expect(404);
    expect(await prisma.webhookEvent.count({ where: { externalEventId: 'evt_bad' } })).toBe(1); // only the control delivery
  });

  it('an event for no known subscription is stored as IGNORED, never applied', async () => {
    await deliver({ id: 'evt_orphan', type: 'subscription.canceled', subscriptionRef: 'sim_sub_unknown' }).expect(200);
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { externalEventId: 'evt_orphan' } })).status).toBe('IGNORED');
  });

  it('the founder keeps free lifetime access and can never be asked to pay', async () => {
    const u = await register(app, FOUNDER);
    const b = (await request(h.http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Founder Shop', type: 'RESTAURANT', currency: 'USD', city: 'Istanbul', country: 'TR' }).expect(201)).body;
    const c = { token: u.accessToken, businessId: b.id as string };
    // Same e-mail but NOT verified: no privilege.
    expect((await request(h.http).get('/api/v1/billing/status').set(as(c)).expect(200)).body.entitlement.state).toBe('NONE');
    await prisma.user.update({ where: { email: FOUNDER }, data: { emailVerifiedAt: new Date() } });
    const s = (await request(h.http).get('/api/v1/billing/status').set(as(c)).expect(200)).body;
    expect(s.entitlement).toEqual({ state: 'FOUNDER_LIFETIME', hasAccess: true, chargeable: false, accessUntil: null });
    for (const [path, body] of [['trial', { plan: 'STARTER' }], ['card-setup', { returnUrl: 'https://app.example.com/b' }], ['subscribe', {}]] as const) {
      await post(path, c, body).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('FOUNDER_FREE_ACCESS'));
    }
    expect(await prisma.subscription.count({ where: { businessId: c.businessId } })).toBe(0);
  });
});

describe('Billing off by default and Payoneer unverified', () => {
  it('billing endpoints do not exist when BILLING_ENABLED is not true', async () => {
    const env = withEnv({ BILLING_ENABLED: undefined, BILLING_PROVIDER: undefined });
    env.apply();
    await resetDb();
    const app = await startApp();
    try {
      const h = aiHelpers(app);
      const t = await h.tenant('Off Shop');
      await request(h.http).get('/api/v1/billing/status').set(as(t)).expect(404);
      await request(h.http).post('/api/v1/billing/trial').set(as(t)).send({ plan: 'STARTER' }).expect(404);
      await request(h.http).post('/api/v1/billing/webhooks/simulated').send({}).expect(404);
    } finally { await app.close(); env.restore(); }
  });

  it('Payoneer adapter refuses everything: capabilities unverified, no request sent', async () => {
    const env = withEnv({ BILLING_ENABLED: 'true', BILLING_PROVIDER: 'payoneer', PAYONEER_ACCOUNT_TYPE: 'business', FOUNDER_EMAILS: undefined });
    env.apply();
    await resetDb();
    await ensurePlans();
    const app = await startApp();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const h = aiHelpers(app);
      const t = await h.tenant('Payoneer Shop');
      const s = (await request(h.http).get('/api/v1/billing/status').set(as(t)).expect(200)).body;
      expect(s.provider).toEqual({ id: 'payoneer', recurringSubscriptions: 'unverified', hostedCardCapture: 'unverified', verifiedWebhooks: 'unverified', verifiedAgainstOfficialDocs: false, live: false });
      await request(h.http).post('/api/v1/billing/trial').set(as(t)).send({ plan: 'STARTER' }).expect(201); // the free trial needs no provider
      await request(h.http).post('/api/v1/billing/card-setup').set(as(t)).send({ returnUrl: 'https://app.example.com/b' }).expect(503).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('PROVIDER_NOT_VERIFIED'));
      await request(h.http).post('/api/v1/billing/webhooks/payoneer').set('Content-Type', 'application/json').send({ id: 'x' }).expect(503);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); await app.close(); env.restore(); }
  });
});
