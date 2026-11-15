import { IgnoredEventError, ProviderUnavailableError, WebhookSignatureError } from '../payment-provider';
import { PaddleSandboxProvider, paddleSignature } from './paddle-sandbox.provider';

const SECRET = 'paddle-test-secret-0123456789';
const KEY = 'pdl_sdbx_apikey_test_0123456789';
const PRICES = { 'STARTER:MONTHLY': 'pri_01recurring000001', 'STARTER:MONTHLY:ONCE': 'pri_01onetime0000001' };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function fakeFetch(handler: (c: Call) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }> | Error) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call: Call = { url: String(url), method: String(init.method), headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = await handler(call);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const make = (f: ReturnType<typeof fakeFetch>, over: Partial<ConstructorParameters<typeof PaddleSandboxProvider>[0]> = {}) => new PaddleSandboxProvider({ apiKey: KEY, webhookSecret: SECRET, priceMap: PRICES, fetchImpl: f.impl, ...over });
const sign = (body: object, ts = Math.floor(Date.now() / 1000), secret = SECRET) => {
  const raw = Buffer.from(JSON.stringify(body));
  return { rawBody: raw, headers: { 'paddle-signature': `ts=${ts};h1=${paddleSignature(secret, raw, ts)}` } };
};

describe('PaddleSandboxProvider (against a local fake of the ASSUMED Paddle API; never the real one)', () => {
  it('reports "sandbox" only with credentials, never "supported", never live, no verified payment method', () => {
    const f = fakeFetch(() => ({ status: 200 }));
    expect(make(f).capabilities()).toEqual({ id: 'paddle-sandbox', recurringSubscriptions: 'sandbox', hostedCardCapture: 'unsupported', hostedPaymentSession: 'sandbox', verifiedWebhooks: 'sandbox', subscriptionModel: 'checkout', sandboxOnly: true, credentialsConfigured: true, methods: [], verifiedAgainstOfficialDocs: false, live: false });
    expect(make(f, { apiKey: undefined, webhookSecret: undefined }).capabilities()).toMatchObject({ recurringSubscriptions: 'unverified', credentialsConfigured: false, live: false });
    // A live key is never accepted by the adapter, whatever the environment loader did.
    expect(make(f, { apiKey: 'pdl_live_apikey_0123456789' }).capabilities()).toMatchObject({ credentialsConfigured: false, recurringSubscriptions: 'unverified' });
  });

  it('refuses every call without sandbox credentials, before any network request', async () => {
    const f = fakeFetch(() => ({ status: 200 }));
    const p = make(f, { apiKey: 'pdl_live_apikey_0123456789' });
    await expect(p.createCustomer({ businessId: 'b', email: 'a@b.co' })).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(make(f, { apiKey: undefined }).cancelSubscription({ subscriptionRef: 'sub_1', atPeriodEnd: true })).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(f.calls).toHaveLength(0);
  });

  it('creates a customer, a one-time payment page (manual renewal) and a recurring checkout (automatic), sending the key only in the Authorization header', async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/customers')) return { status: 201, body: { data: { id: 'ctm_01abc' } } };
      return { status: 201, body: { data: { id: 'txn_01xyz', checkout: { url: 'https://sandbox-checkout.example.test/pay/txn_01xyz' } } } };
    });
    const p = make(f);
    expect(await p.createCustomer({ businessId: 'biz1', email: 'owner@example.com' })).toEqual({ customerRef: 'ctm_01abc' });
    const once = await p.createPaymentSession({ customerRef: 'ctm_01abc', planCode: 'STARTER', interval: 'MONTHLY', amountMinor: 1900, currency: 'USD', reference: 'ref-1', returnUrl: 'https://app.example.com/b' });
    expect(once).toEqual({ sessionRef: 'txn_01xyz', hostedUrl: 'https://sandbox-checkout.example.test/pay/txn_01xyz' });
    const auto = await p.createRecurringCheckout({ customerRef: 'ctm_01abc', planCode: 'STARTER', interval: 'MONTHLY', amountMinor: 1900, currency: 'USD', reference: 'ref-2', returnUrl: 'https://app.example.com/b' });
    expect(auto.checkoutRef).toBe('txn_01xyz');
    const [, txOnce, txAuto] = f.calls;
    expect(txOnce!.url).toBe('https://sandbox-api.paddle.com/transactions'); // the sandbox API, never the live one
    expect(txOnce!.body).toMatchObject({ items: [{ price_id: 'pri_01onetime0000001', quantity: 1 }], collection_mode: 'automatic', custom_data: { touma_reference: 'ref-1' } }); // one-time price, NOT manual-collection invoices
    expect(txAuto!.body).toMatchObject({ items: [{ price_id: 'pri_01recurring000001', quantity: 1 }], custom_data: { touma_reference: 'ref-2' } });
    for (const c of f.calls) { expect(c.headers.authorization).toBe(`Bearer ${KEY}`); expect(JSON.stringify(c.body)).not.toContain(KEY); }
  });

  it('refuses a plan or interval without a configured sandbox price instead of inventing one', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { data: { id: 'txn_1', checkout: { url: 'https://x.test' } } } }));
    await expect(make(f).createRecurringCheckout({ customerRef: 'c', planCode: 'PRO', interval: 'YEARLY', amountMinor: 1, currency: 'USD', reference: 'r', returnUrl: 'https://a.test' })).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(f.calls).toHaveLength(0);
  });

  it('maps provider failures: rejected credentials, rate limit, outage, network error, timeout; never retries a creation, never leaks details', async () => {
    const cases: Array<[string, () => ReturnType<Parameters<typeof fakeFetch>[0]>, string]> = [
      ['401', () => ({ status: 401, body: { error: { detail: 'secret detail' } } }), 'CREDENTIALS_REJECTED'],
      ['429', () => ({ status: 429 }), 'PROVIDER_UNAVAILABLE'],
      ['503', () => ({ status: 503 }), 'PROVIDER_UNAVAILABLE'],
      ['network', () => new Error('ECONNREFUSED 10.0.0.1'), 'PROVIDER_UNAVAILABLE'],
      ['garbage', () => ({ status: 200, body: undefined }), 'PROVIDER_UNAVAILABLE'],
    ];
    for (const [, h, code] of cases) {
      const f = fakeFetch(h);
      const err = await make(f).createRecurringCheckout({ customerRef: 'c', planCode: 'STARTER', interval: 'MONTHLY', amountMinor: 1900, currency: 'USD', reference: 'r', returnUrl: 'https://a.test' }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderUnavailableError);
      expect((err as ProviderUnavailableError).code).toBe(code);
      expect(String((err as Error).message)).not.toMatch(/secret detail|10\.0\.0\.1|pdl_sdbx/);
      expect(f.calls).toHaveLength(1); // one attempt: a creation is never retried blindly
    }
  });

  it('subscription creation with a saved card, standalone card capture and resuming a cancellation are not offered', async () => {
    const p = make(fakeFetch(() => ({ status: 200 })));
    await expect(p.createCardSetup()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(p.createSubscription()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(p.resumeSubscription()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('cancels at the end of the billing period', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { data: {} } }));
    await make(f).cancelSubscription({ subscriptionRef: 'sub_01x', atPeriodEnd: true });
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: 'https://sandbox-api.paddle.com/subscriptions/sub_01x/cancel', body: { effective_from: 'next_billing_period' } });
  });

  describe('webhooks', () => {
    const p = make(fakeFetch(() => ({ status: 200 })));
    const completed = { event_id: 'evt_01', event_type: 'transaction.completed', occurred_at: '2026-12-05T10:00:00Z', data: { id: 'txn_01', customer_id: 'ctm_01', subscription_id: 'sub_01', currency_code: 'USD', custom_data: { touma_reference: 'ref-9' }, details: { totals: { subtotal: '1900', total: '1900' } }, billing_period: { starts_at: '2026-12-05T10:00:00Z', ends_at: '2027-01-05T10:00:00Z' } } };

    it('accepts a correctly signed notification and normalizes it (amounts as integer minor units)', () => {
      const e = p.verifyWebhook(sign(completed));
      expect(e).toMatchObject({ id: 'evt_01', type: 'payment.succeeded', paymentRef: 'txn_01', reference: 'ref-9', customerRef: 'ctm_01', subscriptionRef: 'sub_01', amount: '19.00', currency: 'USD' });
      expect(e.periodEnd?.toISOString()).toBe('2027-01-05T10:00:00.000Z');
    });
    it('maps failures, subscription lifecycle and saved payment methods; ignores types it does not act on', () => {
      expect(p.verifyWebhook(sign({ event_id: 'e2', event_type: 'transaction.payment_failed', occurred_at: '2026-12-05T10:00:00Z', data: { id: 'txn_2', customer_id: 'c', payments: [{ error_code: 'declined' }] } }))).toMatchObject({ type: 'payment.failed', failureCode: 'declined' });
      expect(p.verifyWebhook(sign({ event_id: 'e3', event_type: 'subscription.created', data: { id: 'sub_9', customer_id: 'c' } }))).toMatchObject({ type: 'subscription.activated', subscriptionRef: 'sub_9' });
      expect(p.verifyWebhook(sign({ event_id: 'e4', event_type: 'subscription.canceled', data: { id: 'sub_9', customer_id: 'c' } }))).toMatchObject({ type: 'subscription.canceled', subscriptionRef: 'sub_9' });
      expect(p.verifyWebhook(sign({ event_id: 'e5', event_type: 'payment_method.saved', data: { id: 'paymtd_1', customer_id: 'c' } }))).toMatchObject({ type: 'payment_method.attached', paymentMethodRef: 'paymtd_1' });
      expect(() => p.verifyWebhook(sign({ event_id: 'e6', event_type: 'product.updated', data: { id: 'pro_1' } }))).toThrow(IgnoredEventError);
    });
    it('rejects missing, wrong-secret, tampered, malformed and stale signatures', () => {
      const good = sign(completed);
      expect(() => p.verifyWebhook({ rawBody: good.rawBody, headers: {} })).toThrow(WebhookSignatureError);
      expect(() => p.verifyWebhook(sign(completed, undefined, 'another-secret-0123456789'))).toThrow(WebhookSignatureError);
      expect(() => p.verifyWebhook({ rawBody: Buffer.from(good.rawBody.toString().replace('1900', '1')), headers: good.headers })).toThrow(WebhookSignatureError);
      expect(() => p.verifyWebhook({ rawBody: good.rawBody, headers: { 'paddle-signature': 'ts=abc;h1=zz' } })).toThrow(WebhookSignatureError);
      expect(() => p.verifyWebhook(sign(completed, Math.floor(Date.now() / 1000) - 3600))).toThrow(WebhookSignatureError); // replayed an hour later
      expect(() => make(fakeFetch(() => ({ status: 200 })), { webhookSecret: undefined }).verifyWebhook(good)).toThrow(WebhookSignatureError);
      const notJson = Buffer.from('not json');
      const ts = Math.floor(Date.now() / 1000);
      expect(() => p.verifyWebhook({ rawBody: notJson, headers: { 'paddle-signature': `ts=${ts};h1=${paddleSignature(SECRET, notJson, ts)}` } })).toThrow(WebhookSignatureError);
    });
    it('accepts either signature during a secret rotation (several h1 values)', () => {
      const raw = Buffer.from(JSON.stringify(completed));
      const ts = Math.floor(Date.now() / 1000);
      const headers = { 'paddle-signature': `ts=${ts};h1=${paddleSignature('old-secret-0123456789ab', raw, ts)};h1=${paddleSignature(SECRET, raw, ts)}` };
      expect(p.verifyWebhook({ rawBody: raw, headers }).id).toBe('evt_01');
    });
  });
});
