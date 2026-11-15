import { ProviderUnavailableError, WebhookSignatureError } from '../payment-provider';
import { FutureProviderAdapter } from './future.provider';
import { IyzicoPaymentProvider } from './iyzico.provider';
import { PayoneerPaymentProvider } from './payoneer.provider';
import { SimulatedPaymentProvider } from './simulated.provider';

describe('SimulatedPaymentProvider', () => {
  const p = new SimulatedPaymentProvider('unit-secret-0123456789');
  const ev = { id: 'e1', type: 'payment.succeeded' as const, subscriptionRef: 's1' };
  it('accepts its own signed delivery and normalizes it', () => {
    const s = p.sign(ev);
    expect(p.verifyWebhook(s)).toMatchObject({ id: 'e1', type: 'payment.succeeded', subscriptionRef: 's1' });
  });
  it('rejects missing, forged, tampered and unknown-type deliveries', () => {
    const s = p.sign(ev);
    expect(() => p.verifyWebhook({ rawBody: s.rawBody, headers: {} })).toThrow(WebhookSignatureError);
    expect(() => p.verifyWebhook({ rawBody: Buffer.from(s.rawBody.toString().replace('s1', 's2')), headers: s.headers })).toThrow(WebhookSignatureError);
    expect(() => new SimulatedPaymentProvider('other-secret-0123456789').verifyWebhook(s)).toThrow(WebhookSignatureError);
    expect(() => new SimulatedPaymentProvider(undefined).verifyWebhook(s)).toThrow(WebhookSignatureError);
    const odd = p.sign({ ...ev, type: 'refund.everything' as never });
    expect(() => p.verifyWebhook(odd)).toThrow(WebhookSignatureError);
  });
  it('is never live and never claims to be verified', () => {
    expect(p.capabilities()).toMatchObject({ live: false, verifiedAgainstOfficialDocs: false });
  });
});

describe('PayoneerPaymentProvider', () => {
  const p = new PayoneerPaymentProvider();
  it('declares every capability unverified', () => {
    expect(p.capabilities()).toEqual({ id: 'payoneer', recurringSubscriptions: 'unverified', hostedCardCapture: 'unverified', hostedPaymentSession: 'unverified', subscriptionModel: 'saved-card', sandboxOnly: false, credentialsConfigured: false, verifiedWebhooks: 'unverified', methods: [], verifiedAgainstOfficialDocs: false, live: false });
  });
  it('refuses every operation without doing anything', async () => {
    await expect(p.createCustomer()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.createCardSetup()).rejects.toMatchObject({ code: 'PROVIDER_NOT_VERIFIED' });
    await expect(p.createSubscription()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.cancelSubscription()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.resumeSubscription()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(() => p.verifyWebhook()).toThrow(ProviderUnavailableError);
  });
});

describe.each([
  ['iyzico', () => new IyzicoPaymentProvider()],
  ['future', () => new FutureProviderAdapter()],
])('%s adapter (preparatory)', (id, make) => {
  const p = make();
  it('has no verified capability, no payment method, and is never live', () => {
    expect(p.id).toBe(id);
    expect(p.capabilities()).toMatchObject({ recurringSubscriptions: 'unverified', hostedCardCapture: 'unverified', hostedPaymentSession: 'unverified', verifiedWebhooks: 'unverified', methods: [], verifiedAgainstOfficialDocs: false, live: false });
  });
  it('refuses every operation, including payment sessions and webhooks', async () => {
    await expect(p.createCustomer()).rejects.toMatchObject({ code: 'PROVIDER_NOT_VERIFIED' });
    await expect(p.createCardSetup()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.createPaymentSession()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.createSubscription()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.cancelSubscription()).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.resumeSubscription()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(() => p.verifyWebhook()).toThrow(ProviderUnavailableError);
  });
});

describe('LemonSqueezyProvider (preparation only)', () => {
  const { LemonSqueezyProvider } = jest.requireActual('./lemonsqueezy.provider') as typeof import('./lemonsqueezy.provider');
  const p = new LemonSqueezyProvider();
  it('is inert: nothing verified, nothing assumed, every call refused', async () => {
    expect(p.id).toBe('lemonsqueezy');
    expect(p.capabilities()).toMatchObject({ recurringSubscriptions: 'unverified', methods: [], verifiedAgainstOfficialDocs: false, live: false });
    await expect(p.createPaymentSession()).rejects.toMatchObject({ code: 'PROVIDER_NOT_VERIFIED' });
    await expect(p.createRecurringCheckout()).rejects.toMatchObject({ code: 'PROVIDER_NOT_VERIFIED' });
    expect(() => p.verifyWebhook()).toThrow(ProviderUnavailableError);
  });
});
