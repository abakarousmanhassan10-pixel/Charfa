import { UnverifiedPaymentProvider } from './unverified.provider';

/**
 * Payoneer. Nothing about its checkout, recurring payments or webhooks could be verified from official sources, and the founder's current
 * account is personal: this class stays inert (see docs/BILLING.md for the questions to ask Payoneer).
 */
export class PayoneerPaymentProvider extends UnverifiedPaymentProvider {
  constructor() { super('payoneer', 'Payoneer'); }
}
