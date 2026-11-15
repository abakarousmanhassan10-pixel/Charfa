import { Global, Module } from '@nestjs/common';
import { FakeImageProvider, FakeVideoProvider, MockImageProvider, MockScriptProvider, MockVideoProvider, type ScriptProvider, OpenAIImageProvider, OpenAIVideoProvider, type ImageProvider, type VideoProvider } from '@touma/creative';
import { APP_ENV, AppEnv } from '../config';

export const IMAGE_PROVIDER = Symbol('IMAGE_PROVIDER');
export const VIDEO_PROVIDER = Symbol('VIDEO_PROVIDER');
export const SCRIPT_PROVIDER = Symbol('SCRIPT_PROVIDER');

/** Provider selection from configuration. Credentials come from the environment only. */
export function createImageProvider(env: AppEnv): ImageProvider | null {
  if (env.IMAGE_PROVIDER === 'none') return null;
  // The env loader guarantees "fake" is only selectable with APP_ENV=test.
  if (env.IMAGE_PROVIDER === 'fake') return new FakeImageProvider();
  // The env loader refuses "mock" in production: it is a labelled simulator.
  if (env.IMAGE_PROVIDER === 'mock') return new MockImageProvider();
  return new OpenAIImageProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION });
}

export function createVideoProvider(env: AppEnv): VideoProvider | null {
  if (env.VIDEO_PROVIDER === 'none') return null;
  if (env.VIDEO_PROVIDER === 'fake') return new FakeVideoProvider();
  if (env.VIDEO_PROVIDER === 'mock') return new MockVideoProvider();
  return new OpenAIVideoProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION });
}

/** Script preparation exists only in the free test mode (a template, no model). Live mode has no script provider yet. */
export function createScriptProvider(env: AppEnv): ScriptProvider | null {
  return env.CREATIVE_STUDIO_MODE === 'mock' ? new MockScriptProvider() : null;
}

@Global()
@Module({
  providers: [
    { provide: IMAGE_PROVIDER, inject: [APP_ENV], useFactory: createImageProvider },
    { provide: VIDEO_PROVIDER, inject: [APP_ENV], useFactory: createVideoProvider },
    { provide: SCRIPT_PROVIDER, inject: [APP_ENV], useFactory: createScriptProvider },
  ],
  exports: [IMAGE_PROVIDER, VIDEO_PROVIDER, SCRIPT_PROVIDER],
})
export class CreativeProviderModule {}
