import { Http, JSON_HEADERS, FORM_HEADERS, form, paginateGraph, redact, type FetchLike, type HttpResult } from './http';
import { composeText, validateAgainstLimits } from './validate';
import { matchCandidates, unavailable } from './reconcile';
import {
  EMPTY_METRICS, SocialApiError, type AdapterConfig, type AuthorizedAccount, type CandidateAccount, type CommentPage, type Metrics, type OAuthStart, type PlatformAdapter, type PublishableContent, type PublishContext,
  type PublishOutcome, type ReconcileOutcome, type ReconcileQuery, type StatusOutcome, type TokenInspection, type TokenSet, type ValidationIssue,
} from './types';

const DAY = 86_400_000;

/** Maps a Graph API error body ({ error: { message, type, code, error_subcode } }) to a normalized error. */
function mapGraph(r: HttpResult): SocialApiError {
  const e = (r.json?.error ?? {}) as { message?: string; code?: number; error_subcode?: number; type?: string };
  const code = e.code;
  const msg = redact(e.message ?? r.text);
  // https://developers.facebook.com/docs/graph-api/guides/error-handling
  if (code === 190 || r.status === 401) return new SocialApiError('auth', `The access token is no longer valid: ${msg}`, { status: r.status, code, outcome: 'not_created' });
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return new SocialApiError('permission', `A required permission is missing: ${msg}`, { status: r.status, code, outcome: 'not_created' });
  // Instagram's per-account publishing limit (error 9 / subcode 2207042) and the "business use case" limits (80000-80014) are quotas, not failures of the post.
  if (e.error_subcode === 2207042 || code === 9 || (code !== undefined && code >= 80000 && code <= 80014)) return new SocialApiError('rate_limit', `The account reached the platform's publishing limit: ${msg}`, { status: r.status, code, outcome: 'not_created', retryAfterMs: 3_600_000 });
  if (e.error_subcode === 2207026) return new SocialApiError('validation', `Instagram does not support this video format. Use MP4 with H.264 video and AAC audio. (${msg})`, { status: r.status, code, outcome: 'not_created' });
  if (e.error_subcode === 2207009) return new SocialApiError('validation', `The image or video aspect ratio is outside what Instagram accepts. (${msg})`, { status: r.status, code, outcome: 'not_created' });
  if (code === 4 || code === 17 || code === 32 || code === 613 || r.status === 429) return new SocialApiError('rate_limit', `The platform is rate limiting requests: ${msg}`, { status: r.status, code, outcome: 'not_created', retryAfterMs: 15 * 60_000 });
  if (code === 1 || code === 2 || r.status >= 500) return new SocialApiError('transient', `The platform had a temporary problem: ${msg}`, { status: r.status, code, outcome: 'unknown' });
  return new SocialApiError('validation', `The platform rejected the request: ${msg}`, { status: r.status, code, outcome: 'not_created' });
}

/** Shared Graph API access for Facebook Pages and Instagram (both use a Meta app and Facebook Login). */
abstract class MetaAdapter implements PlatformAdapter {
  abstract readonly platform: 'FACEBOOK' | 'INSTAGRAM';
  abstract readonly requiredScopes: readonly string[];
  readonly refreshLeadMs = 0;
  /** Meta Page tokens derived from a long-lived user token do not expire; user tokens cannot be refreshed without the person. */
  readonly supportsRefresh = false;
  protected readonly http: Http;
  protected readonly base: string;

  constructor(protected readonly cfg: AdapterConfig, fetchImpl: FetchLike) {
    this.http = new Http(fetchImpl, cfg.timeoutMs);
    this.base = `https://graph.facebook.com/${cfg.metaGraphVersion}`;
  }

  missingConfiguration() {
    return [!this.cfg.metaAppId && 'META_APP_ID', !this.cfg.metaAppSecret && 'META_APP_SECRET'].filter(Boolean) as string[];
  }
  isConfigured() {
    return this.missingConfiguration().length === 0;
  }

  buildAuthorizationUrl(p: { state: string; redirectUri: string; reconnect?: boolean }): OAuthStart {
    const q = new URLSearchParams({ client_id: this.cfg.metaAppId ?? '', redirect_uri: p.redirectUri, state: p.state, response_type: 'code', scope: this.requiredScopes.join(',') });
    // Asking again for permissions the person declined before (reconnect) needs auth_type=rerequest.
    if (p.reconnect) q.set('auth_type', 'rerequest');
    return { url: `https://www.facebook.com/${this.cfg.metaGraphVersion}/dialog/oauth?${q.toString()}` };
  }

  async exchangeCode(p: { code: string; redirectUri: string }): Promise<TokenSet> {
    const short = await this.http.ok(`${this.base}/oauth/access_token`, { query: { client_id: this.cfg.metaAppId, client_secret: this.cfg.metaAppSecret, redirect_uri: p.redirectUri, code: p.code } }, mapGraph);
    const shortToken = short.json?.access_token as string | undefined;
    if (!shortToken) throw new SocialApiError('validation', 'The platform did not return an access token', { outcome: 'not_created' });
    // Page tokens obtained from a long-lived user token never expire, so exchange first.
    const long = await this.http.ok(`${this.base}/oauth/access_token`, { query: { grant_type: 'fb_exchange_token', client_id: this.cfg.metaAppId, client_secret: this.cfg.metaAppSecret, fb_exchange_token: shortToken } }, mapGraph);
    const expires = Number(long.json?.expires_in);
    return { accessToken: (long.json?.access_token as string) ?? shortToken, expiresAt: Number.isFinite(expires) && expires > 0 ? new Date(Date.now() + expires * 1000) : null, scopes: [] };
  }

  async refresh(): Promise<TokenSet> {
    throw new SocialApiError('unsupported', 'Meta tokens cannot be refreshed without the person reconnecting', { outcome: 'not_created' });
  }

  async inspectToken(tokens: TokenSet): Promise<TokenInspection> {
    const r = await this.http.ok(`${this.base}/debug_token`, { query: { input_token: tokens.accessToken, access_token: `${this.cfg.metaAppId}|${this.cfg.metaAppSecret}` } }, mapGraph);
    const d = (r.json?.data ?? {}) as { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] };
    return { valid: d.is_valid === true, expiresAt: d.expires_at && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null, scopes: d.scopes ?? [] };
  }

  async revoke(tokens: TokenSet): Promise<void> {
    await this.http.request(`${this.base}/me/permissions`, { method: 'DELETE', query: { access_token: tokens.accessToken } });
  }

  /** Pages the person manages, with the Instagram business account linked to each. */
  protected async pages(tokens: TokenSet) {
    const perms = await this.http.ok(`${this.base}/me/permissions`, { query: { access_token: tokens.accessToken } }, mapGraph);
    const granted = ((perms.json?.data ?? []) as Array<{ permission: string; status: string }>).filter((p) => p.status === 'granted').map((p) => p.permission);
    type Page = { id: string; name?: string; username?: string; picture?: { data?: { url?: string } }; access_token?: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string } };
    // Every page of the listing is followed (a manager of many Pages has far more than 100); only the safety cap can stop it, and then it says so.
    const res = await paginateGraph<Page>(this.http, `${this.base}/me/accounts`, {
      access_token: tokens.accessToken, limit: '50', fields: 'id,name,username,picture{url},access_token,tasks,instagram_business_account{id,username,name,profile_picture_url}',
    }, mapGraph);
    return { granted, pages: res.items, truncated: res.truncated, pageRequests: res.pages };
  }

  /** Posts the platform lists for an account since a time, following every page of the listing. */
  protected async listSince<T>(path: string, a: AuthorizedAccount, query: Record<string, string>) {
    return paginateGraph<T>(this.http, `${this.base}${path}`, { ...query, access_token: this.token(a) }, mapGraph, 20);
  }

  abstract reconcile(a: AuthorizedAccount, q: ReconcileQuery): Promise<ReconcileOutcome>;

  abstract listAccounts(tokens: TokenSet): Promise<CandidateAccount[]>;
  abstract validate(c: PublishableContent): ValidationIssue[];
  abstract publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome>;
  abstract status(a: AuthorizedAccount, ref: string, stage: string): Promise<StatusOutcome>;
  abstract fetchMetrics(a: AuthorizedAccount, postId: string): Promise<Metrics>;

  protected missing(granted: string[]) {
    return this.requiredScopes.filter((s) => !granted.includes(s));
  }
  protected token(a: AuthorizedAccount) {
    return a.tokens.accessToken;
  }
  protected post(path: string, a: AuthorizedAccount, data: Record<string, string | undefined>) {
    return this.http.ok(`${this.base}${path}`, { method: 'POST', headers: FORM_HEADERS, body: form({ ...data, access_token: this.token(a) }) }, mapGraph);
  }
  protected get(path: string, a: AuthorizedAccount, query: Record<string, string>) {
    return this.http.ok(`${this.base}${path}`, { query: { ...query, access_token: this.token(a) } }, mapGraph);
  }
}

// ─── Facebook Pages ───────────────────────────────────────────────────────────

export class FacebookPublisher extends MetaAdapter {
  readonly platform = 'FACEBOOK' as const;
  readonly requiredScopes = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'read_insights'] as const;

  async listAccounts(tokens: TokenSet): Promise<CandidateAccount[]> {
    const { granted, pages, truncated } = await this.pages(tokens);
    return pages
      .filter((p) => p.access_token)
      .map((p) => {
        const missing = this.missing(granted);
        if (p.tasks && !p.tasks.includes('CREATE_CONTENT')) missing.push('CREATE_CONTENT (page task)');
        return {
          externalAccountId: p.id, displayName: p.name ?? null, username: p.username ?? null, avatarUrl: p.picture?.data?.url ?? null, accountType: 'PAGE',
          tokens: { accessToken: p.access_token!, expiresAt: null, scopes: granted }, scopesGranted: granted, permissionsMissing: missing, metadata: { tasks: p.tasks ?? [], ...(truncated ? { listingTruncated: true } : {}) },
        };
      });
  }

  validate(c: PublishableContent) {
    const issues = validateAgainstLimits('FACEBOOK', c);
    if (c.kind === 'VIDEO' && c.surface === 'REEL') return issues; // already flagged as manual
    return issues;
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    const page = a.externalAccountId;
    const text = composeText(c);
    const done = (id: string): PublishOutcome => ({ status: 'PUBLISHED', externalPostId: id, url: `https://www.facebook.com/${id}` });
    if (c.kind === 'TEXT') {
      await ctx.beforeCreate();
      const r = await this.post(`/${page}/feed`, a, { message: text });
      return done(String(r.json?.id));
    }
    if (c.kind === 'IMAGE') {
      await ctx.beforeCreate();
      const r = await this.post(`/${page}/photos`, a, { url: c.media[0]!.url, caption: text, published: 'true' });
      return done(String(r.json?.post_id ?? r.json?.id));
    }
    if (c.kind === 'CAROUSEL') {
      // Multi-photo post: stage the photos unpublished (safe to repeat), then create ONE feed post that attaches them.
      let ids: string[] = ctx.resume?.stage === 'PHOTOS' ? (JSON.parse(ctx.resume.ref) as string[]) : [];
      if (ids.length !== c.media.length) {
        ids = [];
        for (const m of c.media) {
          const r = await this.post(`/${page}/photos`, a, { url: m.url, published: 'false' });
          ids.push(String(r.json?.id));
        }
        await ctx.checkpoint('PHOTOS', JSON.stringify(ids));
      }
      await ctx.beforeCreate();
      const r = await this.post(`/${page}/feed`, a, { message: text, attached_media: JSON.stringify(ids.map((id) => ({ media_fbid: id }))) });
      return done(String(r.json?.id));
    }
    // VIDEO: the platform downloads it from our signed URL; processing continues on its side.
    await ctx.beforeCreate();
    const r = await this.post(`/${page}/videos`, a, { file_url: c.media[0]!.url, description: text, title: c.title ?? undefined });
    return { status: 'PROCESSING', ref: String(r.json?.id), stage: 'VIDEO_ACCEPTED' };
  }

  async status(a: AuthorizedAccount, ref: string): Promise<StatusOutcome> {
    const r = await this.get(`/${ref}`, a, { fields: 'status,permalink_url' });
    const st = (r.json?.status ?? {}) as { video_status?: string };
    if (st.video_status === 'ready') return { status: 'PUBLISHED', externalPostId: ref, url: r.json?.permalink_url ? `https://www.facebook.com${r.json.permalink_url}` : `https://www.facebook.com/${ref}` };
    if (st.video_status === 'error') return { status: 'FAILED', code: 'PLATFORM_REJECTED', message: 'Facebook could not process the video.' };
    return { status: 'PROCESSING', ref, stage: 'VIDEO_ACCEPTED', retryAfterMs: 15_000 };
  }

  async reconcile(a: AuthorizedAccount, q: ReconcileQuery): Promise<ReconcileOutcome> {
    try {
      // A video accepted earlier has its own id: ask about it directly.
      if (q.ref && q.stage === 'VIDEO_ACCEPTED') {
        const st = await this.status(a, q.ref);
        if (st.status === 'PUBLISHED') return { result: 'FOUND', externalPostId: st.externalPostId, url: st.url ?? null };
      }
      const r = await this.listSince<{ id: string; message?: string; created_time?: string; permalink_url?: string }>(`/${a.externalAccountId}/published_posts`, a, {
        fields: 'id,message,created_time,permalink_url', since: String(Math.floor(q.since.getTime() / 1000) - 120), limit: '50',
      });
      return matchCandidates(r.items.map((x) => ({ id: x.id, text: x.message ?? '', at: x.created_time, url: x.permalink_url ? `https://www.facebook.com${x.permalink_url}` : null })), q, r.items.length);
    } catch (e) {
      return unavailable(e);
    }
  }

  /** GET /{post-id}/comments: needs pages_read_engagement (and, per some sources, more). Read-only. */
  async fetchComments(a: AuthorizedAccount, postId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<CommentPage> {
    const r = await this.get(`/${postId}/comments`, a, { fields: 'id,message,created_time,from{id,name},parent{id}', filter: 'stream', limit: String(Math.min(opts.limit ?? 25, 50)), ...(opts.cursor ? { after: opts.cursor } : {}) });
    const rows = (r.json?.data ?? []) as Array<{ id: string; message?: string; created_time?: string; from?: { id?: string; name?: string }; parent?: { id?: string } }>;
    return {
      items: rows.filter((c) => c.id && typeof c.message === 'string').map((c) => ({ externalId: c.id, parentExternalId: c.parent?.id ?? null, authorExternalId: c.from?.id ?? null, authorName: c.from?.name ?? null, body: c.message!, postedAt: c.created_time ? new Date(c.created_time) : null, isFromBusiness: c.from?.id === a.externalAccountId })),
      nextCursor: (r.json?.paging?.cursors?.after as string | undefined) && r.json?.paging?.next ? (r.json.paging.cursors.after as string) : null,
    };
  }

  /** POST /{comment-id}/comments: a public reply. Needs pages_manage_engagement. */
  async replyToComment(a: AuthorizedAccount, commentId: string, text: string): Promise<{ externalId: string }> {
    const r = await this.post(`/${commentId}/comments`, a, { message: text });
    const id = r.json?.id as string | undefined;
    if (!id) throw new SocialApiError('transient', 'Facebook did not confirm the reply', { outcome: 'unknown' });
    return { externalId: id };
  }

  async fetchMetrics(a: AuthorizedAccount, postId: string): Promise<Metrics> {
    try {
      const ins = await this.get(`/${postId}/insights`, a, { metric: 'post_impressions,post_impressions_unique', period: 'lifetime' });
      const by = new Map(((ins.json?.data ?? []) as Array<{ name: string; values?: Array<{ value: number }> }>).map((m) => [m.name, m.values?.[0]?.value]));
      const obj = await this.get(`/${postId}`, a, { fields: 'shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)' });
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return {
        ...EMPTY_METRICS,
        impressions: num(by.get('post_impressions')), reach: num(by.get('post_impressions_unique')),
        likes: num(obj.json?.reactions?.summary?.total_count), comments: num(obj.json?.comments?.summary?.total_count),
        // The Graph API omits "shares" when nobody shared: that is not a measured zero, so it stays unavailable.
        shares: num(obj.json?.shares?.count), raw: { insights: ins.json, object: obj.json },
      };
    } catch (e) {
      return { ...EMPTY_METRICS, unavailableReason: e instanceof SocialApiError ? `${e.kind}: ${e.message}` : 'unavailable' };
    }
  }
}

// ─── Instagram (Instagram Graph API with Facebook Login) ───────────────────────

export class InstagramPublisher extends MetaAdapter {
  readonly platform = 'INSTAGRAM' as const;
  readonly requiredScopes = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement'] as const;

  async listAccounts(tokens: TokenSet): Promise<CandidateAccount[]> {
    const { granted, pages, truncated } = await this.pages(tokens);
    return pages
      .filter((p) => p.access_token && p.instagram_business_account)
      .map((p) => ({
        externalAccountId: p.instagram_business_account!.id, displayName: p.instagram_business_account!.name ?? p.name ?? null, username: p.instagram_business_account!.username ?? null,
        avatarUrl: p.instagram_business_account!.profile_picture_url ?? null, accountType: 'INSTAGRAM_BUSINESS', parentExternalId: p.id,
        tokens: { accessToken: p.access_token!, expiresAt: null, scopes: granted }, scopesGranted: granted, permissionsMissing: this.missing(granted), metadata: { linkedPage: p.name ?? null, ...(truncated ? { listingTruncated: true } : {}) },
      }));
  }

  validate(c: PublishableContent) {
    const issues = validateAgainstLimits('INSTAGRAM', c);
    // Instagram video is published as a Reel (feed video uploads are no longer offered by the API).
    if (c.kind === 'VIDEO' && c.surface === 'SHORT') issues.push({ code: 'CONTENT_INVALID', message: 'Shorts exist on YouTube only; choose Reel.' });
    return issues;
  }

  /** Waits for a media container to be ready (video containers take time). */
  private async container(a: AuthorizedAccount, id: string): Promise<'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED'> {
    const r = await this.get(`/${id}`, a, { fields: 'status_code' });
    return (r.json?.status_code as 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED') ?? 'IN_PROGRESS';
  }

  private async checkQuota(a: AuthorizedAccount) {
    let r: HttpResult;
    try {
      r = await this.get(`/${a.externalAccountId}/content_publishing_limit`, a, { fields: 'quota_usage,config' });
    } catch (e) {
      if (e instanceof SocialApiError && (e.kind === 'auth' || e.kind === 'permission')) throw e;
      return; // the quota could not be read: the platform will still enforce it when publishing
    }
    const d = ((r.json?.data ?? [])[0] ?? {}) as { quota_usage?: number; config?: { quota_total?: number } };
    if (typeof d.quota_usage === 'number' && typeof d.config?.quota_total === 'number' && d.quota_usage >= d.config.quota_total) {
      throw new SocialApiError('rate_limit', `This Instagram account has used its publishing limit for now (${d.quota_usage} of ${d.config.quota_total} in 24 hours).`, { outcome: 'not_created', retryAfterMs: 3_600_000 });
    }
  }

  private async publishContainer(a: AuthorizedAccount, id: string, ctx: PublishContext): Promise<PublishOutcome> {
    await ctx.beforeCreate();
    const r = await this.post(`/${a.externalAccountId}/media_publish`, a, { creation_id: id });
    const mediaId = String(r.json?.id);
    let permalink: string | null = null;
    try {
      const p = await this.get(`/${mediaId}`, a, { fields: 'permalink' });
      permalink = (p.json?.permalink as string) ?? null;
    } catch {
      permalink = null; // the post exists; only its link could not be read
    }
    return { status: 'PUBLISHED', externalPostId: mediaId, url: permalink };
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    const ig = a.externalAccountId;
    const caption = composeText(c);
    // Resume: the container already exists (created by an earlier attempt).
    if (ctx.resume?.stage === 'CONTAINER') {
      const st = await this.container(a, ctx.resume.ref);
      if (st === 'FINISHED') return this.publishContainer(a, ctx.resume.ref, ctx);
      if (st === 'IN_PROGRESS') return { status: 'PROCESSING', ref: ctx.resume.ref, stage: 'CONTAINER', retryAfterMs: 10_000 };
      throw new SocialApiError('validation', 'Instagram could not process the media.', { outcome: 'not_created' });
    }
    // Instagram limits API-published posts per account per 24 hours: ask first, so a full quota is a clear, retryable condition instead of a failed attempt.
    await this.checkQuota(a);
    let containerId: string;
    if (c.kind === 'IMAGE') {
      containerId = String((await this.post(`/${ig}/media`, a, { image_url: c.media[0]!.url, caption })).json?.id);
    } else if (c.kind === 'VIDEO') {
      containerId = String((await this.post(`/${ig}/media`, a, { media_type: 'REELS', video_url: c.media[0]!.url, caption, share_to_feed: 'true' })).json?.id);
    } else {
      const kids: string[] = [];
      for (const m of c.media) {
        const isVideo = m.mimeType.startsWith('video/');
        kids.push(String((await this.post(`/${ig}/media`, a, isVideo ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true' } : { image_url: m.url, is_carousel_item: 'true' })).json?.id));
      }
      containerId = String((await this.post(`/${ig}/media`, a, { media_type: 'CAROUSEL', children: kids.join(','), caption })).json?.id);
    }
    await ctx.checkpoint('CONTAINER', containerId);
    const st = await this.container(a, containerId);
    if (st === 'FINISHED') return this.publishContainer(a, containerId, ctx);
    if (st === 'IN_PROGRESS') return { status: 'PROCESSING', ref: containerId, stage: 'CONTAINER', retryAfterMs: 10_000 };
    throw new SocialApiError('validation', 'Instagram could not process the media.', { outcome: 'not_created' });
  }

  async status(a: AuthorizedAccount, ref: string, stage: string): Promise<StatusOutcome> {
    if (stage !== 'CONTAINER') return { status: 'FAILED', code: 'PLATFORM_ERROR', message: 'Unknown publication stage.' };
    const st = await this.container(a, ref);
    if (st === 'IN_PROGRESS') return { status: 'PROCESSING', ref, stage, retryAfterMs: 10_000 };
    if (st === 'FINISHED') return { status: 'PROCESSING', ref, stage: 'CONTAINER', retryAfterMs: 0 }; // ready: the engine continues with publish()
    return { status: 'FAILED', code: 'PLATFORM_REJECTED', message: st === 'EXPIRED' ? 'The Instagram media container expired.' : 'Instagram could not process the media.' };
  }

  async reconcile(a: AuthorizedAccount, q: ReconcileQuery): Promise<ReconcileOutcome> {
    try {
      // A container that was already published is visible by its own status; the media list is the authority otherwise.
      const r = await this.listSince<{ id: string; caption?: string; timestamp?: string; permalink?: string }>(`/${a.externalAccountId}/media`, a, { fields: 'id,caption,timestamp,permalink', since: String(Math.floor(q.since.getTime() / 1000) - 120), limit: '50' });
      return matchCandidates(r.items.map((x) => ({ id: x.id, text: x.caption ?? '', at: x.timestamp, url: x.permalink ?? null })), q, r.items.length);
    } catch (e) {
      return unavailable(e);
    }
  }

  /** GET /{media-id}/comments (Instagram API with Facebook Login): needs instagram_manage_comments. Read-only. */
  async fetchComments(a: AuthorizedAccount, mediaId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<CommentPage> {
    const r = await this.get(`/${mediaId}/comments`, a, { fields: 'id,text,timestamp,username,from{id,username},parent_id', limit: String(Math.min(opts.limit ?? 25, 50)), ...(opts.cursor ? { after: opts.cursor } : {}) });
    const rows = (r.json?.data ?? []) as Array<{ id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string }; parent_id?: string }>;
    return {
      items: rows.filter((c) => c.id && typeof c.text === 'string').map((c) => ({ externalId: c.id, parentExternalId: c.parent_id ?? null, authorExternalId: c.from?.id ?? null, authorName: c.username ?? c.from?.username ?? null, body: c.text!, postedAt: c.timestamp ? new Date(c.timestamp) : null, isFromBusiness: c.from?.id === a.externalAccountId })),
      nextCursor: (r.json?.paging?.cursors?.after as string | undefined) && r.json?.paging?.next ? (r.json.paging.cursors.after as string) : null,
    };
  }

  /** POST /{comment-id}/replies: a public reply. Needs instagram_manage_comments. */
  async replyToComment(a: AuthorizedAccount, commentId: string, text: string): Promise<{ externalId: string }> {
    const r = await this.post(`/${commentId}/replies`, a, { message: text });
    const id = r.json?.id as string | undefined;
    if (!id) throw new SocialApiError('transient', 'Instagram did not confirm the reply', { outcome: 'unknown' });
    return { externalId: id };
  }

  async fetchMetrics(a: AuthorizedAccount, mediaId: string): Promise<Metrics> {
    try {
      const r = await this.get(`/${mediaId}/insights`, a, { metric: 'reach,likes,comments,shares,saved,views' });
      const by = new Map(((r.json?.data ?? []) as Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }>).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value]));
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return { ...EMPTY_METRICS, reach: num(by.get('reach')), likes: num(by.get('likes')), comments: num(by.get('comments')), shares: num(by.get('shares')), saves: num(by.get('saved')), views: num(by.get('views')), raw: r.json };
    } catch (e) {
      return { ...EMPTY_METRICS, unavailableReason: e instanceof SocialApiError ? `${e.kind}: ${e.message}` : 'unavailable' };
    }
  }
}

export { DAY as META_DAY, JSON_HEADERS as META_JSON_HEADERS };
