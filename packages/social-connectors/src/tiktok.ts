import { Http, FORM_HEADERS, JSON_HEADERS, form, redact, type FetchLike, type HttpResult } from './http';
import { composeText, validateAgainstLimits } from './validate';
import {
  EMPTY_METRICS, SocialApiError, type AdapterConfig, type AuthorizedAccount, type CandidateAccount, type Metrics, type OAuthStart, type PlatformAdapter, type PublishableContent, type PublishContext,
  type PublishOutcome, type StatusOutcome, type TokenSet,
} from './types';

const API = 'https://open.tiktokapis.com';

function mapTikTok(r: HttpResult): SocialApiError {
  const raw = (r.json ?? {}) as { error?: string | { code?: string; message?: string }; error_description?: string; message?: string };
  const code = typeof raw.error === 'string' ? raw.error : raw.error?.code;
  const msg = redact((typeof raw.error === 'object' ? raw.error?.message : undefined) ?? raw.error_description ?? raw.message ?? r.text);
  if (code === 'access_token_invalid' || code === 'invalid_grant' || r.status === 401) return new SocialApiError('auth', `The access token is no longer valid: ${msg}`, { status: r.status, code, outcome: 'not_created' });
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed' || r.status === 403) return new SocialApiError('permission', `A required permission is missing: ${msg}`, { status: r.status, code, outcome: 'not_created' });
  if (code === 'rate_limit_exceeded' || r.status === 429) return new SocialApiError('rate_limit', `The platform is rate limiting requests: ${msg}`, { status: r.status, code, outcome: 'not_created', retryAfterMs: 60_000 });
  if (r.status >= 500 || code === 'internal_error') return new SocialApiError('transient', `The platform had a temporary problem: ${msg}`, { status: r.status, code, outcome: 'unknown' });
  return new SocialApiError('validation', `The platform rejected the request: ${msg}`, { status: r.status, code, outcome: 'not_created' });
}

/**
 * TikTok Content Posting API (https://developers.tiktok.com/doc/content-posting-api-get-started).
 * Restrictions that apply to every merchant: the TikTok app must pass TikTok's audit before posts can be public (until then
 * every post is private to the creator), and PULL_FROM_URL requires the media domain to be verified in the app.
 */
export class TikTokPublisher implements PlatformAdapter {
  readonly platform = 'TIKTOK' as const;
  readonly requiredScopes = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'] as const;
  readonly refreshLeadMs = 2 * 3_600_000;
  readonly supportsRefresh = true;
  private readonly http: Http;

  constructor(private readonly cfg: AdapterConfig, fetchImpl: FetchLike) {
    this.http = new Http(fetchImpl, cfg.timeoutMs);
  }

  missingConfiguration() {
    return [!this.cfg.tiktokClientKey && 'TIKTOK_CLIENT_KEY', !this.cfg.tiktokClientSecret && 'TIKTOK_CLIENT_SECRET'].filter(Boolean) as string[];
  }
  isConfigured() {
    return this.missingConfiguration().length === 0;
  }

  buildAuthorizationUrl(p: { state: string; redirectUri: string }): OAuthStart {
    const q = new URLSearchParams({ client_key: this.cfg.tiktokClientKey ?? '', scope: this.requiredScopes.join(','), response_type: 'code', redirect_uri: p.redirectUri, state: p.state });
    return { url: `https://www.tiktok.com/v2/auth/authorize/?${q.toString()}` };
  }

  private tokens(json: Record<string, any> | null): TokenSet { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!json?.access_token) throw new SocialApiError('validation', 'The platform did not return an access token', { outcome: 'not_created' });
    return {
      accessToken: json.access_token, refreshToken: json.refresh_token ?? null, scopes: String(json.scope ?? '').split(',').filter(Boolean),
      expiresAt: json.expires_in ? new Date(Date.now() + Number(json.expires_in) * 1000) : null, refreshExpiresAt: json.refresh_expires_in ? new Date(Date.now() + Number(json.refresh_expires_in) * 1000) : null,
    };
  }

  async exchangeCode(p: { code: string; redirectUri: string }): Promise<TokenSet> {
    const r = await this.http.ok(`${API}/v2/oauth/token/`, { method: 'POST', headers: FORM_HEADERS, body: form({ client_key: this.cfg.tiktokClientKey, client_secret: this.cfg.tiktokClientSecret, code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri }) }, mapTikTok);
    if (r.json?.error) throw mapTikTok(r);
    return this.tokens(r.json);
  }

  async refresh(t: TokenSet): Promise<TokenSet> {
    if (!t.refreshToken) throw new SocialApiError('auth', 'There is no refresh token; the account must be reconnected', { outcome: 'not_created' });
    const r = await this.http.ok(`${API}/v2/oauth/token/`, { method: 'POST', headers: FORM_HEADERS, body: form({ client_key: this.cfg.tiktokClientKey, client_secret: this.cfg.tiktokClientSecret, grant_type: 'refresh_token', refresh_token: t.refreshToken }) }, mapTikTok);
    if (r.json?.error) throw mapTikTok(r);
    return this.tokens(r.json);
  }

  async revoke(t: TokenSet) {
    await this.http.request(`${API}/v2/oauth/revoke/`, { method: 'POST', headers: FORM_HEADERS, body: form({ client_key: this.cfg.tiktokClientKey, client_secret: this.cfg.tiktokClientSecret, token: t.accessToken }) });
  }

  async listAccounts(t: TokenSet): Promise<CandidateAccount[]> {
    const r = await this.http.ok(`${API}/v2/user/info/`, { query: { fields: 'open_id,union_id,avatar_url,display_name' }, headers: { authorization: `Bearer ${t.accessToken}` } }, mapTikTok);
    const u = (r.json?.data?.user ?? {}) as { open_id?: string; display_name?: string; avatar_url?: string };
    if (!u.open_id) return [];
    const missing = this.requiredScopes.filter((s) => t.scopes.length > 0 && !t.scopes.includes(s));
    return [{ externalAccountId: u.open_id, displayName: u.display_name ?? null, avatarUrl: u.avatar_url ?? null, accountType: 'CREATOR', tokens: t, scopesGranted: t.scopes, permissionsMissing: [...missing], metadata: {} }];
  }

  validate(c: PublishableContent) {
    return validateAgainstLimits('TIKTOK', c);
  }

  private headers(a: AuthorizedAccount) {
    return { ...JSON_HEADERS, authorization: `Bearer ${a.tokens.accessToken}` };
  }

  private async privacy(a: AuthorizedAccount): Promise<string> {
    const r = await this.http.ok(`${API}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: this.headers(a), body: '{}' }, mapTikTok);
    const options = (r.json?.data?.privacy_level_options ?? []) as string[];
    // Public when the app and the creator allow it. Unaudited apps are limited to SELF_ONLY: that is a platform restriction, not hidden by TOUMA.
    return options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (options[0] ?? 'SELF_ONLY');
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    if (ctx.resume?.stage === 'PUBLISH_INIT') return { status: 'PROCESSING', ref: ctx.resume.ref, stage: 'PUBLISH_INIT', retryAfterMs: 0 };
    const privacy = await this.privacy(a);
    const title = composeText(c).slice(0, 2200);
    await ctx.beforeCreate();
    const body = c.kind === 'VIDEO'
      ? { post_info: { title, privacy_level: privacy }, source_info: { source: 'PULL_FROM_URL', video_url: c.media[0]!.url } }
      : { post_info: { title: (c.title ?? c.caption).slice(0, 90), description: title, privacy_level: privacy }, source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: c.media.map((m) => m.url) }, post_mode: 'DIRECT_POST', media_type: 'PHOTO' };
    const path = c.kind === 'VIDEO' ? '/v2/post/publish/video/init/' : '/v2/post/publish/content/init/';
    const r = await this.http.ok(`${API}${path}`, { method: 'POST', headers: this.headers(a), body: JSON.stringify(body) }, mapTikTok);
    if (r.json?.error?.code && r.json.error.code !== 'ok') throw mapTikTok(r);
    const id = r.json?.data?.publish_id as string | undefined;
    if (!id) throw new SocialApiError('transient', 'TikTok did not return a publish id', { outcome: 'unknown' });
    await ctx.checkpoint('PUBLISH_INIT', id);
    return { status: 'PROCESSING', ref: id, stage: 'PUBLISH_INIT', retryAfterMs: 8_000 };
  }

  async status(a: AuthorizedAccount, ref: string): Promise<StatusOutcome> {
    const r = await this.http.ok(`${API}/v2/post/publish/status/fetch/`, { method: 'POST', headers: this.headers(a), body: JSON.stringify({ publish_id: ref }) }, mapTikTok);
    const d = (r.json?.data ?? {}) as { status?: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number> };
    if (d.status === 'PUBLISH_COMPLETE') {
      const id = d.publicaly_available_post_id?.[0];
      // A private (audit-restricted) post has no public id: the publish id is then the only handle and there is no link.
      return { status: 'PUBLISHED', externalPostId: id !== undefined ? String(id) : ref, url: null, raw: d };
    }
    if (d.status === 'FAILED') return { status: 'FAILED', code: 'PLATFORM_REJECTED', message: `TikTok could not publish this: ${redact(d.fail_reason ?? 'unknown reason')}`, raw: d };
    return { status: 'PROCESSING', ref, stage: 'PUBLISH_INIT', retryAfterMs: 8_000 };
  }

  async fetchMetrics(a: AuthorizedAccount, postId: string): Promise<Metrics> {
    try {
      const r = await this.http.ok(`${API}/v2/video/query/`, { method: 'POST', query: { fields: 'id,like_count,comment_count,share_count,view_count' }, headers: this.headers(a), body: JSON.stringify({ filters: { video_ids: [postId] } }) }, mapTikTok);
      const v = (r.json?.data?.videos?.[0] ?? null) as { like_count?: number; comment_count?: number; share_count?: number; view_count?: number } | null;
      if (!v) return { ...EMPTY_METRICS, unavailableReason: 'The platform returned no data for this video (private posts have no public statistics).' };
      const num = (x: unknown) => (typeof x === 'number' ? x : null);
      return { ...EMPTY_METRICS, views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count), raw: v };
    } catch (e) {
      return { ...EMPTY_METRICS, unavailableReason: e instanceof SocialApiError ? `${e.kind}: ${e.message}` : 'unavailable' };
    }
  }
}
