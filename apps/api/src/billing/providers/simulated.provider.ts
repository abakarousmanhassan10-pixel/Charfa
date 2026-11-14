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
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id = 'simulated' as const;
  constructor(private readonly webhookSecret: string | undefined) {}

  capabilities(): ProviderCapabilities {
    return { id: 'simulated', recurringSubscriptions: 'supported', hostedCardCapture: 'supported', verifiedWebhooks: 'supported', verifiedAgainstOfficialDocs: false, live: false };
  }
  async createCustomer() { return { customerRef: `sim_cus_${randomUUID()}` }; }
  async createCardSetup() { const id = randomUUID(); return { setupRef: `sim_setup_${id}`, hostedUrl: `https://simulated.invalid/card-setup/${id}` }; }
  async createSubscription() { return { subscriptionRef: `sim_sub_${randomUUID()}` }; }
  async cancelSubscription() { /* nothing to cancel anywhere */ }
  async resumeSubscription() { /* nothing to resume anywhere */ }

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
      id: j.id as string, type: j.type as NormalizedBillingEvent['type'], customerRef: str('customerRef'), subscriptionRef: str('subscriptionRef'), paymentMethodRef: str('paymentMethodRef'),
      paymentRef: str('paymentRef'), amount: str('amount'), currency: str('currency'), periodStart: date('periodStart'), periodEnd: date('periodEnd'), occurredAt: date('occurredAt') ?? new Date(),
    };
  }
}
