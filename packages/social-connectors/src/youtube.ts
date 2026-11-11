import { PLATFORM_CAPABILITIES } from '@touma/shared';
import { Http, FORM_HEADERS, JSON_HEADERS, form, redact, type FetchLike, type HttpResult } from './http';
import { composeText, validateAgainstLimits } from './validate';
import {
  EMPTY_METRICS, SocialApiError, type AdapterConfig, type AuthorizedAccount, type CandidateAccount, type Metrics, type OAuthStart, type PlatformAdapter, type PublishableContent, type PublishContext,
  type PublishOutcome, type StatusOutcome, type TokenInspection, type TokenSet, type ValidationIssue,
} from './types';
import { createHash, randomBytes } from 'crypto';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] as const;

function mapGoogle(r: HttpResult): SocialApiError {
  const e = (r.json?.error ?? {}) as { message?: string; status?: string; errors?: Array<{ reason?: string }> } | string;
  const reason = typeof e === 'object' ? e.errors?.[0]?.reason : undefined;
  const msg = redact(typeof e === 'string' ? `${e}: ${r.json?.error_description ?? ''}` : (e.message ?? r.text));
  if (r.status === 401 || (typeof e === 'string' && e === 'invalid_grant')) return new SocialApiError('auth', `The access token is no longer valid: ${msg}`, { status: r.status, outcome: 'not_created' });
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded' || r.status === 429) return new SocialApiError('rate_limit', `The YouTube API quota is exhausted: ${msg}`, { status: r.status, code: reason, outcome: 'not_created', retryAfterMs: 3_600_000 });
  if (r.status === 403) return new SocialApiError('permission', `A required permission is missing: ${msg}`, { status: r.status, code: reason, outcome: 'not_created' });
  if (r.status >= 500) return new SocialApiError('transient', `The platform had a temporary problem: ${msg}`, { status: r.status, outcome: 'unknown' });
  return new SocialApiError('validation', `The platform rejected the request: ${msg}`, { status: r.status, code: reason, outcome: 'not_created' });
}

/**
 * YouTube Data API v3. Videos only (long videos and Shorts, which are ordinary uploads that are vertical or square and short).
 * Restrictions: the upload costs 1,600 quota units (default 10,000 per day per Google project), and videos uploaded by an API
 * project that has not passed Google's audit are locked to private.
 */
export class YouTubePublisher implements PlatformAdapter {
  readonly platform = 'YOUTUBE' as const;
  readonly requiredScopes = SCOPES;
  readonly refreshLeadMs = 10 * 60_000;
  readonly supportsRefresh = true;
  private readonly http: Http;

  constructor(private readonly cfg: AdapterConfig, fetchImpl: FetchLike) {
    this.http = new Http(fetchImpl, cfg.timeoutMs);
  }

  missingConfiguration() {
    return [!this.cfg.googleClientId && 'GOOGLE_CLIENT_ID', !this.cfg.googleClientSecret && 'GOOGLE_CLIENT_SECRET'].filter(Boolean) as string[];
  }
  isConfigured() {
    return this.missingConfiguration().length === 0;
  }

  buildAuthorizationUrl(p: { state: string; redirectUri: string; reconnect?: boolean }): OAuthStart {
    const verifier = randomBytes(48).toString('base64url');
    const q = new URLSearchParams({
      client_id: this.cfg.googleClientId ?? '', redirect_uri: p.redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', include_granted_scopes: 'true', state: p.state,
      // consent is required to receive a refresh token again when reconnecting.
      prompt: 'consent', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`, codeVerifier: verifier };
  }

  private tokens(json: Record<string, any> | null, previous?: TokenSet): TokenSet { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!json?.access_token) throw new SocialApiError('validation', 'The platform did not return an access token', { outcome: 'not_created' });
    return { accessToken: json.access_token, refreshToken: json.refresh_token ?? previous?.refreshToken ?? null, scopes: String(json.scope ?? previous?.scopes.join(' ') ?? '').split(' ').filter(Boolean), expiresAt: json.expires_in ? new Date(Date.now() + Number(json.expires_in) * 1000) : null };
  }

  async exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string | null }): Promise<TokenSet> {
    const r = await this.http.ok('https://oauth2.googleapis.com/token', { method: 'POST', headers: FORM_HEADERS, body: form({ client_id: this.cfg.googleClientId, client_secret: this.cfg.googleClientSecret, code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri, code_verifier: p.codeVerifier ?? undefined }) }, mapGoogle);
    return this.tokens(r.json);
  }

  async refresh(t: TokenSet): Promise<TokenSet> {
    if (!t.refreshToken) throw new SocialApiError('auth', 'There is no refresh token; the account must be reconnected', { outcome: 'not_created' });
    const r = await this.http.ok('https://oauth2.googleapis.com/token', { method: 'POST', headers: FORM_HEADERS, body: form({ client_id: this.cfg.googleClientId, client_secret: this.cfg.googleClientSecret, grant_type: 'refresh_token', refresh_token: t.refreshToken }) }, mapGoogle);
    return this.tokens(r.json, t);
  }

  async inspectToken(t: TokenSet): Promise<TokenInspection> {
    const r = await this.http.request('https://oauth2.googleapis.com/tokeninfo', { query: { access_token: t.accessToken } });
    if (r.status !== 200) return { valid: false };
    return { valid: true, expiresAt: r.json?.exp ? new Date(Number(r.json.exp) * 1000) : null, scopes: String(r.json?.scope ?? '').split(' ').filter(Boolean) };
  }

  async revoke(t: TokenSet) {
    await this.http.request('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: FORM_HEADERS, body: form({ token: t.refreshToken ?? t.accessToken }) });
  }

  async listAccounts(t: TokenSet): Promise<CandidateAccount[]> {
    const r = await this.http.ok('https://www.googleapis.com/youtube/v3/channels', { query: { part: 'snippet', mine: 'true' }, headers: { authorization: `Bearer ${t.accessToken}` } }, mapGoogle);
    const missing = SCOPES.filter((s) => t.scopes.length > 0 && !t.scopes.includes(s));
    return ((r.json?.items ?? []) as Array<{ id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }>).map((c) => ({
      externalAccountId: c.id, displayName: c.snippet?.title ?? null, username: c.snippet?.customUrl ?? null, avatarUrl: c.snippet?.thumbnails?.default?.url ?? null, accountType: 'CHANNEL',
      tokens: t, scopesGranted: t.scopes, permissionsMissing: [...missing], metadata: {},
    }));
  }

  validate(c: PublishableContent): ValidationIssue[] {
    const issues = validateAgainstLimits('YOUTUBE', c);
    if (c.kind === 'VIDEO' && c.surface === 'SHORT') {
      const m = c.media[0];
      if (m?.width && m?.height && m.height < m.width) issues.push({ code: 'MEDIA_INVALID', message: 'A YouTube Short must be vertical or square.' });
    }
    return issues;
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    const media = c.media[0]!;
    const bytes = await media.read();
    const auth = { authorization: `Bearer ${a.tokens.accessToken}` };
    let session = ctx.resume?.stage === 'SESSION' ? ctx.resume.ref : null;
    if (session) {
      // A previous attempt may have uploaded the video before the process died: ask the platform instead of uploading again.
      const probe = await this.http.request(session, { method: 'PUT', headers: { ...auth, 'content-range': `bytes */${bytes.length}`, 'content-length': '0' } });
      if (probe.status === 200 || probe.status === 201) return this.done(probe.json, c);
      if (probe.status !== 308) session = null; // the session is gone: open a new one (nothing was uploaded)
    }
    if (!session) {
      const title = (c.title?.trim() || c.caption.trim().split('\n')[0] || 'Video').slice(0, 100);
      const isShort = c.surface === 'SHORT';
      const description = composeText(c) + (isShort && !/#shorts/i.test(c.caption + c.hashtags.join(' ')) ? '\n\n#Shorts' : '');
      const meta = { snippet: { title: isShort && !/#shorts/i.test(title) && title.length <= 92 ? `${title} #Shorts` : title, description: description.slice(0, PLATFORM_CAPABILITIES.YOUTUBE.captionMax), tags: c.hashtags.slice(0, 15), categoryId: '22' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } };
      const init = await this.http.ok('https://www.googleapis.com/upload/youtube/v3/videos', {
        method: 'POST', query: { uploadType: 'resumable', part: 'snippet,status' }, body: JSON.stringify(meta),
        headers: { ...auth, ...JSON_HEADERS, 'x-upload-content-type': media.mimeType, 'x-upload-content-length': String(bytes.length) },
      }, mapGoogle);
      const location = init.headers.get('location');
      if (!location) throw new SocialApiError('transient', 'YouTube did not open an upload session', { outcome: 'not_created' });
      session = location;
      await ctx.checkpoint('SESSION', session);
    }
    await ctx.beforeCreate();
    const up = await this.http.ok(session, { method: 'PUT', headers: { ...auth, 'content-type': media.mimeType, 'content-length': String(bytes.length) }, body: bytes }, mapGoogle);
    return this.done(up.json, c);
  }

  private done(json: Record<string, any> | null, c: PublishableContent): PublishOutcome { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = json?.id as string | undefined;
    if (!id) throw new SocialApiError('transient', 'YouTube did not return a video id', { outcome: 'unknown' });
    return { status: 'PUBLISHED', externalPostId: id, url: c.surface === 'SHORT' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`, raw: { privacyStatus: json?.status?.privacyStatus ?? null, uploadStatus: json?.status?.uploadStatus ?? null } };
  }

  async status(): Promise<StatusOutcome> {
    return { status: 'FAILED', code: 'PLATFORM_ERROR', message: 'YouTube uploads complete in a single step.' };
  }

  async fetchMetrics(a: AuthorizedAccount, videoId: string): Promise<Metrics> {
    try {
      const r = await this.http.ok('https://www.googleapis.com/youtube/v3/videos', { query: { part: 'statistics', id: videoId }, headers: { authorization: `Bearer ${a.tokens.accessToken}` } }, mapGoogle);
      const s = (r.json?.items?.[0]?.statistics ?? null) as Record<string, string> | null;
      if (!s) return { ...EMPTY_METRICS, unavailableReason: 'The platform returned no statistics for this video.' };
      // Counts are strings; a hidden count (for example likes) is absent, which is "unavailable", not zero.
      const num = (v: string | undefined) => (v === undefined ? null : Number(v));
      return { ...EMPTY_METRICS, views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), raw: s, unavailableReason: 'Reach, impressions and shares need the YouTube Analytics API, which TOUMA does not use yet.' };
    } catch (e) {
      return { ...EMPTY_METRICS, unavailableReason: e instanceof SocialApiError ? `${e.kind}: ${e.message}` : 'unavailable' };
    }
  }
}
