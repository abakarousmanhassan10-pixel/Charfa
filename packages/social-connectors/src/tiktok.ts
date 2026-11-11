import { checkTikTokSettings, TIKTOK_PRIVACY_LEVELS, type TikTokCreatorInfo, type TikTokPostSettings, type TikTokPrivacyLevel } from '@touma/shared';
import { Http, FORM_HEADERS, JSON_HEADERS, form, redact, type FetchLike, type HttpResult } from './http';
import { composeText, validateAgainstLimits } from './validate';
import { matchCandidates, unavailable } from './reconcile';
import {
  EMPTY_METRICS, SocialApiError, type AdapterConfig, type AuthorizedAccount, type CandidateAccount, type Metrics, type OAuthStart, type PlatformAdapter, type PublishableContent, type PublishContext,
  type PublishOutcome, type ReconcileOutcome, type ReconcileQuery, type StatusOutcome, type TokenSet,
} from './types';

const API = 'https://open.tiktokapis.com';

function mapTikTok(r: HttpResult): SocialApiError {
  const raw = (r.json ?? {}) as { error?: string | { code?: string; message?: string }; error_description?: string; message?: string };
  const code = typeof raw.error === 'string' ? raw.error : raw.error?.code;
  const msg = redact((typeof raw.error === 'object' ? raw.error?.message : undefined) ?? raw.error_description ?? raw.message ?? r.text);
  // TikTok's documented Content Posting errors that need a specific explanation.
  if (code === 'unaudited_client_can_only_post_to_private_accounts') return new SocialApiError('validation', 'TikTok only lets applications that have passed its audit post publicly. Until the TOUMA application is approved, only private posting to a private account is possible.', { status: r.status, code, outcome: 'not_created' });
  if (code === 'url_ownership_unverified') return new SocialApiError('validation', 'TikTok has not verified ownership of the media address. Verify the TOUMA media domain (URL prefix) in the TikTok developer portal.', { status: r.status, code, outcome: 'not_created' });
  if (code === 'privacy_level_option_mismatch') return new SocialApiError('validation', 'The chosen visibility is not available for this TikTok account. Open the post, choose the visibility again and confirm.', { status: r.status, code, outcome: 'not_created' });
  if (code === 'spam_risk_too_many_posts' || code === 'reached_active_user_cap') return new SocialApiError('rate_limit', `TikTok limits how many posts this account or application can publish: ${msg}`, { status: r.status, code, outcome: 'not_created', retryAfterMs: 6 * 3_600_000 });
  if (code === 'spam_risk_user_banned_from_posting' || code === 'spam_risk') return new SocialApiError('permission', `TikTok blocked posting for this account: ${msg}`, { status: r.status, code, outcome: 'not_created' });
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
    const issues = validateAgainstLimits('TIKTOK', c);
    // TikTok's guidelines: the creator must choose privacy, interactions and disclosure and confirm. Nothing is assumed for them.
    const check = checkTikTokSettings(c.tiktok, c.kind);
    if (!check.ok) for (const e of check.errors) issues.push({ code: 'CONTENT_INVALID', message: `TikTok posting settings: ${e.message}` });
    return issues;
  }

  private headers(a: AuthorizedAccount) {
    return { ...JSON_HEADERS, authorization: `Bearer ${a.tokens.accessToken}` };
  }

  /** creator_info/query: what this creator may do right now. TikTok requires showing it to the person before every post. */
  async creatorInfo(a: AuthorizedAccount): Promise<TikTokCreatorInfo> {
    const r = await this.http.ok(`${API}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: this.headers(a), body: '{}' }, mapTikTok);
    if (r.json?.error?.code && r.json.error.code !== 'ok') throw mapTikTok(r);
    const d = (r.json?.data ?? {}) as { creator_nickname?: string; creator_username?: string; creator_avatar_url?: string; privacy_level_options?: string[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number };
    const known = new Set<string>(TIKTOK_PRIVACY_LEVELS);
    return {
      nickname: d.creator_nickname ?? null, username: d.creator_username ?? null, avatarUrl: d.creator_avatar_url ?? null,
      privacyOptions: (d.privacy_level_options ?? []).filter((o): o is TikTokPrivacyLevel => known.has(o)),
      commentDisabled: d.comment_disabled === true, duetDisabled: d.duet_disabled === true, stitchDisabled: d.stitch_disabled === true,
      maxVideoPostDurationSec: typeof d.max_video_post_duration_sec === 'number' ? d.max_video_post_duration_sec : null,
    };
  }

  /** The settings the person confirmed, checked against what the creator's account allows right now. Throws before anything is created. */
  private async effective(a: AuthorizedAccount, c: PublishableContent): Promise<{ s: TikTokPostSettings; info: TikTokCreatorInfo }> {
    const check = checkTikTokSettings(c.tiktok, c.kind);
    if (!check.ok) throw new SocialApiError('validation', `TikTok posting settings are incomplete: ${check.errors.map((e) => e.message).join(' ')}`, { outcome: 'not_created' });
    const info = await this.creatorInfo(a);
    const s = check.value;
    if (!info.privacyOptions.includes(s.privacyLevel)) {
      throw new SocialApiError('validation', `The visibility "${s.privacyLevel}" is not available for this TikTok account any more (available: ${info.privacyOptions.join(', ') || 'none'}). Open the post, choose the visibility again and confirm.`, { outcome: 'not_created' });
    }
    const dur = c.media[0]?.durationSeconds;
    if (c.kind === 'VIDEO' && info.maxVideoPostDurationSec && dur != null && dur > info.maxVideoPostDurationSec) {
      throw new SocialApiError('validation', `This TikTok account can post videos of at most ${info.maxVideoPostDurationSec} s (this one lasts ${Math.round(dur)} s).`, { outcome: 'not_created' });
    }
    return { s, info };
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    if (ctx.resume?.stage === 'PUBLISH_INIT') return { status: 'PROCESSING', ref: ctx.resume.ref, stage: 'PUBLISH_INIT', retryAfterMs: 0 };
    const { s, info } = await this.effective(a, c);
    const title = composeText(c).slice(0, 2200);
    // Interactions the creator switched off in TikTok stay off whatever was chosen here.
    const disableComment = !s.allowComment || info.commentDisabled;
    const disclosure = { brand_content_toggle: s.commercial.enabled && s.commercial.brandedContent, brand_organic_toggle: s.commercial.enabled && s.commercial.yourBrand };
    await ctx.beforeCreate();
    const body = c.kind === 'VIDEO'
      ? { post_info: { title, privacy_level: s.privacyLevel, disable_comment: disableComment, disable_duet: !s.allowDuet || info.duetDisabled, disable_stitch: !s.allowStitch || info.stitchDisabled, ...disclosure }, source_info: { source: 'PULL_FROM_URL', video_url: c.media[0]!.url } }
      : { post_info: { title: (c.title ?? c.caption).slice(0, 90), description: title, privacy_level: s.privacyLevel, disable_comment: disableComment, auto_add_music: false, ...disclosure }, source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: c.media.map((m) => m.url) }, post_mode: 'DIRECT_POST', media_type: 'PHOTO' };
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

  async reconcile(a: AuthorizedAccount, q: ReconcileQuery): Promise<ReconcileOutcome> {
    try {
      // The publish id is the platform's own handle: when we have it, its status is the authority.
      if (q.ref && q.stage === 'PUBLISH_INIT') {
        const st = await this.status(a, q.ref);
        if (st.status === 'PUBLISHED') return { result: 'FOUND', externalPostId: st.externalPostId, url: st.url ?? null };
        if (st.status === 'PROCESSING') return { result: 'UNAVAILABLE', reason: 'TikTok is still processing this post; check again later.' };
      }
      if (!a.tokens.scopes.includes('video.list')) return { result: 'UNAVAILABLE', reason: 'The video.list permission was not granted, so the creator\'s videos cannot be listed. Check the TikTok app by hand.' };
      const found: Array<{ id: string; text: string; at: string; url: string | null }> = [];
      let cursor: number | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await this.http.ok(`${API}/v2/video/list/`, { method: 'POST', query: { fields: 'id,title,video_description,create_time,share_url' }, headers: this.headers(a), body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }) }, mapTikTok);
        const d = (r.json?.data ?? {}) as { videos?: Array<{ id: string; title?: string; video_description?: string; create_time?: number; share_url?: string }>; has_more?: boolean; cursor?: number };
        let older = false;
        for (const v of d.videos ?? []) {
          const at = v.create_time ? new Date(v.create_time * 1000) : null;
          if (at && at.getTime() < q.since.getTime() - 120_000) older = true;
          found.push({ id: v.id, text: v.title ?? v.video_description ?? '', at: at?.toISOString() ?? '', url: v.share_url ?? null });
        }
        if (!d.has_more || older) break;
        cursor = d.cursor;
      }
      return matchCandidates(found, q);
    } catch (e) {
      return unavailable(e);
    }
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
