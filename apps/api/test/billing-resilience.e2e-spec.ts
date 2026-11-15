import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingService } from '../src/billing/billing.service';
import { SimulatedPaymentProvider } from '../src/billing/providers/simulated.provider';
import { aiHelpers, as } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * Trial reminders, founder exemption and moving to another payment provider without rebuilding the subscription system. Simulation only.
 * (Renewals, failures, cancellation, expiry and plan changes are in billing-engine.e2e-spec.ts.)
 */
const SECRET = 'n25-webhook-secret-0123456789';
const FOUNDER = 'founder-n25@example.com';
const sim = new SimulatedPaymentProvider(SECRET);
const RUN = Date.now();

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
  const id = (p: string) => `${p}_${RUN}_${n++}`;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    for (const [code, minor] of [['STARTER', 1900]] as const) await prisma.plan.upsert({ where: { code }, update: { priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, isActive: true }, create: { code, name: code, priceAmount: '19.00', priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, limits: {} } });
    app = await startApp();
    h = aiHelpers(app);
    billing = app.get(BillingService);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('trial reminders: once before the end, once after, never for the founder; the sweep expires the trial only at its end', async () => {
    const t = await h.tenant('Trial Shop');
    await post('trial', t, { plan: 'STARTER' }).expect(201);
    expect((await billing.processDue()).reminders).toBe(0); // 72 h left: too early
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { trialEndsAt: new Date(Date.now() + 2 * 3_600_000), currentPeriodEnd: new Date(Date.now() + 2 * 3_600_000) } });
    expect((await billing.processDue()).reminders).toBeGreaterThanOrEqual(1);
    expect((await billing.processDue()).reminders).toBe(0); // already told
    expect(await notes(t)).toEqual(['billing.trial_ending']);
    expect((await row(t)).status).toBe('ACTIVE'); // still in the trial
    await prisma.subscription.update({ where: { businessId: t.businessId }, data: { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) } });
    await billing.processDue();
    expect(await notes(t)).toEqual(['billing.trial_ended', 'billing.trial_ending']);
    expect((await row(t)).status).toBe('EXPIRED');
    expect((await status(t)).entitlement).toMatchObject({ state: 'EXPIRED', hasAccess: false });

    // A founder with a (legacy) expiring subscription row is never notified or expired.
    const u = await register(app, FOUNDER);
    await prisma.user.update({ where: { email: FOUNDER }, data: { emailVerifiedAt: new Date() } });
    const b = (await request(h.http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Founder N25', type: 'RESTAURANT', currency: 'USD', city: 'Istanbul', country: 'TR' }).expect(201)).body;
    const plan = await prisma.plan.findFirstOrThrow({ where: { code: 'STARTER' } });
    const soon = new Date(Date.now() + 3_600_000);
    await prisma.subscription.create({ data: { businessId: b.id, planId: plan.id, status: 'ACTIVE', trialEndsAt: soon, currentPeriodEnd: soon } });
    await billing.processDue();
    expect(await prisma.notification.count({ where: { businessId: b.id } })).toBe(0);
    expect((await status({ token: u.accessToken, businessId: b.id })).entitlement.state).toBe('FOUNDER_LIFETIME');
  });

  it('moving to another provider reuses the same subscription record: no rebuild, no cross-provider confusion', async () => {
    const t = await h.tenant('Migration Shop');
    await post('trial', t, { plan: 'STARTER', billingMode: 'AUTO', autoRenewConsent: true }).expect(201);
    await post('card-setup', t, { returnUrl: 'https://app.example.com/b' }).expect(201);
    await deliver({ id: id('pm'), type: 'payment_method.attached', customerRef: (await row(t)).providerCustomerId!, paymentMethodRef: 'sim_pm_mig' }).expect(200);
    await post('subscribe', t).expect(201);
    const subRef = (await row(t)).providerSubscriptionId!;
    await post('simulator/due', t, { outcome: 'success' }).expect(200);
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
    expect(s.subscription).toMatchObject({ plan: 'STARTER', cardSaved: true, status: 'ACTIVE' }); // same plan record, same business, same history
    expect(await prisma.invoice.count({ where: { businessId: t.businessId } })).toBe(1); // the earlier simulated invoice is still there
  });
});
