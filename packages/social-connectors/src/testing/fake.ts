import { randomBytes } from 'crypto';
import { validateAgainstLimits, composeText } from '../validate';
import { matchCandidates, unavailable } from '../reconcile';
import {
  EMPTY_METRICS, SocialApiError, type ConnectionVariant, type AuthorizedAccount, type CandidateAccount, type CommentItem, type CommentPage, type Metrics, type OAuthStart, type Platform, type PlatformAdapter, type PublishableContent, type PublishContext,
  type PublishOutcome, type ReconcileOutcome, type ReconcileQuery, type StatusOutcome, type TokenInspection, type TokenSet,
} from '../types';
import { SOCIAL_PLATFORMS, PLATFORM_CAPABILITIES, checkTikTokSettings, type TikTokCreatorInfo } from '@touma/shared';

/**
 * TEST-ONLY platform simulator (SOCIAL_PROVIDER_MODE=fake, refused unless APP_ENV=test).
 * It never talks to a network. Tests script its behavior and read back what was "sent"; nothing it does is evidence
 * about a real platform.
 */
export type Step = 'exchange' | 'refresh' | 'list' | 'publish' | 'status' | 'metrics' | 'reconcile' | 'comments' | 'reply';
export type Scripted = SocialApiError | 'ok' | 'processing' | 'unavailable' | { createThen: SocialApiError };

export interface FakeCall {
  platform: Platform;
  op: string;
  idempotencyKey?: string;
  kind?: string;
  mediaUrls?: string[];
  accessToken?: string;
  detail?: Record<string, unknown>;
}

export class FakeSocialHub {
  calls: FakeCall[] = [];
  /** Posts that exist on the "platform". */
  posts: Array<{ platform: Platform; id: string; key: string; accountId: string; content: PublishableContent; at: Date }> = [];
  accounts: Partial<Record<Platform, CandidateAccount[]>> = {};
  tokenLifetimeMs: number | null = 3_600_000;
  /** Access tokens the platform rejects (expired or revoked). */
  rejectedTokens = new Set<string>();
  /** Platforms that publish with less visibility than requested, with the notice they report (for example an unaudited YouTube project). */
  restrictedVisibility: Partial<Record<Platform, string>> = {};
  /** Simulated LinkedIn approval state: organization publishing is off until a test switches it on. */
  linkedinOrgEnabled = false;
  metrics = new Map<string, Metrics>();
  /** Comments that exist on the simulated platform, by post id. */
  commentsByPost = new Map<string, CommentItem[]>();
  /** Replies the simulated platform received. */
  replies: Array<{ platform: Platform; parentId: string; text: string; id: string }> = [];
  /** What the simulated TikTok creator_info/query returns (an unaudited app typically offers only SELF_ONLY). */
  creatorInfo: TikTokCreatorInfo = { nickname: 'Test Creator', username: 'testcreator', avatarUrl: null, privacyOptions: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 600 };
  private scripts = new Map<string, Scripted[]>();
  private seq = 0;
  /** Resume state per idempotency key, like a platform-side container. */
  containers = new Map<string, string>();

  reset() {
    this.calls = [];
    this.posts = [];
    this.accounts = {};
    this.tokenLifetimeMs = 3_600_000;
    this.rejectedTokens.clear();
    this.metrics.clear();
    this.commentsByPost.clear();
    this.replies = [];
    this.linkedinOrgEnabled = false;
    this.restrictedVisibility = {};
    this.creatorInfo = { nickname: 'Test Creator', username: 'testcreator', avatarUrl: null, privacyOptions: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 600 };
    this.scripts.clear();
    this.containers.clear();
  }

  script(platform: Platform | '*', step: Step, ...outcomes: Scripted[]) {
    const k = `${platform}:${step}`;
    this.scripts.set(k, [...(this.scripts.get(k) ?? []), ...outcomes]);
  }

  next(platform: Platform, step: Step): Scripted {
    return this.scripts.get(`${platform}:${step}`)?.shift() ?? this.scripts.get(`*:${step}`)?.shift() ?? 'ok';
  }

  id(prefix: string) {
    this.seq += 1;
    return `${prefix}${this.seq}${randomBytes(2).toString('hex')}`;
  }

  count(platform: Platform, op: string) {
    return this.calls.filter((c) => c.platform === platform && c.op === op).length;
  }

  defaultAccounts(platform: Platform): CandidateAccount[] {
    const type = { FACEBOOK: 'PAGE', INSTAGRAM: 'INSTAGRAM_BUSINESS', TIKTOK: 'CREATOR', YOUTUBE: 'CHANNEL', LINKEDIN: 'PROFILE' }[platform];
    return [1, 2].map((i) => ({
      externalAccountId: `${platform.toLowerCase()}-acc-${i}`, displayName: `${PLATFORM_CAPABILITIES[platform].label} account ${i}`, username: `acc${i}`, avatarUrl: null, accountType: type,
      parentExternalId: platform === 'INSTAGRAM' ? `page-${i}` : null, tokens: { accessToken: `${platform}-token-${i}`, refreshToken: platform === 'FACEBOOK' || platform === 'INSTAGRAM' ? null : `${platform}-refresh-${i}`, expiresAt: null, scopes: ['all'] },
      scopesGranted: ['all'], permissionsMissing: [], metadata: {},
    }));
  }
}

export class FakeAdapter implements PlatformAdapter {
  readonly requiredScopes = ['all'] as const;
  readonly refreshLeadMs: number;
  readonly supportsRefresh: boolean;
  constructor(readonly platform: Platform, private readonly hub: FakeSocialHub) {
    this.supportsRefresh = platform !== 'FACEBOOK' && platform !== 'INSTAGRAM';
    this.refreshLeadMs = platform === 'YOUTUBE' ? 10 * 60_000 : 2 * 3_600_000;
    this.installComments();
  }

  missingConfiguration() {
    return [];
  }
  isConfigured() {
    return true;
  }

  private fail(step: Step) {
    const s = this.hub.next(this.platform, step);
    if (s instanceof SocialApiError) throw s;
    return s;
  }

  buildAuthorizationUrl(p: { state: string; redirectUri: string }): OAuthStart {
    this.hub.calls.push({ platform: this.platform, op: 'authorize', detail: { redirectUri: p.redirectUri } });
    return { url: `https://fake-platform.test/${this.platform}/authorize?state=${p.state}`, codeVerifier: 'fake-verifier' };
  }

  async exchangeCode(p: { code: string; codeVerifier?: string | null }): Promise<TokenSet> {
    this.hub.calls.push({ platform: this.platform, op: 'exchange', detail: { code: p.code, verifier: p.codeVerifier ?? null } });
    this.fail('exchange');
    if (p.code !== 'valid-code') throw new SocialApiError('validation', 'The authorization code is invalid or was already used', { outcome: 'not_created' });
    return { accessToken: this.hub.id('user-token-'), refreshToken: this.supportsRefresh ? this.hub.id('user-refresh-') : null, expiresAt: this.hub.tokenLifetimeMs ? new Date(Date.now() + this.hub.tokenLifetimeMs) : null, scopes: ['all'] };
  }

  async refresh(t: TokenSet): Promise<TokenSet> {
    this.hub.calls.push({ platform: this.platform, op: 'refresh', accessToken: t.accessToken });
    if (!this.supportsRefresh) throw new SocialApiError('unsupported', 'This platform cannot refresh tokens', { outcome: 'not_created' });
    this.fail('refresh');
    if (!t.refreshToken) throw new SocialApiError('auth', 'no refresh token', { outcome: 'not_created' });
    return { accessToken: this.hub.id('fresh-token-'), refreshToken: t.refreshToken, expiresAt: this.hub.tokenLifetimeMs ? new Date(Date.now() + this.hub.tokenLifetimeMs) : null, scopes: t.scopes };
  }

  variants(): ConnectionVariant[] {
    if (this.platform !== 'LINKEDIN') return undefined as unknown as ConnectionVariant[];
    return [
      { id: 'personal', accountType: 'PROFILE', enabled: true, configured: true, missingConfiguration: [], scopes: ['w_member_social'], reason: null },
      { id: 'organization', accountType: 'ORGANIZATION', enabled: this.hub.linkedinOrgEnabled, configured: true, missingConfiguration: [], scopes: ['w_organization_social'], reason: this.hub.linkedinOrgEnabled ? null : 'Organization (Company Page) publishing is disabled until LinkedIn approves the Community Management API for the TOUMA application.' },
    ];
  }

  async listAccounts(t: TokenSet, opts: { variant?: string } = {}): Promise<CandidateAccount[]> {
    this.hub.calls.push({ platform: this.platform, op: 'list', accessToken: t.accessToken, detail: { variant: opts.variant ?? null } });
    this.fail('list');
    if (this.platform === 'LINKEDIN' && opts.variant === 'organization') {
      return [1, 2].map((i) => ({ externalAccountId: `urn:li:organization:${i}`, displayName: `Company Page ${i}`, username: null, avatarUrl: null, accountType: 'ORGANIZATION', tokens: { accessToken: `org-token-${i}`, refreshToken: `org-refresh-${i}`, expiresAt: null, scopes: ['w_organization_social'] }, scopesGranted: ['w_organization_social'], permissionsMissing: [], metadata: {} }));
    }
    return (this.hub.accounts[this.platform] ?? this.hub.defaultAccounts(this.platform)).map((a) => ({ ...a, tokens: { ...a.tokens, expiresAt: a.tokens.expiresAt ?? (this.supportsRefresh && this.hub.tokenLifetimeMs ? new Date(Date.now() + this.hub.tokenLifetimeMs) : null) } }));
  }

  async inspectToken(t: TokenSet): Promise<TokenInspection> {
    return { valid: !this.hub.rejectedTokens.has(t.accessToken), expiresAt: t.expiresAt ?? null };
  }

  async revoke(t: TokenSet) {
    this.hub.calls.push({ platform: this.platform, op: 'revoke', accessToken: t.accessToken });
  }

  validate(c: PublishableContent) {
    const issues = validateAgainstLimits(this.platform, c);
    if (this.platform === 'TIKTOK') {
      const check = checkTikTokSettings(c.tiktok, c.kind);
      if (!check.ok) for (const e of check.errors) issues.push({ code: 'CONTENT_INVALID', message: `TikTok posting settings: ${e.message}` });
    }
    return issues;
  }

  async creatorInfo(a: AuthorizedAccount): Promise<TikTokCreatorInfo> {
    this.hub.calls.push({ platform: this.platform, op: 'creator_info', accessToken: a.tokens.accessToken });
    this.guard(a);
    return this.hub.creatorInfo;
  }

  private guard(a: AuthorizedAccount) {
    if (this.hub.rejectedTokens.has(a.tokens.accessToken)) throw new SocialApiError('auth', 'The access token is no longer valid', { status: 401, outcome: 'not_created' });
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    this.hub.calls.push({ platform: this.platform, op: 'publish', idempotencyKey: ctx.idempotencyKey, kind: c.kind, mediaUrls: c.media.map((m) => m.url), accessToken: a.tokens.accessToken, detail: { resume: ctx.resume ?? null, caption: c.caption, surface: c.surface, accountId: a.externalAccountId, hashtags: c.hashtags, tiktok: c.tiktok ?? null } });
    this.guard(a);
    const first = this.hub.next(this.platform, 'publish');
    if (first instanceof SocialApiError) throw first; // refused before anything was created
    if (this.platform === 'TIKTOK' && c.tiktok && !this.hub.creatorInfo.privacyOptions.includes(c.tiktok.privacyLevel)) {
      throw new SocialApiError('validation', `The visibility "${c.tiktok.privacyLevel}" is not available for this TikTok account any more.`, { outcome: 'not_created' });
    }
    const needsContainer = this.platform === 'INSTAGRAM' || this.platform === 'TIKTOK';
    if (needsContainer && !ctx.resume) {
      const ref = this.hub.id('container-');
      this.hub.containers.set(ctx.idempotencyKey, ref);
      await ctx.checkpoint('CONTAINER', ref);
      if (first === 'processing') return { status: 'PROCESSING', ref, stage: 'CONTAINER', retryAfterMs: 1 };
    }
    await ctx.beforeCreate();
    const existing = this.hub.posts.find((p) => p.key === ctx.idempotencyKey);
    // A real platform would happily create a second post; the simulator does too, so tests can detect duplicates.
    const id = this.hub.id(`${this.platform.toLowerCase()}-post-`);
    this.hub.posts.push({ platform: this.platform, id, key: ctx.idempotencyKey, accountId: a.externalAccountId, content: c, at: new Date() });
    void existing;
    if (typeof first === 'object' && 'createThen' in first) throw first.createThen; // created, but the answer was lost
    return { status: 'PUBLISHED', externalPostId: id, url: `https://fake-platform.test/${this.platform}/${id}`, notice: this.hub.restrictedVisibility[this.platform] ?? null };
  }

  async status(a: AuthorizedAccount, ref: string): Promise<StatusOutcome> {
    this.hub.calls.push({ platform: this.platform, op: 'status', accessToken: a.tokens.accessToken, detail: { ref } });
    this.guard(a);
    const s = this.hub.next(this.platform, 'status');
    if (s instanceof SocialApiError) throw s;
    if (s === 'processing') return { status: 'PROCESSING', ref, stage: 'CONTAINER', retryAfterMs: 1 };
    // ready: the engine continues with publish()
    return { status: 'PROCESSING', ref, stage: 'CONTAINER', retryAfterMs: 0 };
  }

  async reconcile(a: AuthorizedAccount, q: ReconcileQuery): Promise<ReconcileOutcome> {
    this.hub.calls.push({ platform: this.platform, op: 'reconcile', accessToken: a.tokens.accessToken, detail: { since: q.since.toISOString() } });
    try {
      this.guard(a);
      const s = this.hub.next(this.platform, 'reconcile');
      if (s instanceof SocialApiError) throw s;
      if (s === 'unavailable') return { result: 'UNAVAILABLE', reason: 'The simulated platform offers no listing.' };
    } catch (e) {
      return unavailable(e);
    }
    const mine = this.hub.posts.filter((p) => p.platform === this.platform && p.accountId === a.externalAccountId);
    return matchCandidates(mine.map((p) => ({ id: p.id, text: composeText(p.content), at: p.at.toISOString(), url: `https://fake-platform.test/${this.platform}/${p.id}` })), q);
  }


  /** Only the platforms whose real adapter implements comments do here too: the simulator must not offer what the platform does not. */
  private get commentsSupported() {
    return this.platform === 'FACEBOOK' || this.platform === 'INSTAGRAM' || this.platform === 'YOUTUBE';
  }
  fetchComments?: (a: AuthorizedAccount, postId: string, opts?: { cursor?: string | null; limit?: number }) => Promise<CommentPage>;
  replyToComment?: (a: AuthorizedAccount, commentId: string, text: string) => Promise<{ externalId: string }>;

  private installComments() {
    if (!this.commentsSupported) return;
    this.fetchComments = async (a, postId) => {
      this.hub.calls.push({ platform: this.platform, op: 'comments', accessToken: a.tokens.accessToken, detail: { postId } });
      this.guard(a);
      const s = this.hub.next(this.platform, 'comments');
      if (s instanceof SocialApiError) throw s;
      return { items: this.hub.commentsByPost.get(postId) ?? [], nextCursor: null };
    };
    this.replyToComment = async (a, commentId, text) => {
      this.hub.calls.push({ platform: this.platform, op: 'reply', accessToken: a.tokens.accessToken, detail: { commentId } });
      this.guard(a);
      const s = this.hub.next(this.platform, 'reply');
      if (s instanceof SocialApiError) throw s;
      const id = this.hub.id('reply-');
      this.hub.replies.push({ platform: this.platform, parentId: commentId, text, id });
      return { externalId: id };
    };
  }

  async fetchMetrics(a: AuthorizedAccount, postId: string): Promise<Metrics> {
    this.hub.calls.push({ platform: this.platform, op: 'metrics', accessToken: a.tokens.accessToken, detail: { postId } });
    this.guard(a);
    const s = this.hub.next(this.platform, 'metrics');
    if (s instanceof SocialApiError) throw s;
    return this.hub.metrics.get(postId) ?? { ...EMPTY_METRICS, likes: 0, comments: 2, unavailableReason: 'Reach and impressions are not provided for this post.' };
  }
}

export function createFakeAdapters(hub: FakeSocialHub): Record<Platform, PlatformAdapter> {
  return Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, new FakeAdapter(p, hub)])) as unknown as Record<Platform, PlatformAdapter>;
}
