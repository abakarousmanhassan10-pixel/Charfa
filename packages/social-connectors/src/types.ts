import type { ContentKind, SocialPlatformId, VideoSurface } from '@touma/shared';

/**
 * Provider-independent contracts of the TOUMA social publishing architecture.
 *
 * Rules every adapter follows:
 *  - Official platform APIs only. No scraping, no browser automation, no passwords.
 *  - Success is derived from the platform's response only: an adapter never returns PUBLISHED without a platform-issued id.
 *  - Tokens are passed in decrypted for the duration of one call and never logged or placed in error messages.
 *  - A format the API cannot publish is reported by validate() so the engine can fall back to manual publishing.
 */
export type Platform = SocialPlatformId;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** When the access token stops working. null/undefined = the platform issues tokens that do not expire. */
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
  scopes: string[];
}

export interface CandidateAccount {
  externalAccountId: string;
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  /** PAGE, INSTAGRAM_BUSINESS, CHANNEL, PROFILE, ORGANIZATION, CREATOR. */
  accountType: string;
  /** For example the Facebook Page an Instagram account belongs to. */
  parentExternalId?: string | null;
  /** The credentials to use for THIS account (for example a Page access token). */
  tokens: TokenSet;
  /** Permissions the platform reports as granted. */
  scopesGranted: string[];
  /** Permissions TOUMA needs that were not granted (the account can be connected but not fully used). */
  permissionsMissing: string[];
  /** Non-secret provider details shown to the person (never tokens). */
  metadata?: Record<string, unknown>;
}

export interface OAuthStart {
  url: string;
  /** PKCE verifier, when the platform supports PKCE. Stored encrypted until the callback. */
  codeVerifier?: string;
}

export interface MediaItem {
  id: string;
  /** A URL the platform can download from (a signed, public URL of the media file). */
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  altText?: string | null;
  /** Reads the file (for platforms that need the bytes). */
  read(): Promise<Buffer>;
}

export interface PublishableContent {
  kind: ContentKind;
  surface: VideoSurface;
  title?: string | null;
  caption: string;
  hashtags: string[];
  callToAction?: string | null;
  media: MediaItem[];
}

export interface AuthorizedAccount {
  externalAccountId: string;
  accountType: string;
  parentExternalId?: string | null;
  tokens: TokenSet;
}

export interface ValidationIssue {
  code: 'FORMAT_UNSUPPORTED' | 'CONTENT_INVALID' | 'MEDIA_INVALID';
  message: string;
  /** True when the platform's API cannot publish this at all and the content should go to manual publishing. */
  manual?: boolean;
}

export type PublishOutcome =
  | { status: 'PUBLISHED'; externalPostId: string; url?: string | null; raw?: unknown }
  /** Accepted, still being processed by the platform. Poll status() with `ref`. */
  | { status: 'PROCESSING'; ref: string; stage: string; retryAfterMs?: number; raw?: unknown };

export type StatusOutcome = PublishOutcome | { status: 'FAILED'; code: string; message: string; raw?: unknown };

export interface PublishContext {
  /** Same value for every attempt of one publication. Adapters that can pass it to the platform should. */
  idempotencyKey: string;
  /** Where a previous attempt stopped (stage and provider reference), to continue instead of starting again. */
  resume?: { stage: string; ref: string } | null;
  /** Call after each durable provider step (media container created, upload session opened) so a retry can resume. */
  checkpoint(stage: string, ref: string): Promise<void>;
  /**
   * Call immediately BEFORE the single request that creates the post. If the process dies after this point and no
   * platform id was recorded, the outcome is unknown and the engine will not blindly retry.
   */
  beforeCreate(): Promise<void>;
}

export interface Metrics {
  /** null = the platform did not provide this metric (unavailable). A number, including 0, is a real value. */
  views: number | null;
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  linkClicks: number | null;
  /** Why metrics are missing (permission, platform limitation), when known. */
  unavailableReason?: string | null;
  raw?: unknown;
}

export const EMPTY_METRICS: Metrics = { views: null, reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, linkClicks: null };

export interface TokenInspection {
  valid: boolean;
  expiresAt?: Date | null;
  scopes?: string[];
}

export interface PlatformAdapter {
  readonly platform: Platform;
  /** Names of the missing server configuration (environment variables); empty when ready. */
  missingConfiguration(): string[];
  isConfigured(): boolean;
  /** Permissions TOUMA asks for, with what each is used for. */
  readonly requiredScopes: readonly string[];
  /** Refresh this long before the token expires (only when it can be refreshed). */
  readonly refreshLeadMs: number;
  readonly supportsRefresh: boolean;

  buildAuthorizationUrl(p: { state: string; redirectUri: string; reconnect?: boolean }): OAuthStart;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string | null }): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  /** The accounts this authorization can publish to. */
  listAccounts(tokens: TokenSet): Promise<CandidateAccount[]>;
  inspectToken?(tokens: TokenSet): Promise<TokenInspection>;
  revoke?(tokens: TokenSet): Promise<void>;

  /** Format and media checks against the platform's rules, before anything is sent. */
  validate(content: PublishableContent): ValidationIssue[];
  publish(account: AuthorizedAccount, content: PublishableContent, ctx: PublishContext): Promise<PublishOutcome>;
  status(account: AuthorizedAccount, ref: string, stage: string): Promise<StatusOutcome>;
  fetchMetrics(account: AuthorizedAccount, externalPostId: string): Promise<Metrics>;
}

export type ErrorKind = 'auth' | 'permission' | 'rate_limit' | 'validation' | 'transient' | 'timeout' | 'unsupported' | 'not_configured';

/**
 * A normalized platform error. `outcome` says what the error proves about the post:
 *  - not_created: the platform answered with a refusal, so nothing was created and a retry is safe;
 *  - unknown: the request may have reached the platform (timeout, 5xx, dropped connection): it may have been created.
 */
export class SocialApiError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly opts: { status?: number; code?: string | number; outcome?: 'not_created' | 'unknown'; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'SocialApiError';
  }
  get status() {
    return this.opts.status;
  }
  get outcome() {
    return this.opts.outcome ?? (this.kind === 'validation' || this.kind === 'auth' || this.kind === 'permission' || this.kind === 'rate_limit' ? 'not_created' : 'unknown');
  }
  /** Worth another attempt (after a token refresh for auth errors). */
  get retryable() {
    return this.kind === 'transient' || this.kind === 'timeout' || this.kind === 'rate_limit' || this.kind === 'auth';
  }
}

export interface AdapterConfig {
  metaAppId?: string;
  metaAppSecret?: string;
  metaGraphVersion: string;
  tiktokClientKey?: string;
  tiktokClientSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  linkedinClientId?: string;
  linkedinClientSecret?: string;
  linkedinApiVersion: string;
  /** Ask for the Company Page scopes too (needs LinkedIn's Community Management API product). */
  linkedinOrgScopes?: boolean;
  timeoutMs?: number;
}
