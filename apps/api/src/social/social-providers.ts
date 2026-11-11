import { Global, Module } from '@nestjs/common';
import { createAdapters, createFakeAdapters, FakeSocialHub, type AdapterConfig, type FetchLike, type Platform, type PlatformAdapter } from '@touma/social-connectors';
import { APP_ENV, AppEnv } from '../config';

export const SOCIAL_ADAPTERS = Symbol('SOCIAL_ADAPTERS');
export const SOCIAL_FAKE_HUB = Symbol('SOCIAL_FAKE_HUB');
export type SocialAdapters = Record<Platform, PlatformAdapter>;

export function adapterConfig(env: AppEnv): AdapterConfig {
  return {
    metaAppId: env.META_APP_ID, metaAppSecret: env.META_APP_SECRET, metaGraphVersion: env.META_GRAPH_VERSION,
    tiktokClientKey: env.TIKTOK_CLIENT_KEY, tiktokClientSecret: env.TIKTOK_CLIENT_SECRET,
    googleClientId: env.GOOGLE_CLIENT_ID, googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    linkedinClientId: env.LINKEDIN_CLIENT_ID, linkedinClientSecret: env.LINKEDIN_CLIENT_SECRET, linkedinApiVersion: env.LINKEDIN_API_VERSION, linkedinOrgScopes: env.LINKEDIN_ORG_SCOPES,
  };
}

/**
 * Platform adapters. Live mode talks to the official platform APIs with the credentials from the environment.
 * The simulator (fake mode) exists for automated tests only; the env loader refuses it unless APP_ENV=test.
 */
@Global()
@Module({
  providers: [
    { provide: SOCIAL_FAKE_HUB, inject: [APP_ENV], useFactory: (env: AppEnv) => (env.SOCIAL_PROVIDER_MODE === 'fake' ? new FakeSocialHub() : null) },
    {
      provide: SOCIAL_ADAPTERS,
      inject: [APP_ENV, SOCIAL_FAKE_HUB],
      useFactory: (env: AppEnv, hub: FakeSocialHub | null): SocialAdapters => (hub ? createFakeAdapters(hub) : createAdapters(adapterConfig(env), globalThis.fetch as unknown as FetchLike)),
    },
  ],
  exports: [SOCIAL_ADAPTERS, SOCIAL_FAKE_HUB],
})
export class SocialProviderModule {}
