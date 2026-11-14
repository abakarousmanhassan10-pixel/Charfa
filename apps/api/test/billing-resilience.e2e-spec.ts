import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingService } from '../src/billing/billing.service';
import { SimulatedPaymentProvider } from '../src/billing/providers/simulated.provider';
import { aiHelpers, as } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * N25: failed payments, grace and suspension, cancellation and resumption, trial reminders, founder exemption,
 * and moving to another payment provider without rebuilding the subscription system. Simulation only.
 */
const SECRET = 'n25-webhook-secret-0123456789';
const FOUNDER = 'founder-n25@example.com';
const sim = new SimulatedPaymentProvider(SECRET);

describe('Billing resilience (simulated provider)', () => {
  const saved: Record<string, string | undefined> = {};
  const vars: Record<string, string> = { BILLING_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: SECRET, FOUNDER_EMAILS: FOUNDER, BILLING_MAX_FAILED_PAYMENTS: '3' };
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  let billing: BillingService;
  type C = { token: string; businessId: string };
  const post = (path: string, c: C, body: object = {}) => request(h.http).post(`/api/v1/billing/${path}`).set(as(c)).send(body);
  const status = async (c: C) => (await request(h.http).get('/api/v1/billing/status').set(as(c)).expect(200)).body;
  const deliver = (event: Parameters<SimulatedPaymentProvider['sign']>[0]) => {
    const s = sim.sign(event);
    return request(h.http).post('/api/v1/billing/webhooks/simulated').set(s.headers).set('Content-Type', 'application/json').send(s.rawBody.toString());
  };
  const row = (c: C) => prisma.subscription.findUniqueOrThrow({ where: { businessId: c.businessId } });
  const notes = async (c: C) => (await prisma.notification.findMany({ where: { businessId: c.businessId }, select: { type: true } })).map((n) => n.type).sort();
  let n = 0;
  const id = (p: string) => `${p}_${Date.now()}_${n++}`;

  /** A business with a running simulated subscription (trial -> card -> subscribe -> activated). */
  async function subscribed(name: string, periodEnd: Date) {
    const t = await h.tenant(name);
    await post('trial', t, { plan: 'STARTER' }).expect(201);
    await post('card-setup', t, { returnUrl: 'https://app.example.com/b' }).expect(201);
    const customerRef = (await row(t)).providerCustomerId!;
    await deliver({ id: id('pm'), type: 'payment_method.attached', customerRef, paymentMethodRef: `sim_pm_${id('x')}` }).expect(200);
    await post('subscribe', t).expect(201);
    const subRef = (await row(t)).providerSubscriptionId!;
    await deliver({ id: id('act'), type: 'subscription.activated', subscriptionRef: subRef, periodEnd: periodEnd.toISOString() }).expect(200);
    return { t, subRef, customerRef };
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    for (const [code, price] of [['STARTER', '19.00']] as const) await prisma.plan.upsert({ where: { code }, update: {}, create: { code, name: code, priceAmount: price, limits: {} } });
    app = await startApp();
    h = aiHelpers(app);
    billing = app.get(BillingService);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('failed renewals: grace, then suspension after the configured number, then recovery', async () => {
    const { t, subRef } = await subscribed('Dunning Shop', new Date(Date.now() - 3_600_000)); // period ended an hour ago: inside the 3-day grace
    await deliver({ id: id('f'), type: 'payment.failed', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD' }).expect(200);
    let s = await status(t);
    expect(s.subscription).toMatchObject({ status: 'PAST_DUE', failedPayments: 1 });
    expect(s.entitlement).toMatchObject({ state: 'PAST_DUE_GRACE', hasAccess: true });
    await deliver({ id: id('f'), type: 'payment.failed', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD' }).expect(200);
    expect((await status(t)).subscription.failedPayments).toBe(2);
    await deliver({ id: id('f'), type: 'payment.failed', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD' }).expect(200);
    s = await status(t);
    expect(s.subscription).toMatchObject({ status: 'UNPAID', failedPayments: 3 });
    expect(s.entitlement).toMatchObject({ state: 'EXPIRED', hasAccess: false });
    expect(await notes(t)).toEqual(['billing.payment_failed', 'billing.payment_failed', 'billing.unpaid']);
    // The same failure event delivered twice counts once.
    const dup = id('f');
    await deliver({ id: dup, type: 'payment.failed', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD' }).expect(200);
    await deliver({ id: dup, type: 'payment.failed', subscriptionRef: subRef, paymentRef: 'again', amount: '19.00', currency: 'USD' }).expect(200);
    expect((await row(t)).failedPaymentCount).toBe(4);
    // Recovery: a successful payment restores access and clears the counter.
    await deliver({ id: id('ok'), type: 'payment.succeeded', subscriptionRef: subRef, paymentRef: id('pay'), amount: '19.00', currency: 'USD', periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString() }).expect(200);
    s = await status(t);
    expect(s.subscription).toMatchObject({ status: 'ACTIVE', failedPayments: 0 });
    expect(s.entitlement).toMatchObject({ state: 'ACTIVE', hasAccess: true });
  });

  it('cancel keeps access until the period ends and can be undone; a final cancellation cannot', async () => {
    const { t, subRef } = await subscribed('Cancel Shop', new Date(Date.now() + 10 * 86_400_000));
    await post('resume', t).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('NOTHING_TO_RESUME'));
    expect((await post('cancel', t).expect(200)).body.subscription.cancelAtPeriodEnd).toBe(true);
    expect((await status(t)).entitlement.hasAccess).toBe(true);
    expect((await post('resume', t).expect(200)).body.subscription.cancelAtPeriodEnd).toBe(false);
    await post('cancel', t).expect(200);
    await deliver({ id: id('c'), type: 'subscription.canceled', subscriptionRef: subRef }).expect(200);
    const s = await status(t);
    expect(s.subscription.status).toBe('CANCELED');
    expect(s.entitlement).toMatchObject({ state: 'CANCELED_UNTIL_PERIOD_END', hasAccess: true }); // paid period not over yet
    await post('resume', t).expect(409);
    expect(await notes(t)).toContain('billing.canceled');
  });

  it('trial reminders: once before the end, once after, never for the founder, no status change', async () => {
    const t = await h.tenant('Trial Shop');
    await post('trial', t, { plan: 'STARTER' }).expect(201);
    expect(await billing.sweepTrials()).toMatchObject({ notified: 0 }); // 72 h left: too early
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { trialEndsAt: new Date(Date.now() + 2 * 3_600_000) } });
    expect((await billing.sweepTrials()).notified).toBeGreaterThanOrEqual(1);
    expect(await billing.sweepTrials()).toMatchObject({ notified: 0 }); // already told
    expect(await notes(t)).toEqual(['billing.trial_ending']);
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    await billing.sweepTrials();
    expect(await notes(t)).toEqual(['billing.trial_ended', 'billing.trial_ending']);
    expect((await row(t)).status).toBe('TRIALING'); // the sweep changes no subscription
    expect((await status(t)).entitlement).toMatchObject({ state: 'EXPIRED', hasAccess: false });

    // A founder with a (legacy) expiring subscription row is never notified.
    const u = await register(app, FOUNDER);
    await prisma.user.update({ where: { email: FOUNDER }, data: { emailVerifiedAt: new Date() } });
    const b = (await request(h.http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Founder N25', type: 'RESTAURANT', currency: 'USD', city: 'Istanbul', country: 'TR' }).expect(201)).body;
    const plan = await prisma.plan.findFirstOrThrow({ where: { code: 'STARTER' } });
    await prisma.subscription.create({ data: { businessId: b.id, planId: plan.id, status: 'TRIALING', trialEndsAt: new Date(Date.now() + 3_600_000) } });
    await billing.sweepTrials();
    expect(await prisma.notification.count({ where: { businessId: b.id } })).toBe(0);
    expect((await status({ token: u.accessToken, businessId: b.id })).entitlement.state).toBe('FOUNDER_LIFETIME');
  });

  it('moving to another provider reuses the same subscription record: no rebuild, no cross-provider confusion', async () => {
    const { t, subRef } = await subscribed('Migration Shop', new Date(Date.now() + 5 * 86_400_000));
    // The business was on a previous provider ("legacy-psp"), with a live subscription there.
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { provider: 'legacy-psp' } });
    expect((await status(t)).providerMigration).toEqual({ required: true, from: 'legacy-psp' });
    // Events carrying the OLD provider's references cannot touch it through the new provider's webhook.
    await deliver({ id: id('c'), type: 'subscription.canceled', subscriptionRef: subRef }).expect(200);
    expect((await row(t)).status).toBe('ACTIVE');
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { type: 'subscription.canceled', status: 'IGNORED' }, orderBy: { receivedAt: 'desc' } })).status).toBe('IGNORED');
    // While the old provider still bills, nothing is moved (no double billing).
    await post('card-setup', t, { returnUrl: 'https://app.example.com/b' }).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('PROVIDER_MIGRATION_BLOCKED'));
    await post('cancel', t).expect(409);
    await post('subscribe', t).expect(409);
    // The old subscription has been ended at the old provider (done there): the merchant captures a new card.
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { providerSubscriptionId: null } });
    await post('subscribe', t).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('PROVIDER_MIGRATION_REQUIRED'));
    await post('card-setup', t, { returnUrl: 'https://app.example.com/b' }).expect(201);
    const moved = await row(t);
    expect(moved).toMatchObject({ provider: 'simulated', providerMigratedFrom: 'legacy-psp', paymentMethodRef: null });
    expect(moved.providerCustomerId).toMatch(/^sim_cus_/);
    await post('subscribe', t).expect(409).expect((r) => expect(r.body.code ?? r.body.error?.code).toBe('CARD_REQUIRED'));
    await deliver({ id: id('pm'), type: 'payment_method.attached', customerRef: moved.providerCustomerId!, paymentMethodRef: 'sim_pm_new' }).expect(200);
    await post('subscribe', t).expect(201);
    const s = await status(t);
    expect(s.providerMigration.required).toBe(false);
    expect(s.subscription).toMatchObject({ plan: 'STARTER', cardSaved: true }); // same plan record, same business, same history
    expect(await prisma.payment.count({ where: { businessId: t.businessId } })).toBe(0);
  });
});
