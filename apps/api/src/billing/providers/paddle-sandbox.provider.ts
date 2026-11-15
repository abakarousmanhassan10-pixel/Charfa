import { createHmac, timingSafeEqual } from 'crypto';
import { minorToMajorString } from '@touma/shared';
import { IgnoredEventError, ProviderUnavailableError, WebhookSignatureError, type NormalizedBillingEvent, type PaymentProvider, type ProviderCapabilities } from '../payment-provider';

/**
 * Paddle SANDBOX adapter (Paddle Billing). IMPORTANT — read before relying on it:
 *  - Paddle's documentation could not be reached while this was written. Every endpoint, field and event name below comes from general knowledge of Paddle Billing
 *    and is UNVERIFIED. The adapter was exercised only against a local fake of that assumed API. Its capabilities are therefore reported as "sandbox", never "supported".
 *  - It works only with test credentials supplied by the administrator (server environment). A key that is not a sandbox key (pdl_sdbx_...) is refused outright,
 *    and the base URL is the sandbox API. It has no live mode: `live` is always false.
 *  - Paddle's policies restrict some products (the policy on automated social-media marketing is a known risk for TOUMA). Paddle is NOT approved for TOUMA until it
 *    accepts TOUMA's real activities in writing; production stays blocked by the production gate until then.
 *  - Card data never reaches TOUMA: payments and subscriptions are hosted checkouts. Secrets stay in this server process and are never logged or returned.
 *
 * Model differences (see docs/BILLING.md): AUTO = the customer completes a hosted checkout of a RECURRING price; the subscription exists only after Paddle notifies us.
 * MANUAL = a one-time checkout of a ONE-TIME price (collection mode "automatic": the customer pays by card now). It is NOT Paddle's "manual collection" invoices
 * (payment terms, invoice sent to the customer, bank transfer), which are a different product.
 */
export const PADDLE_SANDBOX_BASE_URL = 'https://sandbox-api.paddle.com';
const SIGNATURE_HEADER = 'paddle-signature';
const TOLERANCE_SECONDS = 300;

export interface PaddleSandboxConfig {
  apiKey?: string;
  webhookSecret?: string;
  /** "PLAN:INTERVAL" (recurring price) and "PLAN:INTERVAL:ONCE" (one-time price) -> Paddle sandbox price ids. */
  priceMap: Record<string, string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The documented signing scheme (as understood): HMAC-SHA256 of "<ts>:<raw body>" with the notification destination's secret. */
export function paddleSignature(secret: string, rawBody: Buffer | string, ts: number): string {
  return createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest('hex');
}

export class PaddleSandboxProvider implements PaymentProvider {
  readonly id = 'paddle-sandbox' as const;
  constructor(private readonly cfg: PaddleSandboxConfig) {}

  private get configured() { return Boolean(this.cfg.apiKey && this.cfg.apiKey.startsWith('pdl_sdbx_')); }

  capabilities(): ProviderCapabilities {
    const state = this.configured && this.cfg.webhookSecret ? 'sandbox' : 'unverified';
    return {
      id: this.id, recurringSubscriptions: state, hostedCardCapture: 'unsupported', hostedPaymentSession: state, verifiedWebhooks: this.cfg.webhookSecret ? 'sandbox' : 'unverified',
      subscriptionModel: 'checkout', sandboxOnly: true, credentialsConfigured: this.configured && Boolean(this.cfg.webhookSecret), methods: [], verifiedAgainstOfficialDocs: false, live: false,
    };
  }

  // ─── HTTP (sandbox only) ──────────────────────────────────────────────────

  private async call<T>(method: 'POST', path: string, body: unknown): Promise<T> {
    if (!this.configured) throw new ProviderUnavailableError('PROVIDER_NOT_CONFIGURED', 'Paddle sandbox credentials are not configured on this server');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.baseUrl ?? PADDLE_SANDBOX_BASE_URL}${path}`, {
        method, signal: ctl.signal, headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      // Network failure or timeout. A POST that creates something is never retried blindly: the caller decides.
      throw new ProviderUnavailableError('PROVIDER_UNAVAILABLE', 'The payment provider could not be reached');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderUnavailableError('CREDENTIALS_REJECTED', 'The payment provider rejected the configured credentials');
    if (res.status === 429 || res.status >= 500) throw new ProviderUnavailableError('PROVIDER_UNAVAILABLE', 'The payment provider is temporarily unavailable');
    const text = await res.text();
    let json: { data?: unknown; error?: { code?: string; detail?: string } } = {};
    try { json = text ? JSON.parse(text) : {}; } catch { throw new ProviderUnavailableError('PROVIDER_UNAVAILABLE', 'The payment provider returned an unreadable answer'); }
    if (!res.ok) {
      const e = new ProviderUnavailableError('PROVIDER_UNAVAILABLE', `The payment provider refused the request (${json.error?.code ?? res.status})`);
      (e as ProviderUnavailableError & { providerDetail?: string; providerCode?: string }).providerDetail = json.error?.detail;
      (e as ProviderUnavailableError & { providerDetail?: string; providerCode?: string }).providerCode = json.error?.code;
      throw e;
    }
    return json as T;
  }

  private price(planCode: string, interval: string, once: boolean): string {
    const id = this.cfg.priceMap[`${planCode}:${interval}${once ? ':ONCE' : ''}`];
    if (!id) throw new ProviderUnavailableError('PROVIDER_NOT_CONFIGURED', `No Paddle sandbox ${once ? 'one-time' : 'recurring'} price is configured for ${planCode} ${interval}`);
    return id;
  }

  async createCustomer(input: { businessId: string; email: string }) {
    try {
      const r = await this.call<{ data: { id: string } }>('POST', '/customers', { email: input.email, custom_data: { touma_business_id: input.businessId } });
      if (!r.data?.id) throw new ProviderUnavailableError('PROVIDER_UNAVAILABLE', 'The payment provider returned an unreadable answer');
      return { customerRef: r.data.id };
    } catch (e) {
      // A customer with this e-mail already exists: Paddle's conflict answer names it (assumed shape; unverified).
      const existing = /ctm_[a-z0-9]+/.exec((e as { providerDetail?: string }).providerDetail ?? '')?.[0];
      if (existing && (e as { providerCode?: string }).providerCode === 'customer_already_exists') return { customerRef: existing };
      throw e;
    }
  }

  async createCardSetup(): Promise<never> {
    throw new ProviderUnavailableError('CAPABILITY_UNSUPPORTED', 'Paddle has no standalone card capture: use the hosted checkout');
  }

  /** MANUAL renewal / first payment: a one-time checkout. */
  async createPaymentSession(input: { customerRef: string; planCode: string; interval: 'MONTHLY' | 'YEARLY'; amountMinor: number; currency: string; reference: string; returnUrl: string }) {
    const r = await this.call<{ data: { id: string; checkout?: { url?: string } } }>('POST', '/transactions', {
      items: [{ price_id: this.price(input.planCode, input.interval, true), quantity: 1 }],
      customer_id: input.customerRef, collection_mode: 'automatic', currency_code: input.currency, custom_data: { touma_reference: input.reference }, checkout: { url: input.returnUrl },
    });
    if (!r.data?.checkout?.url) throw new ProviderUnavailableError('PROVIDER_UNAVAILABLE', 'The payment provider returned no checkout page');
    return { sessionRef: r.data.id, hostedUrl: r.data.checkout.url };
  }

  /** AUTO: a hosted checkout of the recurring price; the subscription is created by Paddle when the customer completes it. */
  async createRecurringCheckout(input: { customerRef: string; planCode: string; interval: 'MONTHLY' | 'YEARLY'; amountMinor: number; currency: string; reference: string; returnUrl: string }) {
    const r = await this.call<{ data: { id: string; checkout?: { url?: string } } }>('POST', '/transactions', {
      items: [{ price_id: this.price(input.planCode, input.interval, false), quantity: 1 }],
      customer_id: input.customerRef, collection_mode: 'automatic', custom_data: { touma_reference: input.reference }, checkout: { url: input.returnUrl },
    });
    if (!r.data?.checkout?.url) throw new ProviderUnavailableError('PROVIDER_UNAVAILABLE', 'The payment provider returned no checkout page');
    return { checkoutRef: r.data.id, hostedUrl: r.data.checkout.url };
  }

  async createSubscription(): Promise<never> {
    throw new ProviderUnavailableError('CAPABILITY_UNSUPPORTED', 'Paddle creates subscriptions through a hosted checkout, not through the API with a saved card');
  }

  async cancelSubscription(input: { subscriptionRef: string; atPeriodEnd: boolean }) {
    await this.call('POST', `/subscriptions/${encodeURIComponent(input.subscriptionRef)}/cancel`, { effective_from: input.atPeriodEnd ? 'next_billing_period' : 'immediately' });
  }

  async resumeSubscription(): Promise<never> {
    throw new ProviderUnavailableError('CAPABILITY_UNSUPPORTED', 'Withdrawing a scheduled cancellation at Paddle is not verified: not offered');
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  verifyWebhook({ rawBody, headers }: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): NormalizedBillingEvent {
    const secret = this.cfg.webhookSecret;
    const header = String(headers[SIGNATURE_HEADER] ?? '');
    const ts = /(?:^|;)ts=(\d+)/.exec(header)?.[1];
    const signatures = [...header.matchAll(/(?:^|;)h1=([0-9a-f]+)/g)].map((m) => m[1]!); // several during a secret rotation
    if (!secret || !ts || signatures.length === 0 || Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SECONDS) throw new WebhookSignatureError();
    const expected = paddleSignature(secret, rawBody, Number(ts));
    if (!signatures.some((s) => eq(s, expected))) throw new WebhookSignatureError();
    let j: PaddleNotification;
    try { j = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookSignatureError(); }
    if (typeof j.event_id !== 'string' || typeof j.event_type !== 'string' || typeof j.data !== 'object' || !j.data) throw new WebhookSignatureError();
    return this.normalize(j);
  }

  private normalize(j: PaddleNotification): NormalizedBillingEvent {
    const d = j.data as PaddleData;
    const occurredAt = j.occurred_at && !Number.isNaN(new Date(j.occurred_at).getTime()) ? new Date(j.occurred_at) : new Date();
    const base = { id: j.event_id, occurredAt, customerRef: d.customer_id, subscriptionRef: d.subscription_id ?? (j.event_type.startsWith('subscription.') ? d.id : undefined) };
    const money = () => {
      const t = d.details?.totals;
      const minor = t?.subtotal ?? t?.total; // before tax: the plan price (the field mapping must be confirmed in the sandbox)
      const currency = d.currency_code;
      return minor !== undefined && currency && /^\d{1,12}$/.test(String(minor)) ? { amount: minorToMajorString(Number(minor), currency), currency } : {};
    };
    const period = { periodStart: d.billing_period?.starts_at ? new Date(d.billing_period.starts_at) : undefined, periodEnd: d.billing_period?.ends_at ? new Date(d.billing_period.ends_at) : undefined };
    switch (j.event_type) {
      case 'transaction.completed':
        return { ...base, type: 'payment.succeeded', paymentRef: d.id, reference: d.custom_data?.touma_reference, ...money(), ...period };
      case 'transaction.payment_failed':
        return { ...base, type: 'payment.failed', paymentRef: d.id, reference: d.custom_data?.touma_reference, failureCode: d.payments?.[0]?.error_code ?? 'payment_failed', ...money() };
      case 'subscription.created':
      case 'subscription.activated':
        return { ...base, type: 'subscription.activated', ...period };
      case 'subscription.canceled':
        return { ...base, type: 'subscription.canceled' };
      case 'payment_method.saved':
        return { ...base, type: 'payment_method.attached', paymentMethodRef: d.id };
      default:
        throw new IgnoredEventError(j.event_id, j.event_type);
    }
  }
}

interface PaddleData {
  id?: string;
  customer_id?: string;
  subscription_id?: string;
  currency_code?: string;
  custom_data?: { touma_reference?: string };
  details?: { totals?: { subtotal?: string; total?: string } };
  billing_period?: { starts_at?: string; ends_at?: string };
  payments?: Array<{ error_code?: string }>;
}
interface PaddleNotification { event_id: string; event_type: string; occurred_at?: string; data: PaddleData }
