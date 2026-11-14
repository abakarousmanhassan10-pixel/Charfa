import { Global, Module } from '@nestjs/common';
import { FakeTextProvider, MockOpenAIProvider, OpenAIProvider, type TextModelProvider } from '@touma/ai-engine';
import { APP_ENV, AppEnv } from '../config';

export const TEXT_PROVIDER = Symbol('TEXT_PROVIDER');

/** Provider selection from configuration. Credentials come from the environment only. */
export function createTextProvider(env: AppEnv): TextModelProvider {
  // The env loader guarantees "fake" is only selectable with APP_ENV=test.
  if (env.AI_PROVIDER === 'fake') return new FakeTextProvider();
  // Also test-only: the real OpenAI SDK against a built-in mock of the OpenAI HTTP API (no network, no key, no cost).
  if (env.AI_PROVIDER === 'mock-openai') return new MockOpenAIProvider();
  // Real provider: only armed when the server switch OPENAI_ENABLED is true. Otherwise it gets no key, reports "not configured" and cannot send anything.
  return new OpenAIProvider({ apiKey: env.OPENAI_ENABLED ? env.OPENAI_API_KEY : undefined, baseUrl: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION });
}

/** What the merchant is talking to: a real provider, a simulated test provider, or nothing (switch off or no key). */
export function aiMode(env: AppEnv, configured: boolean): 'real' | 'simulated' | 'disabled' {
  if (env.AI_PROVIDER === 'fake' || env.AI_PROVIDER === 'mock-openai') return 'simulated';
  return configured ? 'real' : 'disabled';
}

@Global()
@Module({ providers: [{ provide: TEXT_PROVIDER, inject: [APP_ENV], useFactory: createTextProvider }], exports: [TEXT_PROVIDER] })
export class AiProviderModule {}
