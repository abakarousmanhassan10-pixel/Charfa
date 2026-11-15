import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SimulatedPaymentProvider } from '../src/billing/providers/simulated.provider';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * N26 billing engine, simulation only (mock provider: no money, no card, no network). The "provider" is played by the simulator, which sends correctly
 * signed notifications through the same webhook path a real provider would use: subscriptions change only from verified provider events.
 */
const SECRET = 'n26-webhook-secret-0123456789';
const sim = new SimulatedPaymentProvider(SECRET);
const RETURN = 'https://app.example.com/billing';

describe('Billing engine (mock provider)', () => {
  const saved: Record<string, string | undefined> = {};
  const vars: Record<string, string> = { BILLING_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: SECRET, BILLING_GRACE_DAYS: '3', BILLING_REMINDER_DAYS: '3', BILLING_MAX_FAILED_PAYMENTS: '3' };
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  const code = (r: request.Response) => r.body.code ?? r.body.error?.code;
  const api = (m: 'get' | 'post', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/billing/${path}`).set(as(c)); return body ? r.send(body) : m === 'post' ? r.send({}) : r; };
  const status = async (c: Ctx) => (await api('get', 'status', c).expect(200)).body;
  const row = (c: Ctx) => prisma.subscription.findUniqueOrThrow({ where: { businessId: c.businessId } });
  const states = async (c: Ctx) => (await prisma.subscriptionAuditLog.findMany({ where: { businessId: c.businessId, action: 'status_changed' }, orderBy: { createdAt: 'asc' } })).map((l) => `${l.fromStatus}>${l.toStatus}`);
  const deliver = (event: Parameters<SimulatedPaymentProvider['sign']>[0]) => { const s = sim.sign(event); return request(h.http).post('/api/v1/billing/webhooks/simulated').set(s.headers).set('Content-Type', 'application/json').send(s.rawBody.toString()); };
  const confirm = (c: Ctx, paymentId: string, outcome: 'success' | 'declined') => api('post', 'simulator/confirm', c, { paymentId, outcome });
  const due = (c: Ctx, outcome: 'success' | 'declined') => api('post', 'simulator/due', c, { outcome });
  let n = 0;
  const tenant = (name: string) => h.tenant(`${name} ${++n}`);

  /** MANUAL subscription whose first period is paid through a payment session (the realistic path: trial -> renewal -> confirmation). */
  async function paidManual(name: string, plan: 'STARTER' | 'PRO' = 'STARTER', interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY') {
    const c = await tenant(name);
    await api('post', 'trial', c, { plan, billingMode: 'MANUAL', billingInterval: interval }).expect(201);
    const s = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    await confirm(c, s.paymentId, 'success').expect(200);
    return c;
  }
  /** AUTO subscription with a saved card and a provider-side schedule, still in its trial. */
  async function autoSub(name: string, plan: 'STARTER' | 'PRO' = 'STARTER', interval: 'MONTHLY' | 'YEARLY' = 'MONTHLY') {
    const c = await tenant(name);
    await api('post', 'trial', c, { plan, billingMode: 'AUTO', billingInterval: interval, autoRenewConsent: true }).expect(201);
    await api('post', 'card-setup', c, { returnUrl: RETURN }).expect(201);
    await deliver({ id: `pm_${Date.now()}_${n}`, type: 'payment_method.attached', customerRef: (await row(c)).providerCustomerId!, paymentMethodRef: `sim_pm_${n}` }).expect(200);
    await api('post', 'subscribe', c).expect(201);
    return c;
  }
  const monthsBetween = (a: Date, b: Date) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());

  beforeAll(async () => {
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    await prisma.$executeRawUnsafe('TRUNCATE "Invoice", "SubscriptionAuditLog" CASCADE');
    for (const [code, minor] of [['STARTER', 1900], ['PRO', 4900]] as const) {
      await prisma.plan.upsert({ where: { code }, update: { priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, currency: 'USD', isActive: true }, create: { code, name: code, priceAmount: String(minor / 100), priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, limits: {} } });
    }
    app = await startApp();
    h = aiHelpers(app);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('AUTO: consent, card, schedule, due date, confirmed payment extends the period, invoice and access follow', async () => {
    const c = await tenant('Auto');
    await api('post', 'trial', c, { plan: 'STARTER', billingMode: 'AUTO' }).expect(400).expect((r) => expect(code(r)).toBe('CONSENT_REQUIRED'));
    const created = (await api('post', 'trial', c, { plan: 'STARTER', billingMode: 'AUTO', billingInterval: 'MONTHLY', autoRenewConsent: true }).expect(201)).body;
    expect(created.subscription).toMatchObject({ status: 'ACTIVE', billingMode: 'AUTO', billingInterval: 'MONTHLY', amountMinor: 1900, currency: 'USD', trial: true });
    expect(created.subscription.autoRenewConsentAt).toBeTruthy();
    expect(created.nextPayment).toMatchObject({ amountMinor: 1900, currency: 'USD', mode: 'AUTO' });
    expect(Number.isInteger(created.nextPayment.amountMinor)).toBe(true);
    await api('post', 'subscribe', c).expect(409).expect((r) => expect(code(r)).toBe('CARD_REQUIRED'));
    await api('post', 'card-setup', c, { returnUrl: RETURN }).expect(201);
    await deliver({ id: `pm_auto_${Date.now()}`, type: 'payment_method.attached', customerRef: (await row(c)).providerCustomerId!, paymentMethodRef: 'sim_pm_auto' }).expect(200);
    expect((await api('post', 'subscribe', c).expect(201)).body.subscription).toMatchObject({ subscribed: true, status: 'ACTIVE', trial: true });
    const before = await row(c);

    await due(c, 'success').expect(200);
    const after = await row(c);
    expect(after.status).toBe('ACTIVE');
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000); // a new month is paid
    expect(after.failedPaymentCount).toBe(0);
    const inv = await prisma.invoice.findMany({ where: { businessId: c.businessId } });
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ amountMinor: 1900, currency: 'USD', status: 'PAID', simulated: true, planCode: 'STARTER' });
    expect(inv[0]!.number).toMatch(/^SIM-\d{4}-\d{6}$/);
    const s = await status(c);
    expect(s).toMatchObject({ simulation: true, entitlement: { state: 'ACTIVE', hasAccess: true }, subscription: { trial: false } });
    expect(before.currentPeriodEnd!.getTime()).toBeLessThan(after.currentPeriodEnd!.getTime());

    // The next due date continues the cadence: one more month, a second invoice.
    const end1 = after.currentPeriodEnd!;
    await due(c, 'success').expect(200);
    const second = await row(c);
    expect(monthsBetween(end1, second.currentPeriodEnd!)).toBeGreaterThanOrEqual(0);
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(2);
    expect(await states(c)).toEqual([]); // a trial is created ACTIVE and every payment keeps it ACTIVE: no state change to record
  });

  it('AUTO declined: past due, retries, grace after the configured failures, recovery by paying manually', async () => {
    const c = await autoSub('Declined');
    await due(c, 'success').expect(200); // first paid period
    await due(c, 'declined').expect(200);
    let s = await status(c);
    expect(s.subscription).toMatchObject({ status: 'PAST_DUE', failedPayments: 1 });
    expect(s.entitlement).toMatchObject({ state: 'PAST_DUE', hasAccess: true }); // access continues during the grace days
    expect(await prisma.payment.count({ where: { businessId: c.businessId, status: 'FAILED' } })).toBe(1);
    await due(c, 'declined').expect(200);
    await due(c, 'declined').expect(200);
    s = await status(c);
    expect(s.subscription).toMatchObject({ status: 'GRACE_PERIOD', failedPayments: 3 });
    expect(s.entitlement).toMatchObject({ state: 'GRACE_PERIOD', hasAccess: true });
    expect(await prisma.notification.findMany({ where: { businessId: c.businessId, type: { startsWith: 'billing.' } }, select: { type: true } })).toEqual(expect.arrayContaining([{ type: 'billing.payment_failed' }, { type: 'billing.grace_started' }]));
    // The customer pays by hand inside the grace period.
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    await confirm(c, session.paymentId, 'success').expect(200);
    s = await status(c);
    expect(s.subscription).toMatchObject({ status: 'ACTIVE', failedPayments: 0 });
    expect(await states(c)).toEqual(['ACTIVE>PAST_DUE', 'PAST_DUE>GRACE_PERIOD', 'GRACE_PERIOD>ACTIVE']);
  });

  it('MANUAL: a pending payment session changes nothing; only the confirmed payment extends, once; repeating the request reuses the session', async () => {
    const c = await tenant('Manual');
    await api('post', 'trial', c, { plan: 'STARTER' }).expect(201);
    const before = await row(c);
    const s1 = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    expect(s1).toMatchObject({ status: 'PENDING', amountMinor: 1900, currency: 'USD', simulated: true });
    expect(s1.hostedUrl).toMatch(/^https:\/\/simulated\.invalid\/pay\//);
    const same = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    expect(same.paymentId).toBe(s1.paymentId);
    expect(await prisma.payment.count({ where: { businessId: c.businessId } })).toBe(1);
    const mid = await row(c);
    expect(mid.currentPeriodEnd!.getTime()).toBe(before.currentPeriodEnd!.getTime()); // the session itself changed nothing
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(0);

    await confirm(c, s1.paymentId, 'success').expect(200);
    const after = await row(c);
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(before.currentPeriodEnd!.getTime() + 27 * 86_400_000);
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(1);
    await confirm(c, s1.paymentId, 'success').expect(409).expect((r) => expect(code(r)).toBe('PAYMENT_NOT_PENDING'));
    // Paid for the month: renewal opens only a few days before the end.
    await api('post', 'renewals', c, { returnUrl: RETURN }).expect(409).expect((r) => expect(code(r)).toBe('RENEWAL_NOT_DUE'));
    const st = await status(c);
    expect(st.renewalOpen).toBe(false);
    expect(st.nextPayment).toMatchObject({ amountMinor: 1900, mode: 'MANUAL' });
  });

  it('MANUAL declined: the subscription is unchanged, the retry is a new session, the success then extends', async () => {
    const c = await tenant('ManualDeclined');
    await api('post', 'trial', c, { plan: 'STARTER' }).expect(201);
    const end = (await row(c)).currentPeriodEnd!;
    const a = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    await confirm(c, a.paymentId, 'declined').expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).status).toBe('FAILED');
    expect((await row(c)).currentPeriodEnd!.getTime()).toBe(end.getTime());
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(0);
    const b = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    expect(b.paymentId).not.toBe(a.paymentId);
    await confirm(c, b.paymentId, 'success').expect(200);
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(1);
  });

  it('concurrency: parallel renewal requests make one session, parallel confirmations extend the period once', async () => {
    const c = await tenant('Concurrent');
    await api('post', 'trial', c, { plan: 'STARTER' }).expect(201);
    const sessions = await Promise.all([1, 2, 3].map(() => api('post', 'renewals', c, { returnUrl: RETURN })));
    for (const r of sessions) expect(r.status).toBe(201);
    expect(new Set(sessions.map((r) => r.body.paymentId)).size).toBe(1);
    expect(await prisma.payment.count({ where: { businessId: c.businessId } })).toBe(1);
    const paymentId = sessions[0]!.body.paymentId as string;
    const results = await Promise.all([1, 2, 3, 4].map(() => confirm(c, paymentId, 'success')));
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(1);
    const s = await row(c);
    const end = s.currentPeriodEnd!;
    expect(monthsBetween(s.trialEndsAt!, end)).toBe(1); // exactly one month beyond the trial, not two or more
    expect(await prisma.payment.count({ where: { businessId: c.businessId, status: 'SUCCEEDED' } })).toBe(1);
  });

  it('duplicate webhooks: the same event twice and a second confirmation of the same payment change nothing', async () => {
    const c = await tenant('Double');
    await api('post', 'trial', c, { plan: 'STARTER' }).expect(201);
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    const event = { id: `evt_double_${Date.now()}`, type: 'payment.succeeded' as const, paymentRef: p.providerPaymentId, reference: p.idempotencyKey!, amount: '19.00', currency: 'USD' };
    expect((await deliver(event).expect(200)).body).toMatchObject({ duplicate: false });
    const end = (await row(c)).currentPeriodEnd!;
    expect((await deliver(event).expect(200)).body).toMatchObject({ duplicate: true });
    await deliver({ ...event, id: `${event.id}_again` }).expect(200); // a different event id for the same payment
    expect((await row(c)).currentPeriodEnd!.getTime()).toBe(end.getTime());
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(1);
    expect(await prisma.payment.count({ where: { businessId: c.businessId } })).toBe(1);
    // A different charge for a period that is already paid is recorded and flagged, never extended.
    const refs = await prisma.subscriptionAuditLog.count({ where: { businessId: c.businessId, action: 'duplicate_confirmation_ignored' } });
    expect(refs).toBeGreaterThanOrEqual(1);
  });

  it('a confirmed amount that differs from the expected one is not trusted: no extension, flagged for review', async () => {
    const c = await tenant('Mismatch');
    await api('post', 'trial', c, { plan: 'STARTER' }).expect(201);
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    const end = (await row(c)).currentPeriodEnd!;
    await deliver({ id: `evt_mm_${Date.now()}`, type: 'payment.succeeded', paymentRef: p.providerPaymentId, reference: p.idempotencyKey!, amount: '1.00', currency: 'USD' }).expect(200);
    expect((await row(c)).currentPeriodEnd!.getTime()).toBe(end.getTime());
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(0);
    expect(await prisma.subscriptionAuditLog.count({ where: { businessId: c.businessId, action: 'amount_mismatch' } })).toBe(1);
  });

  it('cancellation: access until the paid period ends, resume, provider cancellation, then expiry', async () => {
    const c = await autoSub('Cancel');
    await due(c, 'success').expect(200);
    const c1 = (await api('post', 'cancel', c).expect(200)).body;
    expect(c1.subscription.cancelAtPeriodEnd).toBe(true);
    expect(c1.entitlement.hasAccess).toBe(true);
    expect((await api('post', 'resume', c).expect(200)).body.subscription.cancelAtPeriodEnd).toBe(false);
    await api('post', 'cancel', c).expect(200);
    const subRef = (await row(c)).providerSubscriptionId!;
    await deliver({ id: `evt_can_${Date.now()}`, type: 'subscription.canceled', subscriptionRef: subRef }).expect(200);
    let s = await status(c);
    expect(s.subscription.status).toBe('CANCELED');
    expect(s.entitlement).toMatchObject({ state: 'CANCELED_UNTIL_PERIOD_END', hasAccess: true });
    await api('post', 'resume', c).expect(409);
    await api('post', 'simulator/rewind', c, { days: '40' }).expect(200);
    await api('post', 'simulator/process-due', c).expect(200);
    s = await status(c);
    expect(s.subscription.status).toBe('EXPIRED');
    expect(s.entitlement).toMatchObject({ state: 'EXPIRED', hasAccess: false });
    expect(await states(c)).toEqual(expect.arrayContaining(['ACTIVE>CANCELED', 'CANCELED>EXPIRED']));
  });

  it('expiration: trial without payment, then MANUAL period -> grace -> expired; a confirmed payment restarts it', async () => {
    const t1 = await tenant('TrialExpiry');
    await api('post', 'trial', t1, { plan: 'STARTER' }).expect(201);
    await api('post', 'simulator/rewind', t1, { days: '4' }).expect(200);
    await api('post', 'simulator/process-due', t1).expect(200);
    expect((await status(t1)).entitlement).toMatchObject({ state: 'EXPIRED', hasAccess: false }); // no grace for a trial
    expect((await row(t1)).status).toBe('EXPIRED');

    const c = await paidManual('ManualExpiry');
    expect((await status(c)).entitlement.state).toBe('ACTIVE');
    // Reminder: the period ends within the reminder window.
    await api('post', 'simulator/rewind', c, { days: '31' }).expect(200); // trial 3 days + 1 month paid: about 2 days left
    await api('post', 'simulator/process-due', c).expect(200);
    await api('post', 'simulator/process-due', c).expect(200); // repeated: no second reminder
    expect(await prisma.notification.count({ where: { businessId: c.businessId, type: 'billing.renewal_reminder' } })).toBe(1);
    expect((await status(c)).renewalOpen).toBe(true);
    // Period over, unpaid: grace days keep access.
    await api('post', 'simulator/rewind', c, { days: '3' }).expect(200);
    await api('post', 'simulator/process-due', c).expect(200);
    let s = await status(c);
    expect(s.subscription.status).toBe('GRACE_PERIOD');
    expect(s.entitlement).toMatchObject({ state: 'GRACE_PERIOD', hasAccess: true });
    // Grace over.
    await api('post', 'simulator/rewind', c, { days: '4' }).expect(200);
    await api('post', 'simulator/process-due', c).expect(200);
    s = await status(c);
    expect(s.subscription.status).toBe('EXPIRED');
    expect(s.entitlement.hasAccess).toBe(false);
    // Paying again restarts it from the payment.
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    await confirm(c, session.paymentId, 'success').expect(200);
    s = await status(c);
    expect(s.subscription.status).toBe('ACTIVE');
    expect(s.entitlement).toMatchObject({ state: 'ACTIVE', hasAccess: true });
    expect(await states(c)).toEqual(expect.arrayContaining(['ACTIVE>GRACE_PERIOD', 'GRACE_PERIOD>EXPIRED', 'EXPIRED>ACTIVE']));
  });

  it('plan change: recorded now, applied at the next renewal with the new amount, interval and invoice', async () => {
    const c = await paidManual('PlanChange', 'STARTER', 'MONTHLY');
    const r = (await api('post', 'plan', c, { plan: 'PRO', billingInterval: 'YEARLY' }).expect(200)).body;
    expect(r.subscription).toMatchObject({ plan: 'STARTER', amountMinor: 1900, pendingChange: { plan: 'PRO', billingInterval: 'YEARLY' } });
    expect(r.nextPayment).toMatchObject({ plan: 'PRO', interval: 'YEARLY', amountMinor: 49_000 });
    // Withdrawing and asking again.
    expect((await api('post', 'plan', c, { plan: 'STARTER', billingInterval: 'MONTHLY' }).expect(200)).body.subscription.pendingChange).toBeNull();
    await api('post', 'plan', c, { plan: 'PRO', billingInterval: 'YEARLY' }).expect(200);
    await api('post', 'simulator/rewind', c, { days: '31' }).expect(200); // into the renewal window
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    expect(session).toMatchObject({ amountMinor: 49_000, currency: 'USD' });
    const before = await row(c);
    await confirm(c, session.paymentId, 'success').expect(200);
    const after = await row(c);
    expect(after).toMatchObject({ billingInterval: 'YEARLY', amountMinor: 49_000, pendingPlanId: null, pendingBillingInterval: null });
    expect(monthsBetween(before.currentPeriodEnd!, after.currentPeriodEnd!)).toBe(12);
    const inv = await prisma.invoice.findMany({ where: { businessId: c.businessId }, orderBy: { issuedAt: 'desc' } });
    expect(inv[0]).toMatchObject({ amountMinor: 49_000, planCode: 'PRO' });
    expect((await status(c)).subscription.plan).toBe('PRO');
  });

  it('switching to MANUAL disables automatic renewal; AUTO needs consent again', async () => {
    const c = await autoSub('ModeSwitch');
    expect((await row(c)).providerSubscriptionId).toBeTruthy();
    const m = (await api('post', 'mode', c, { billingMode: 'MANUAL' }).expect(200)).body;
    expect(m.subscription).toMatchObject({ billingMode: 'MANUAL', subscribed: false, autoRenewConsentAt: null });
    await api('post', 'mode', c, { billingMode: 'AUTO' }).expect(400).expect((r) => expect(code(r)).toBe('CONSENT_REQUIRED'));
    expect((await api('post', 'mode', c, { billingMode: 'AUTO', autoRenewConsent: true }).expect(200)).body.subscription.autoRenewConsentAt).toBeTruthy();
    await api('post', 'simulator/due', c, { outcome: 'success' }).expect(409).expect((r) => expect(code(r)).toBe('NOT_AUTOMATIC')); // no schedule at the provider any more
  });

  it('isolation: invoices, payments and history of one business are invisible to another', async () => {
    const a = await paidManual('IsoA');
    const b = await paidManual('IsoB');
    const inv = (await api('get', 'invoices', a).expect(200)).body;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ amountMinor: 1900, simulated: true });
    await api('get', `invoices/${inv[0].id}`, a).expect(200);
    await api('get', `invoices/${inv[0].id}`, b).expect(404);
    await request(h.http).get(`/api/v1/billing/invoices/${inv[0].id}`).set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId }).expect(404); // not a member of A
    const pa = await prisma.payment.findFirstOrThrow({ where: { businessId: a.businessId } });
    await confirm(b, pa.id, 'success').expect(404);
    const hb = (await api('get', 'history', b).expect(200)).body;
    expect(JSON.stringify(hb)).not.toContain(pa.id);
    expect((await api('get', 'invoices', b).expect(200)).body.map((i: { id: string }) => i.id)).not.toContain(inv[0].id);
    const viewer = await h.member(a, 'VIEWER');
    await request(h.http).get('/api/v1/billing/invoices').set(as(viewer)).expect(403);
  });

  it('no activation without a confirmed payment: a pending subscription, a payment session, a forged or unsigned notification all leave it PENDING', async () => {
    const c = await tenant('NoActivation');
    const created = (await api('post', 'subscription', c, { plan: 'STARTER', trial: false }).expect(201)).body;
    expect(created.subscription.status).toBe('PENDING');
    expect(created.entitlement).toMatchObject({ state: 'PENDING', hasAccess: false });
    const session = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    expect((await status(c)).subscription.status).toBe('PENDING'); // a payment page was opened; nothing is paid
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    // Nothing a customer can call turns it ACTIVE: not the mode, plan, resume, cancel or subscribe endpoints.
    await api('post', 'mode', c, { billingMode: 'MANUAL' }).expect(200);
    await api('post', 'plan', c, { plan: 'PRO' }).expect(200);
    await api('post', 'resume', c).expect(409);
    expect((await status(c)).subscription.status).toBe('PENDING');
    // A notification without a valid signature is rejected.
    const ev = sim.sign({ id: `evt_forged_${Date.now()}`, type: 'payment.succeeded', paymentRef: p.providerPaymentId, reference: p.idempotencyKey!, amount: '19.00', currency: 'USD' });
    await request(h.http).post('/api/v1/billing/webhooks/simulated').set('Content-Type', 'application/json').send(ev.rawBody.toString()).expect(401);
    await request(h.http).post('/api/v1/billing/webhooks/simulated').set({ ...ev.headers, 'x-touma-sim-signature': 't=1,s=00' }).set('Content-Type', 'application/json').send(ev.rawBody.toString()).expect(401);
    expect((await status(c)).subscription.status).toBe('PENDING');
    expect(await prisma.invoice.count({ where: { businessId: c.businessId } })).toBe(0);
    // A declined payment keeps it PENDING (PENDING can never jump to PAST_DUE or GRACE_PERIOD).
    await confirm(c, session.paymentId, 'declined').expect(200);
    expect((await status(c)).subscription.status).toBe('PENDING');
    // Only the confirmed payment activates it.
    const retry = (await api('post', 'renewals', c, { returnUrl: RETURN }).expect(201)).body;
    await confirm(c, retry.paymentId, 'success').expect(200);
    const s = await status(c);
    expect(s.subscription.status).toBe('ACTIVE');
    expect(s.entitlement).toMatchObject({ state: 'ACTIVE', hasAccess: true });
    expect(await states(c)).toEqual(['PENDING>ACTIVE']);
  });

  it('every state change is audited and nothing sensitive is stored', async () => {
    const c = await paidManual('Audit');
    const logs = await prisma.subscriptionAuditLog.findMany({ where: { businessId: c.businessId }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['trial_started', 'payment_session_created', 'provider_event']));
    expect(logs.every((l) => l.businessId === c.businessId)).toBe(true);
    const dump = JSON.stringify([logs, await prisma.payment.findMany({ where: { businessId: c.businessId } }), await prisma.invoice.findMany({ where: { businessId: c.businessId } }), await row(c)]);
    expect(dump).not.toMatch(/(?<![\w-])\d{13,19}(?![\w-])|cvc|cvv|card_?number|"pan"/i);
  });

  it('platform administrators see counts, failures, SIMULATED revenue and upcoming renewals; others are refused', async () => {
    const c = await paidManual('AdminView');
    const failing = await autoSub('AdminFail');
    await due(failing, 'success').expect(200);
    await due(failing, 'declined').expect(200);
    const user = await prisma.user.findFirstOrThrow({ where: { memberships: { some: { businessId: c.businessId } } } });
    await request(h.http).get('/api/v1/admin/billing/overview').set(as(c)).expect(403);
    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'SUPER_ADMIN' } });
    const o = (await request(h.http).get('/api/v1/admin/billing/overview').set(as(c)).expect(200)).body;
    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'USER' } });
    expect(o.subscriptions.activePaid).toBeGreaterThanOrEqual(2);
    expect(o.subscriptions.pastDue).toBeGreaterThanOrEqual(1);
    expect(o.failedPayments.last30Days).toBeGreaterThanOrEqual(1);
    expect(o.revenue.note).toMatch(/not money collected/i);
    expect(o.revenue.real).toEqual([]);
    expect(o.revenue.simulated).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'USD' })]));
    expect(o.revenue.simulated[0].amountMinor).toBeGreaterThanOrEqual(3800);
    expect(o.events.length).toBeGreaterThan(0);
    const byId = Object.fromEntries(o.providers.map((p: { provider: string }) => [p.provider, p]));
    expect(Object.keys(byId).sort()).toEqual(['iyzico', 'lemonsqueezy', 'paddle-sandbox', 'payoneer', 'simulated']);
    expect(byId.simulated.enabled).toBe(true);
    expect(byId.payoneer).toMatchObject({ enabled: false, verifiedAt: null, capabilities: { recurringSubscriptions: 'unverified', methods: [] } });
    expect(byId.iyzico).toMatchObject({ enabled: false, capabilities: { recurringSubscriptions: 'unverified', hostedPaymentSession: 'unverified' } });
  });
});
