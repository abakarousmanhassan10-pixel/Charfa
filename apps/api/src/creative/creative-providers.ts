import { Global, Module } from '@nestjs/common';
import { FakeImageProvider, FakeVideoProvider, OpenAIImageProvider, OpenAIVideoProvider, type ImageProvider, type VideoProvider } from '@touma/creative';
import { APP_ENV, AppEnv } from '../config';

export const IMAGE_PROVIDER = Symbol('IMAGE_PROVIDER');
export const VIDEO_PROVIDER = Symbol('VIDEO_PROVIDER');

/** Provider selection from configuration. Credentials come from the environment only. */
export function createImageProvider(env: AppEnv): ImageProvider | null {
  if (env.IMAGE_PROVIDER === 'none') return null;
  // The env loader guarantees "fake" is only selectable with APP_ENV=test.
  if (env.IMAGE_PROVIDER === 'fake') return new FakeImageProvider();
  return new OpenAIImageProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION });
}

export function createVideoProvider(env: AppEnv): VideoProvider | null {
  if (env.VIDEO_PROVIDER === 'none') return null;
  if (env.VIDEO_PROVIDER === 'fake') return new FakeVideoProvider();
  return new OpenAIVideoProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, organization: env.OPENAI_ORGANIZATION });
}

@Global()
@Module({
  providers: [
    { provide: IMAGE_PROVIDER, inject: [APP_ENV], useFactory: createImageProvider },
    { provide: VIDEO_PROVIDER, inject: [APP_ENV], useFactory: createVideoProvider },
  ],
  exports: [IMAGE_PROVIDER, VIDEO_PROVIDER],
})
export class CreativeProviderModule {}
