import { UnverifiedPaymentProvider } from './unverified.provider';

/**
 * Template for any provider added later (e.g. a merchant of record or another processor): copy this class, give it a ProviderId and a
 * WebhookProvider value, implement the verified operations, and register it in billing-provider.ts. Never selectable by configuration as is.
 */
export class FutureProviderAdapter extends UnverifiedPaymentProvider {
  constructor() { super('future', 'Future provider'); }
}
