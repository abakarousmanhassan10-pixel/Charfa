import { ProviderUnavailableError, type NormalizedBillingEvent, type PaymentProvider, type ProviderCapabilities, type ProviderId } from '../payment-provider';

/**
 * Base for providers whose capabilities have NOT been verified against the provider's official documentation and sandbox.
 * It contains no HTTP call, no endpoint and no assumed API shape: every operation refuses with PROVIDER_NOT_VERIFIED and every capability
 * reads "unverified", so the platform treats the provider as unavailable. A verified adapter replaces the refusing methods in a subclass,
 * keeping the same PaymentProvider interface, and flips `verifiedAgainstOfficialDocs` only after sandbox tests.
 */
export abstract class UnverifiedPaymentProvider implements PaymentProvider {
  protected constructor(readonly id: ProviderId, private readonly label: string) {}

  capabilities(): ProviderCapabilities {
    return { id: this.id, recurringSubscriptions: 'unverified', hostedCardCapture: 'unverified', hostedPaymentSession: 'unverified', verifiedWebhooks: 'unverified', methods: [], verifiedAgainstOfficialDocs: false, live: false };
  }
  protected refuse(): never {
    throw new ProviderUnavailableError('PROVIDER_NOT_VERIFIED', `${this.label} adapter is not enabled: its recurring billing, hosted card capture, payment session and webhook signature capabilities have not been verified against its official documentation and sandbox.`);
  }
  async createCustomer(): Promise<never> { return this.refuse(); }
  async createCardSetup(): Promise<never> { return this.refuse(); }
  async createPaymentSession(): Promise<never> { return this.refuse(); }
  async createSubscription(): Promise<never> { return this.refuse(); }
  async cancelSubscription(): Promise<never> { return this.refuse(); }
  async resumeSubscription(): Promise<never> { return this.refuse(); }
  verifyWebhook(): NormalizedBillingEvent { return this.refuse(); }
}
