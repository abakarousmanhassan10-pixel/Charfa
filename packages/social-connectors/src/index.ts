/**
 * Social connector contract (Phase 6 implements Instagram, Facebook, TikTok, YouTube adapters).
 *
 * Rules every adapter must follow:
 *  - Official APIs only; no scraping, no unofficial endpoints.
 *  - Capabilities are declared per platform/account. Unsupported operations throw
 *    CapabilityNotSupportedError so the app can fall back to the MANUAL publishing workflow.
 *  - publishContent() returns a result derived from the provider response only.
 *    It must never report success without a provider-issued post id.
 *  - Tokens are passed in decrypted only for the duration of the call and never logged.
 */
export type Platform = 'INSTAGRAM' | 'FACEBOOK' | 'TIKTOK' | 'YOUTUBE';

export interface ConnectorCapabilities {
  publishText: boolean;
  publishImage: boolean;
  publishVideo: boolean;
  publishCarousel: boolean;
  readComments: boolean;
  replyToComments: boolean;
  readMessages: boolean;
  readInsights: boolean;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface PublishRequest {
  idempotencyKey: string;
  caption?: string;
  mediaUrls: string[];
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';
}

export type PublishResult =
  | { status: 'PUBLISHED'; externalPostId: string; externalUrl?: string; raw: unknown }
  | { status: 'PROCESSING'; providerContainerId: string; raw: unknown };

export interface SocialConnector {
  readonly platform: Platform;
  readonly capabilities: ConnectorCapabilities;
  buildAuthorizationUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens>;
  refreshToken(tokens: OAuthTokens): Promise<OAuthTokens>;
  getAccountInfo(tokens: OAuthTokens): Promise<{ externalAccountId: string; displayName?: string; username?: string }>;
  publishContent(tokens: OAuthTokens, accountId: string, req: PublishRequest): Promise<PublishResult>;
  getPublicationStatus(tokens: OAuthTokens, accountId: string, ref: string): Promise<PublishResult | { status: 'FAILED'; error: string }>;
  getComments(tokens: OAuthTokens, externalPostId: string, cursor?: string): Promise<{ items: unknown[]; nextCursor?: string }>;
  replyToComment(tokens: OAuthTokens, externalCommentId: string, message: string): Promise<{ externalCommentId: string }>;
  disconnect(tokens: OAuthTokens): Promise<void>;
}

export class CapabilityNotSupportedError extends Error {
  constructor(platform: Platform, capability: keyof ConnectorCapabilities) {
    super(`${platform} does not support ${capability} via its official API; use manual publishing.`);
    this.name = 'CapabilityNotSupportedError';
  }
}

export class ConnectorNotConfiguredError extends Error {
  constructor(platform: Platform, missing: string[]) {
    super(`${platform} connector is not configured. Missing: ${missing.join(', ')}`);
    this.name = 'ConnectorNotConfiguredError';
  }
}
