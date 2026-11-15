import { Global, Module } from '@nestjs/common';
import { APP_ENV, AppEnv } from '../config';
import type { PaymentProvider } from './payment-provider';
import { IyzicoPaymentProvider } from './providers/iyzico.provider';
import { LemonSqueezyProvider } from './providers/lemonsqueezy.provider';
import { PaddleSandboxProvider } from './providers/paddle-sandbox.provider';
import { PayoneerPaymentProvider } from './providers/payoneer.provider';
import { MockPaymentProvider } from './providers/simulated.provider';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Provider selection from server configuration. null = no provider: every billing action that needs one answers "not configured". */
export function createPaymentProvider(env: AppEnv): PaymentProvider | null {
  if (env.BILLING_PROVIDER === 'simulated') return new MockPaymentProvider(env.BILLING_WEBHOOK_SECRET); // the env loader allows it only with APP_ENV=test
  if (env.BILLING_PROVIDER === 'payoneer') return new PayoneerPaymentProvider();
  if (env.BILLING_PROVIDER === 'iyzico') return new IyzicoPaymentProvider();
  if (env.BILLING_PROVIDER === 'lemonsqueezy') return new LemonSqueezyProvider();
  // Sandbox only, with the administrator's test credentials (the env loader refuses live keys and a live environment).
  if (env.BILLING_PROVIDER === 'paddle-sandbox') return new PaddleSandboxProvider({ apiKey: env.PADDLE_API_KEY, webhookSecret: env.PADDLE_WEBHOOK_SECRET, priceMap: env.PADDLE_PRICE_MAP, baseUrl: env.PADDLE_API_BASE_URL });
  return null;
}

@Global()
@Module({ providers: [{ provide: PAYMENT_PROVIDER, inject: [APP_ENV], useFactory: createPaymentProvider }], exports: [PAYMENT_PROVIDER] })
export class BillingProviderModule {}
