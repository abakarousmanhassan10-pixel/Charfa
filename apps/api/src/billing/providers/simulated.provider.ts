import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { BILLING_EVENT_TYPES } from '@touma/shared';
import { WebhookSignatureError, type NormalizedBillingEvent, type PaymentProvider, type ProviderCapabilities } from '../payment-provider';

const SIGNATURE_HEADER = 'x-touma-sim-signature';
const MAX_SKEW_SECONDS = 300;

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Test-only provider. It moves no money, contacts no network and never sees a card: the "hosted page" is a fake URL and
 * a saved card is just an opaque reference. Webhooks are HMAC-SHA256 signed over "<timestamp>.<raw body>" like a real provider's,
 * so the verification path of the platform is exercised for real.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly id = 'simulated' as const;
  constructor(private readonly webhookSecret: string | undefined) {}

  capabilities(): ProviderCapabilities {
    return { id: 'simulated', recurringSubscriptions: 'supported', hostedCardCapture: 'supported', hostedPaymentSession: 'supported', subscriptionModel: 'saved-card', sandboxOnly: false, credentialsConfigured: true, verifiedWebhooks: 'supported', methods: ['simulated-visa', 'simulated-mastercard', 'simulated-wallet'], verifiedAgainstOfficialDocs: false, live: false };
  }
  /** Test aid: the next `times` provider calls fail with this error (provider outage, rejected credentials...). Never used outside tests. */
  private injected: { error: Error; remaining: number } | null = null;
  injectFailure(error: Error, times = 1) { this.injected = { error, remaining: times }; }
  clearFailure() { this.injected = null; }
  private maybeFail() {
    if (this.injected && this.injected.remaining > 0) { this.injected.remaining -= 1; throw this.injected.error; }
  }

  async createCustomer() { this.maybeFail(); return { customerRef: `sim_cus_${randomUUID()}` }; }
  async createCardSetup() { this.maybeFail(); const id = randomUUID(); return { setupRef: `sim_setup_${id}`, hostedUrl: `https://simulated.invalid/card-setup/${id}` }; }
  async createPaymentSession() { this.maybeFail(); const id = randomUUID(); return { sessionRef: `sim_sess_${id}`, hostedUrl: `https://simulated.invalid/pay/${id}` }; }
  async createRecurringCheckout() { this.maybeFail(); const id = randomUUID(); return { checkoutRef: `sim_chk_${id}`, hostedUrl: `https://simulated.invalid/checkout/${id}` }; }
  async createSubscription() { this.maybeFail(); return { subscriptionRef: `sim_sub_${randomUUID()}` }; }
  async cancelSubscription() { this.maybeFail(); /* nothing to cancel anywhere */ }
  async resumeSubscription() { this.maybeFail(); /* nothing to resume anywhere */ }

  /** Builds a signed delivery exactly as the simulated "provider" would send it (used by tests and the local simulator). */
  sign(event: Omit<NormalizedBillingEvent, 'occurredAt' | 'periodStart' | 'periodEnd'> & { occurredAt?: string; periodStart?: string; periodEnd?: string }, at = new Date()) {
    const rawBody = Buffer.from(JSON.stringify({ ...event, occurredAt: event.occurredAt ?? at.toISOString() }));
    const t = Math.floor(at.getTime() / 1000);
    const s = createHmac('sha256', this.webhookSecret ?? '').update(`${t}.`).update(rawBody).digest('hex');
    return { rawBody, headers: { [SIGNATURE_HEADER]: `t=${t},s=${s}` } };
  }

  verifyWebhook({ rawBody, headers }: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): NormalizedBillingEvent {
    const header = String(headers[SIGNATURE_HEADER] ?? '');
    const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
    const s = /(?:^|,)s=([0-9a-f]+)/.exec(header)?.[1];
    if (!this.webhookSecret || !t || !s || Math.abs(Date.now() / 1000 - Number(t)) > MAX_SKEW_SECONDS) throw new WebhookSignatureError();
    const expected = createHmac('sha256', this.webhookSecret).update(`${t}.`).update(rawBody).digest('hex');
    if (!eq(s, expected)) throw new WebhookSignatureError();
    let j: Record<string, unknown>;
    try { j = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookSignatureError(); }
    if (typeof j.id !== 'string' || !(BILLING_EVENT_TYPES as readonly string[]).includes(String(j.type))) throw new WebhookSignatureError();
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : undefined);
    const date = (k: string) => { const v = str(k); const d = v ? new Date(v) : undefined; return d && !Number.isNaN(d.getTime()) ? d : undefined; };
    return {
      id: j.id as string, reference: str('reference'), failureCode: str('failureCode'), type: j.type as NormalizedBillingEvent['type'], customerRef: str('customerRef'), subscriptionRef: str('subscriptionRef'), paymentMethodRef: str('paymentMethodRef'),
      paymentRef: str('paymentRef'), amount: str('amount'), currency: str('currency'), periodStart: date('periodStart'), periodEnd: date('periodEnd'), occurredAt: date('occurredAt') ?? new Date(),
    };
  }
}

/** Kept for existing imports. */
export { MockPaymentProvider as SimulatedPaymentProvider };
