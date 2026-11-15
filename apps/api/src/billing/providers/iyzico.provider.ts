import { UnverifiedPaymentProvider } from './unverified.provider';

/**
 * iyzico (Turkish payment institution). Preparatory structure only: its payment, subscription and webhook APIs and the eligibility of the
 * founder's future company were not verified from official documentation, so no endpoint, field or signature scheme is assumed here.
 * Implement the verified calls in this subclass, behind the same interface, once iyzico confirms them in writing and sandbox tests pass.
 */
export class IyzicoPaymentProvider extends UnverifiedPaymentProvider {
  constructor() { super('iyzico', 'iyzico'); }
}
