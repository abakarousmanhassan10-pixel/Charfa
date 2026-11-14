import { ProviderUnavailableError, type NormalizedBillingEvent, type PaymentProvider, type ProviderCapabilities } from '../payment-provider';

const NOT_VERIFIED = 'Payoneer adapter is not enabled: its recurring-billing, hosted card capture and webhook signature capabilities have not been verified against Payoneer\'s official documentation and sandbox.';

/**
 * Placeholder for Payoneer. By design it contains NO HTTP call, NO endpoint and NO assumed API shape: everything it would do
 * depends on Payoneer features that could not be confirmed from official documentation (see docs/BILLING.md). Every operation refuses
 * with PROVIDER_NOT_VERIFIED, and the capabilities say "unverified", so the platform treats Payoneer as unavailable and the
 * operator is pointed to the alternative-provider path. When Payoneer confirms the capabilities in writing, this class is where the
 * verified implementation goes, behind the same PaymentProvider interface.
 */
export class PayoneerPaymentProvider implements PaymentProvider {
  readonly id = 'payoneer' as const;

  capabilities(): ProviderCapabilities {
    return { id: 'payoneer', recurringSubscriptions: 'unverified', hostedCardCapture: 'unverified', verifiedWebhooks: 'unverified', verifiedAgainstOfficialDocs: false, live: false };
  }
  private refuse(): never { throw new ProviderUnavailableError('PROVIDER_NOT_VERIFIED', NOT_VERIFIED); }
  async createCustomer(): Promise<never> { return this.refuse(); }
  async createCardSetup(): Promise<never> { return this.refuse(); }
  async createSubscription(): Promise<never> { return this.refuse(); }
  async cancelSubscription(): Promise<never> { return this.refuse(); }
  verifyWebhook(): NormalizedBillingEvent { return this.refuse(); }
}
