import type { ContentKind, SocialPlatformId, TikTokCreatorInfo, TikTokPostSettings, VideoSurface } from '@touma/shared';

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

export interface ConnectionVariant {
  id: string;
  /** The account type this variant connects (PROFILE, ORGANIZATION). */
  accountType: string;
  enabled: boolean;
  configured: boolean;
  missingConfiguration: string[];
  scopes: string[];
  /** Why it is disabled, and what is required to enable it. */
  reason: string | null;
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
  /** Video codec fourcc as probed from the file (avc1 = H.264, hvc1/hev1 = H.265, vp09, av01...). */
  videoCodec?: string | null;
  audioCodec?: string | null;
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
  /** TikTok only: what the person chose on the TikTok posting screen (privacy, interactions, disclosure, consent). */
  tiktok?: TikTokPostSettings | null;
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
  | { status: 'PUBLISHED'; externalPostId: string; url?: string | null; raw?: unknown; /** The platform published it with less visibility than requested (for example a YouTube upload locked to private). Shown to the person, never hidden. */ notice?: string | null }
  /** Accepted, still being processed by the platform. Poll status() with `ref`. */
  | { status: 'PROCESSING'; ref: string; stage: string; retryAfterMs?: number; raw?: unknown };

/** What a platform listing says about a post whose creation outcome is unknown. */
export type ReconcileOutcome =
  | { result: 'FOUND'; externalPostId: string; url?: string | null; raw?: unknown }
  /** The platform was searched and nothing matches. Not proof (listings lag): a person still decides. */
  | { result: 'NOT_FOUND'; checked: number }
  /** More than one post matches: only a person can tell which one is ours. */
  | { result: 'AMBIGUOUS'; candidates: Array<{ id: string; url?: string | null }> }
  /** The platform (or the granted permissions) offers no way to look this up. */
  | { result: 'UNAVAILABLE'; reason: string };

export interface ReconcileQuery {
  /** The exact text the post was created with (caption, hashtags). */
  text: string;
  title?: string | null;
  /** The earliest time the post can have been created (when the create request started). */
  since: Date;
  /** Provider reference of an in-flight step, when one was recorded. */
  ref?: string | null;
  stage?: string | null;
}

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

/** A comment on one of the business's own posts, as a platform reports it. */
export interface CommentItem {
  externalId: string;
  parentExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  body: string;
  postedAt: Date | null;
  /** True when the author is the connected account itself. */
  isFromBusiness: boolean;
}
export interface CommentPage {
  items: CommentItem[];
  nextCursor: string | null;
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

  buildAuthorizationUrl(p: { state: string; redirectUri: string; reconnect?: boolean; variant?: string }): OAuthStart;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string | null; variant?: string }): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  /** The accounts this authorization can publish to. */
  listAccounts(tokens: TokenSet, opts?: { variant?: string }): Promise<CandidateAccount[]>;
  /**
   * Separately configured ways to connect this platform (LinkedIn: personal profile vs organization). Absent = one way only.
   * A disabled variant cannot be connected or published to; `reason` says why and what unlocks it.
   */
  variants?(): ConnectionVariant[];
  inspectToken?(tokens: TokenSet): Promise<TokenInspection>;
  /** TikTok: the creator's current posting options, to be shown to the person right before posting. */
  creatorInfo?(account: AuthorizedAccount): Promise<TikTokCreatorInfo>;
  revoke?(tokens: TokenSet): Promise<void>;

  /** Format and media checks against the platform's rules, before anything is sent. */
  validate(content: PublishableContent): ValidationIssue[];
  publish(account: AuthorizedAccount, content: PublishableContent, ctx: PublishContext): Promise<PublishOutcome>;
  status(account: AuthorizedAccount, ref: string, stage: string): Promise<StatusOutcome>;
  /** Looks on the platform for a post created by an attempt whose outcome is unknown. Read-only; never creates anything. */
  reconcile(account: AuthorizedAccount, q: ReconcileQuery): Promise<ReconcileOutcome>;
  fetchMetrics(account: AuthorizedAccount, externalPostId: string): Promise<Metrics>;

  /**
   * Optional (Phase N19): reading and answering comments on the business's own posts. An adapter that does not implement them
   * (TikTok, LinkedIn) is never asked: callers check the capability first and an unsupported call fails with kind 'unsupported'.
   * Reading never changes anything. Replying creates a public comment; platforms accept no idempotency key, so the caller records
   * the intent first and never retries a reply whose outcome is 'unknown'.
   */
  fetchComments?(account: AuthorizedAccount, externalPostId: string, opts?: { cursor?: string | null; limit?: number }): Promise<CommentPage>;
  replyToComment?(account: AuthorizedAccount, commentExternalId: string, text: string): Promise<{ externalId: string }>;
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
  /** LinkedIn personal profile publishing (default on). */
  linkedinPersonalEnabled?: boolean;
  /** LinkedIn Company Page publishing: off until LinkedIn approves the Community Management API. */
  linkedinOrgEnabled?: boolean;
  /** Credentials of the application approved for Community Management; the personal application's are used when absent. */
  linkedinOrgClientId?: string;
  linkedinOrgClientSecret?: string;
  timeoutMs?: number;
}
