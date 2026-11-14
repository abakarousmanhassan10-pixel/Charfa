import type { BillingEventType } from '@touma/shared';

/** What a provider can really do. "unverified" = not confirmed against the provider's official documentation: it must be treated as unavailable. */
export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export interface ProviderCapabilities {
  id: ProviderId;
  /** Automatic monthly charges without the customer acting each month. */
  recurringSubscriptions: CapabilityStatus;
  /** Card capture on a page hosted by the provider, so TOUMA never sees card data. */
  hostedCardCapture: CapabilityStatus;
  /** Signed webhook notifications TOUMA can verify. */
  verifiedWebhooks: CapabilityStatus;
  /** True only when the adapter was checked against the provider's official documentation and a sandbox. */
  verifiedAgainstOfficialDocs: boolean;
  /** True only for a provider that moves real money. No adapter in this repository is live. */
  live: boolean;
}

export type ProviderId = 'simulated' | 'payoneer';

export interface NormalizedBillingEvent {
  /** Provider event id: the idempotency key. */
  id: string;
  type: BillingEventType;
  customerRef?: string;
  subscriptionRef?: string;
  paymentMethodRef?: string;
  paymentRef?: string;
  amount?: string;
  currency?: string;
  periodStart?: Date;
  periodEnd?: Date;
  occurredAt: Date;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  createCustomer(input: { businessId: string; email: string }): Promise<{ customerRef: string }>;
  /** Starts a card capture on a provider-hosted page. The result holds a URL only: card data never reaches TOUMA. */
  createCardSetup(input: { customerRef: string; returnUrl: string }): Promise<{ setupRef: string; hostedUrl: string }>;
  createSubscription(input: { customerRef: string; paymentMethodRef: string; amount: string; currency: string; interval: 'MONTH'; firstChargeAt: Date | null }): Promise<{ subscriptionRef: string }>;
  cancelSubscription(input: { subscriptionRef: string; atPeriodEnd: boolean }): Promise<void>;
  /** Undoes a cancellation scheduled for the end of the period. */
  resumeSubscription(input: { subscriptionRef: string }): Promise<void>;
  /** Verifies the signature on the RAW body and returns a normalized event. Throws WebhookSignatureError when it cannot prove the sender. */
  verifyWebhook(input: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): NormalizedBillingEvent;
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

/** Raised when an operation is not available (provider not verified, not configured, or the capability is unsupported). Nothing was sent. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly code: 'PROVIDER_NOT_VERIFIED' | 'PROVIDER_NOT_CONFIGURED' | 'CAPABILITY_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
