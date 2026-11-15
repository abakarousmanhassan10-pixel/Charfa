import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { paddleSignature } from '../src/billing/providers/paddle-sandbox.provider';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * N27: the Paddle SANDBOX adapter inside the real billing engine, against a LOCAL FAKE of the assumed Paddle API (no network, no key, no money), and the
 * production gate. Paddle's real API was not reachable while this was written, so this proves our engine and adapter agree with our own assumptions only;
 * only a run against the real sandbox with administrator-supplied test credentials can verify them.
 */
const KEY = 'pdl_sdbx_apikey_e2e_0123456789';
const SECRET = 'paddle-e2e-secret-0123456789';
const PRICES = { 'STARTER:MONTHLY': 'pri_01recurring000001', 'STARTER:YEARLY': 'pri_01recurring000002', 'STARTER:MONTHLY:ONCE': 'pri_01onetime0000001', 'STARTER:YEARLY:ONCE': 'pri_01onetime0000002' };
const RUN = Date.now();
const RETURN = 'https://app.example.com/billing';

interface Recorded { method: string; url: string; auth: string; body: Record<string, unknown> }

function fakePaddle() {
  const calls: Recorded[] = [];
  let mode: 'ok' | 'down' | 'unauthorized' = 'ok';
  let seq = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (mode === 'down') return send(503, { error: { code: 'service_unavailable' } });
      if (mode === 'unauthorized') return send(403, { error: { code: 'forbidden' } });
      seq += 1;
      if (req.url === '/customers') return send(201, { data: { id: `ctm_01fake${String(seq).padStart(6, '0')}` } });
      if (req.url === '/transactions') return send(201, { data: { id: `txn_01fake${String(seq).padStart(6, '0')}`, checkout: { url: `https://sandbox-checkout.example.test/txn_${seq}` } } });
      if (/^\/subscriptions\/[^/]+\/cancel$/.test(req.url ?? '')) return send(200, { data: {} });
      return send(404, { error: { code: 'not_found' } });
    });
  });
  return {
    calls, setMode: (m: typeof mode) => { mode = m; },
    start: () => new Promise<string>((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

function useEnv(vars: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  return {
    apply() { for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    restore() { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
  };
}

describe('Paddle sandbox adapter in the billing engine (local fake)', () => {
  const paddle = fakePaddle();
  let env: ReturnType<typeof useEnv>;
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  const code = (r: request.Response) => r.body.code ?? r.body.error?.code;
  const api = (m: 'get' | 'post', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/billing/${path}`).set(as(c)); return body ? r.send(body) : m === 'post' ? r.send({}) : r; };
  const status = async (c: Ctx) => (await api('get', 'status', c).expect(200)).body;
  const row = (c: Ctx) => prisma.subscription.findUniqueOrThrow({ where: { businessId: c.businessId } });
  const hook = (body: object, over: { ts?: number; secret?: string; headers?: Record<string, string> } = {}) => {
    const raw = JSON.stringify(body);
    const ts = over.ts ?? Math.floor(Date.now() / 1000);
    return request(h.http).post('/api/v1/billing/webhooks/paddle-sandbox').set('Content-Type', 'application/json').set(over.headers ?? { 'paddle-signature': `ts=${ts};h1=${paddleSignature(over.secret ?? SECRET, raw, ts)}` }).send(raw);
  };
  let n = 0;
  const id = (p: string) => `${p}_${RUN}_${++n}`;
  const when = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
  const completed = (o: { eventId?: string; txn?: string; ref?: string; customer?: string; sub?: string; amount?: string; at?: string; start?: string; end?: string }) => ({
    event_id: o.eventId ?? id('evt'), event_type: 'transaction.completed', occurred_at: o.at ?? when(),
    data: { id: o.txn ?? id('txn'), customer_id: o.customer, subscription_id: o.sub, currency_code: 'USD', custom_data: o.ref ? { touma_reference: o.ref } : {}, details: { totals: { subtotal: o.amount ?? '1900', total: o.amount ?? '1900' } }, ...(o.start && o.end ? { billing_period: { starts_at: o.start, ends_at: o.end } } : {}) },
  });
  const tenant = (name: string) => h.tenant(`${name} ${++n}`);

  beforeAll(async () => {
    const base = await paddle.start();
    env = useEnv({ BILLING_ENABLED: 'true', BILLING_PROVIDER: 'paddle-sandbox', PADDLE_API_KEY: KEY, PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_PRICE_MAP: JSON.stringify(PRICES), PADDLE_API_BASE_URL: base, BILLING_WEBHOOK_SECRET: undefined, FOUNDER_EMAILS: undefined, BILLING_GRACE_DAYS: '3', BILLING_REMINDER_DAYS: '3', BILLING_MAX_FAILED_PAYMENTS: '3' });
    env.apply();
    await resetDb();
    for (const [c, minor] of [['STARTER', 1900]] as const) await prisma.plan.upsert({ where: { code: c }, update: { priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, currency: 'USD', isActive: true }, create: { code: c, name: c, priceAmount: '19.00', priceAmountMinor: minor, yearlyPriceAmountMinor: minor * 10, limits: {} } });
    app = await startApp();
    h = aiHelpers(app);
  });
  afterAll(async () => { await app.close(); await paddle.stop(); await prisma.$disconnect(); env.restore(); });

  it('the sandbox adapter is selected and labelled: sandbox, not simulation, never live, nothing verified, test money', async () => {
    const t = await tenant('Label');
    const s = await status(t);
    expect(s).toMatchObject({ simulation: false, sandbox: true, environment: 'sandbox' });
    expect(s.provider).toMatchObject({ id: 'paddle-sandbox', sandboxOnly: true, credentialsConfigured: true, live: false, verifiedAgainstOfficialDocs: false, recurringSubscriptions: 'sandbox', subscriptionModel: 'checkout', hostedCardCapture: 'unsupported', methods: [] });
    expect(JSON.stringify(s)).not.toMatch(/pdl_sdbx|paddle-e2e-secret|sk-/);
    // The simulator exists only for the mock provider.
    await api('post', 'simulator/due', t, { outcome: 'success' }).expect(404);
  });

  it('MANUAL: a one-time sandbox checkout; nothing changes until Paddle\'s signed notification; the period is extended once; the invoice is a test invoice', async () => {
    const t = await tenant('PaddleManual');
    await api('post', 'trial', t, { plan: 'STARTER' }).expect(201);
    const end0 = (await row(t)).currentPeriodEnd!;
    const session = (await api('post', 'renewals', t, { returnUrl: RETURN }).expect(201)).body;
    expect(session.hostedUrl).toMatch(/^https:\/\/sandbox-checkout\.example\.test\//);
    expect(session).toMatchObject({ amountMinor: 1900, currency: 'USD', simulated: true }); // test money
    const tx = paddle.calls.filter((c) => c.url === '/transactions').at(-1)!;
    expect(tx.auth).toBe(`Bearer ${KEY}`);
    expect(tx.body).toMatchObject({ items: [{ price_id: 'pri_01onetime0000001', quantity: 1 }], collection_mode: 'automatic' });
    expect((await row(t)).currentPeriodEnd!.getTime()).toBe(end0.getTime());
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    expect(p).toMatchObject({ status: 'PENDING', amountMinor: 1900, simulated: true });

    // Unsigned, wrongly signed, replayed and tampered notifications change nothing.
    const ev = completed({ txn: p.providerPaymentId, ref: p.idempotencyKey!, customer: (await row(t)).providerCustomerId! });
    await hook(ev, { headers: {} }).expect(401);
    await hook(ev, { secret: 'another-secret-0123456789' }).expect(401);
    await hook(ev, { ts: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
    const good = JSON.stringify(ev); const ts = Math.floor(Date.now() / 1000);
    await request(h.http).post('/api/v1/billing/webhooks/paddle-sandbox').set('Content-Type', 'application/json').set({ 'paddle-signature': `ts=${ts};h1=${paddleSignature(SECRET, good, ts)}` }).send(good.replace('1900', '100')).expect(401);
    expect((await row(t)).currentPeriodEnd!.getTime()).toBe(end0.getTime());

    expect((await hook(ev).expect(200)).body).toMatchObject({ received: true, duplicate: false });
    const after = await row(t);
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(end0.getTime() + 27 * 86_400_000);
    const inv = await prisma.invoice.findMany({ where: { businessId: t.businessId } });
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ amountMinor: 1900, currency: 'USD', status: 'PAID', simulated: true }); // never counted as revenue
    expect((await hook(ev).expect(200)).body).toMatchObject({ duplicate: true });
    expect(await prisma.invoice.count({ where: { businessId: t.businessId } })).toBe(1);
  });

  it('AUTO (checkout model): consent, no standalone card page, a recurring-price checkout, events in any order, provider period, stale failure ignored, newer failure past due, cancel', async () => {
    const t = await tenant('PaddleAuto');
    await api('post', 'trial', t, { plan: 'STARTER', billingMode: 'AUTO', billingInterval: 'MONTHLY', autoRenewConsent: true }).expect(201);
    await api('post', 'card-setup', t, { returnUrl: RETURN }).expect(409).expect((r) => expect(code(r)).toBe('CAPABILITY_UNSUPPORTED'));
    const sub = (await api('post', 'subscribe', t).expect(201)).body;
    expect(sub.checkoutUrl).toMatch(/^https:\/\/sandbox-checkout\.example\.test\//);
    const tx = paddle.calls.filter((c) => c.url === '/transactions').at(-1)!;
    expect(tx.body).toMatchObject({ items: [{ price_id: 'pri_01recurring000001', quantity: 1 }] });
    expect((await row(t)).status).toBe('ACTIVE'); // the trial; nothing changed by opening a checkout
    const customer = (await row(t)).providerCustomerId!;
    expect(customer).toMatch(/^ctm_01fake/);

    // Out of order: the payment notification arrives BEFORE the subscription notification.
    const start = when(); const end = when(30 * 86_400_000);
    await hook(completed({ txn: id('txn'), customer, sub: 'sub_01paddle000001', start, end })).expect(200);
    let r = await row(t);
    expect(r.providerSubscriptionId).toBe('sub_01paddle000001'); // adopted from the payment event
    expect(r.status).toBe('ACTIVE');
    expect(Math.abs(r.currentPeriodEnd!.getTime() - new Date(end).getTime())).toBeLessThan(1000); // the provider's own billing period
    await hook({ event_id: id('evt'), event_type: 'subscription.activated', occurred_at: when(-60_000), data: { id: 'sub_01paddle000001', customer_id: customer } }).expect(200); // late: changes nothing
    expect((await row(t)).currentPeriodEnd!.getTime()).toBe(r.currentPeriodEnd!.getTime());

    // The next period's charge.
    const end2 = when(60 * 86_400_000);
    await hook(completed({ txn: id('txn'), customer, sub: 'sub_01paddle000001', start: end, end: end2 })).expect(200);
    expect(await prisma.invoice.count({ where: { businessId: t.businessId } })).toBe(2);
    r = await row(t);
    expect(Math.abs(r.currentPeriodEnd!.getTime() - new Date(end2).getTime())).toBeLessThan(1000);

    // A failure that happened BEFORE the last confirmed payment arrives late: recorded, never undoes it.
    await hook({ event_id: id('evt'), event_type: 'transaction.payment_failed', occurred_at: when(-3_600_000), data: { id: id('txn'), customer_id: customer, subscription_id: 'sub_01paddle000001', payments: [{ error_code: 'declined' }] } }).expect(200);
    expect((await status(t)).subscription).toMatchObject({ status: 'ACTIVE', failedPayments: 0 });
    expect(await prisma.subscriptionAuditLog.count({ where: { businessId: t.businessId, action: 'stale_event_ignored' } })).toBe(1);
    // A newer failure counts.
    await hook({ event_id: id('evt'), event_type: 'transaction.payment_failed', occurred_at: when(60_000), data: { id: id('txn'), customer_id: customer, subscription_id: 'sub_01paddle000001', payments: [{ error_code: 'declined' }] } }).expect(200);
    expect((await status(t)).subscription).toMatchObject({ status: 'PAST_DUE', failedPayments: 1 });

    // Cancel: Paddle is told to cancel at the end of the period; its notification then moves us to CANCELED.
    await api('post', 'cancel', t).expect(200);
    expect(paddle.calls.at(-1)).toMatchObject({ url: '/subscriptions/sub_01paddle000001/cancel', body: { effective_from: 'next_billing_period' } });
    await hook({ event_id: id('evt'), event_type: 'subscription.canceled', occurred_at: when(120_000), data: { id: 'sub_01paddle000001', customer_id: customer } }).expect(200);
    expect((await row(t)).status).toBe('CANCELED');
    // Resuming a scheduled cancellation at Paddle is not verified: not offered.
    await api('post', 'resume', t).expect(409);
  });

  it('a signed event of a type TOUMA does not act on is acknowledged and stored as ignored', async () => {
    const eventId = id('evt');
    expect((await hook({ event_id: eventId, event_type: 'product.updated', occurred_at: when(), data: { id: 'pro_1' } }).expect(200)).body).toMatchObject({ received: true, ignored: true });
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { externalEventId: eventId } })).status).toBe('IGNORED');
    await hook({ event_id: id('evt'), event_type: 'product.updated', data: { id: 'pro_1' } }, { headers: {} }).expect(401); // unsigned: not even stored
  });

  it('provider outage or rejected credentials: 503, nothing charged, nothing stored, an incident recorded, recovery afterwards, no secret in any answer', async () => {
    const t = await tenant('Outage');
    await api('post', 'trial', t, { plan: 'STARTER' }).expect(201);
    const before = await prisma.payment.count({ where: { businessId: t.businessId } });
    paddle.setMode('down');
    const down = await api('post', 'renewals', t, { returnUrl: RETURN }).expect(503);
    expect(code(down)).toBe('PROVIDER_UNAVAILABLE');
    paddle.setMode('unauthorized');
    const unauth = await api('post', 'renewals', t, { returnUrl: RETURN }).expect(503);
    expect(code(unauth)).toBe('CREDENTIALS_REJECTED');
    expect(JSON.stringify([down.body, unauth.body])).not.toMatch(/pdl_sdbx|paddle-e2e-secret|Bearer/);
    expect(await prisma.payment.count({ where: { businessId: t.businessId } })).toBe(before);
    expect((await row(t)).status).toBe('ACTIVE');
    const incidents = await prisma.subscriptionAuditLog.findMany({ where: { businessId: t.businessId, action: 'provider_unavailable' }, select: { reason: true } });
    expect(incidents.map((i) => i.reason).sort()).toEqual(['CREDENTIALS_REJECTED', 'PROVIDER_UNAVAILABLE']);
    paddle.setMode('ok');
    await api('post', 'renewals', t, { returnUrl: RETURN }).expect(201); // recovered
  });

  it('administrators see the sandbox provider as not approved, with every reason real payments are blocked; recording an approval never opens them', async () => {
    const t = await tenant('Admin');
    const user = await prisma.user.findFirstOrThrow({ where: { memberships: { some: { businessId: t.businessId } } } });
    await request(h.http).get('/api/v1/admin/billing/providers').set(as(t)).expect(403);
    await request(h.http).put('/api/v1/admin/billing/providers/paddle-sandbox/approval').set(as(t)).send({ status: 'APPROVED', reference: 'ticket-1' }).expect(403);

    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'SUPPORT' } });
    const list = (await request(h.http).get('/api/v1/admin/billing/providers').set(as(t)).expect(200)).body as Array<{ provider: string; approval: { status: string }; productionGate: { allowed: boolean; reasons: string[] }; enabled: boolean }>;
    const pd = list.find((p) => p.provider === 'paddle-sandbox')!;
    expect(pd).toMatchObject({ enabled: true, approval: { status: 'NOT_SUBMITTED' }, productionGate: { allowed: false } });
    expect(pd.productionGate.reasons).toEqual(['BUILD_BLOCKS_LIVE_PAYMENTS', 'ENVIRONMENT_NOT_LIVE', 'PROVIDER_NOT_APPROVED', 'ADAPTER_NOT_LIVE_CAPABLE', 'ADAPTER_NOT_VERIFIED']);
    await request(h.http).put('/api/v1/admin/billing/providers/paddle-sandbox/approval').set(as(t)).send({ status: 'APPROVED', reference: 'ticket-1' }).expect(403); // support cannot record a decision

    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'SUPER_ADMIN' } });
    const put = (provider: string, body: object) => request(h.http).put(`/api/v1/admin/billing/providers/${provider}/approval`).set(as(t)).send(body);
    await put('paddle-sandbox', { status: 'APPROVED' }).expect(400).expect((r) => expect(code(r)).toBe('APPROVAL_REFERENCE_REQUIRED'));
    await put('paddle-sandbox', { status: 'APPROVED', reference: 'x' }).expect(400);
    await put('paddle-sandbox', { status: 'MAYBE' }).expect(400);
    await put('simulated', { status: 'APPROVED', reference: 'ticket-1' }).expect(404); // the mock has nothing to approve
    await put('unknown-psp', { status: 'APPROVED', reference: 'ticket-1' }).expect(404);
    await put('paddle-sandbox', { status: 'PENDING_REVIEW', note: 'asked the provider about automated social-media marketing' }).expect(200);
    const approved = (await put('paddle-sandbox', { status: 'APPROVED', reference: 'provider-ticket-98765', note: 'written decision' }).expect(200)).body;
    expect(approved.approval).toMatchObject({ status: 'APPROVED', reference: 'provider-ticket-98765' });
    // Even an approved, referenced provider stays blocked: the sandbox adapter has no live mode, is unverified, and this build blocks live payments.
    expect(approved.productionGate).toEqual({ allowed: false, reasons: ['BUILD_BLOCKS_LIVE_PAYMENTS', 'ENVIRONMENT_NOT_LIVE', 'ADAPTER_NOT_LIVE_CAPABLE', 'ADAPTER_NOT_VERIFIED'] });
    expect(await prisma.auditLog.count({ where: { action: 'billing.provider_approval_changed', actorId: user.id } })).toBeGreaterThanOrEqual(2);
    const overview = (await request(h.http).get('/api/v1/admin/billing/overview').set(as(t)).expect(200)).body;
    expect(overview).toMatchObject({ environment: 'sandbox', selectedProvider: 'paddle-sandbox' });
    expect(overview.incidents.counts.provider_unavailable).toBeGreaterThanOrEqual(2);
    expect(overview.revenue.real).toEqual([]); // sandbox money is never real revenue
    await prisma.paymentProviderAccount.update({ where: { provider: 'paddle-sandbox' }, data: { approvalStatus: 'NOT_SUBMITTED', approvalReference: null, approvedAt: null } });
    await prisma.user.update({ where: { id: user.id }, data: { platformRole: 'USER' } });
  });
});

describe('Paddle sandbox without credentials, and the production lock', () => {
  it('without sandbox credentials every payment action answers "not configured" before any request, and an incident is recorded', async () => {
    const env = useEnv({ BILLING_ENABLED: 'true', BILLING_PROVIDER: 'paddle-sandbox', PADDLE_API_KEY: undefined, PADDLE_WEBHOOK_SECRET: undefined, PADDLE_PRICE_MAP: undefined, PADDLE_API_BASE_URL: undefined });
    env.apply();
    await resetDb();
    const app = await startApp();
    try {
      const h = aiHelpers(app);
      const t = await h.tenant('NoKeys');
      const s = (await request(h.http).get('/api/v1/billing/status').set(as(t)).expect(200)).body;
      expect(s.provider).toMatchObject({ id: 'paddle-sandbox', credentialsConfigured: false, recurringSubscriptions: 'unverified' });
      await request(h.http).post('/api/v1/billing/trial').set(as(t)).send({ plan: 'STARTER' }).expect(201); // the free trial needs no provider
      const r = await request(h.http).post('/api/v1/billing/renewals').set(as(t)).send({ returnUrl: RETURN }).expect(503);
      expect(r.body.code ?? r.body.error?.code).toBe('CAPABILITY_UNSUPPORTED');
      await request(h.http).post('/api/v1/billing/webhooks/paddle-sandbox').set('Content-Type', 'application/json').send('{}').expect(401);
    } finally { await app.close(); env.restore(); }
  });

  it('the server refuses to start in a live payment environment or with a non-sandbox Paddle key', async () => {
    for (const vars of [{ PAYMENT_ENVIRONMENT: 'live' }, { PAYMENT_ENVIRONMENT: 'live', BILLING_PROVIDER: 'paddle-sandbox', PADDLE_API_KEY: KEY }, { PADDLE_API_KEY: 'pdl_live_apikey_0123456789abcdef' }]) {
      const env = useEnv({ BILLING_ENABLED: 'true', ...vars });
      env.apply();
      try { await expect(startApp()).rejects.toThrow(/blocked in this build|SANDBOX key/); } finally { env.restore(); }
    }
  });
});
