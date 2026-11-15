import { UnverifiedPaymentProvider } from './unverified.provider';

/**
 * Lemon Squeezy: alternative merchant of record, PREPARATION ONLY. Its API, checkout model, webhooks and acceptance of TOUMA's activities were not
 * verified, so nothing is assumed: no endpoint, field or signature scheme. Implement verified calls in a subclass behind PaymentProvider once its
 * official documentation has been checked and it has accepted TOUMA's real activities in writing.
 */
export class LemonSqueezyProvider extends UnverifiedPaymentProvider {
  constructor() { super('lemonsqueezy', 'Lemon Squeezy'); }
}
