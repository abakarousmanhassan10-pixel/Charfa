import { Global, Module } from '@nestjs/common';
import { FakeTextProvider, OpenAIProvider, type TextModelProvider } from '@touma/ai-engine';
import { APP_ENV, AppEnv } from '../config';

export const TEXT_PROVIDER = Symbol('TEXT_PROVIDER');

/** Provider selection from configuration. Credentials come from the environment only. */
export function createTextProvider(env: AppEnv): TextModelProvider {
  // The env loader guarantees "fake" is only selectable with APP_ENV=test.
  if (env.AI_PROVIDER === 'fake') return new FakeTextProvider();
  return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION });
}

@Global()
@Module({ providers: [{ provide: TEXT_PROVIDER, inject: [APP_ENV], useFactory: createTextProvider }], exports: [TEXT_PROVIDER] })
export class AiProviderModule {}
