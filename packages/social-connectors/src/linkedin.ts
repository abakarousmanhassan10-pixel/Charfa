import { Http, FORM_HEADERS, JSON_HEADERS, form, redact, type FetchLike, type HttpResult } from './http';
import { composeText, validateAgainstLimits } from './validate';
import {
  EMPTY_METRICS, SocialApiError, type AdapterConfig, type AuthorizedAccount, type CandidateAccount, type Metrics, type OAuthStart, type PlatformAdapter, type PublishableContent, type PublishContext,
  type PublishOutcome, type StatusOutcome, type TokenSet,
} from './types';

const API = 'https://api.linkedin.com';
const PERSONAL_SCOPES = ['openid', 'profile', 'w_member_social'] as const;
const ORG_SCOPES = ['w_organization_social', 'r_organization_social', 'rw_organization_admin'] as const;

function mapLinkedIn(r: HttpResult): SocialApiError {
  const msg = redact(String(r.json?.message ?? r.json?.error_description ?? r.text));
  const code = r.json?.code ?? r.json?.error;
  if (r.status === 401) return new SocialApiError('auth', `The access token is no longer valid: ${msg}`, { status: 401, code, outcome: 'not_created' });
  if (r.status === 403) return new SocialApiError('permission', `A required permission is missing (LinkedIn products and scopes must be approved): ${msg}`, { status: 403, code, outcome: 'not_created' });
  if (r.status === 429) return new SocialApiError('rate_limit', `The platform is rate limiting requests: ${msg}`, { status: 429, code, outcome: 'not_created', retryAfterMs: 3_600_000 });
  if (r.status >= 500) return new SocialApiError('transient', `The platform had a temporary problem: ${msg}`, { status: r.status, code, outcome: 'unknown' });
  return new SocialApiError('validation', `The platform rejected the request: ${msg}`, { status: r.status, code, outcome: 'not_created' });
}

/** LinkedIn "little text" reserves these characters; they are escaped so the text is posted exactly as written. */
export function escapeLinkedIn(text: string) {
  return text.replace(/([\\|{}@[\]()<>#*_~])/g, '\\$1');
}

/**
 * LinkedIn Posts API. Posting as a person needs the "Share on LinkedIn" product (w_member_social). Posting as a Company Page
 * needs the Community Management API product, which LinkedIn approves per application. Refresh tokens are issued only to
 * approved partners; for other applications the person must reconnect when the (60-day) token expires.
 */
export class LinkedInPublisher implements PlatformAdapter {
  readonly platform = 'LINKEDIN' as const;
  readonly requiredScopes = [...PERSONAL_SCOPES, ...ORG_SCOPES] as readonly string[];
  readonly refreshLeadMs = 7 * 86_400_000;
  readonly supportsRefresh = true;
  private readonly http: Http;

  constructor(private readonly cfg: AdapterConfig, fetchImpl: FetchLike) {
    this.http = new Http(fetchImpl, cfg.timeoutMs);
  }

  missingConfiguration() {
    return [!this.cfg.linkedinClientId && 'LINKEDIN_CLIENT_ID', !this.cfg.linkedinClientSecret && 'LINKEDIN_CLIENT_SECRET'].filter(Boolean) as string[];
  }
  isConfigured() {
    return this.missingConfiguration().length === 0;
  }

  private rest(t: TokenSet, extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${t.accessToken}`, 'linkedin-version': this.cfg.linkedinApiVersion, 'x-restli-protocol-version': '2.0.0', ...extra };
  }

  buildAuthorizationUrl(p: { state: string; redirectUri: string }): OAuthStart {
    // The organization scopes are requested too; if the application has not been approved for them LinkedIn refuses the whole request,
    // so the scope list can be reduced to the personal scopes with LINKEDIN_ORG_SCOPES=false (see docs/SOCIAL-INTEGRATIONS.md).
    const scopes = this.cfg.linkedinOrgScopes === false ? [...PERSONAL_SCOPES] : [...PERSONAL_SCOPES, ...ORG_SCOPES];
    const q = new URLSearchParams({ response_type: 'code', client_id: this.cfg.linkedinClientId ?? '', redirect_uri: p.redirectUri, state: p.state, scope: scopes.join(' ') });
    return { url: `https://www.linkedin.com/oauth/v2/authorization?${q.toString()}` };
  }

  private tokens(json: Record<string, any> | null, previous?: TokenSet): TokenSet { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!json?.access_token) throw new SocialApiError('validation', 'The platform did not return an access token', { outcome: 'not_created' });
    return {
      accessToken: json.access_token, refreshToken: json.refresh_token ?? previous?.refreshToken ?? null, scopes: String(json.scope ?? previous?.scopes.join(',') ?? '').split(/[ ,]+/).filter(Boolean),
      expiresAt: json.expires_in ? new Date(Date.now() + Number(json.expires_in) * 1000) : null, refreshExpiresAt: json.refresh_token_expires_in ? new Date(Date.now() + Number(json.refresh_token_expires_in) * 1000) : null,
    };
  }

  async exchangeCode(p: { code: string; redirectUri: string }): Promise<TokenSet> {
    const r = await this.http.ok('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: FORM_HEADERS, body: form({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: this.cfg.linkedinClientId, client_secret: this.cfg.linkedinClientSecret }) }, mapLinkedIn);
    return this.tokens(r.json);
  }

  async refresh(t: TokenSet): Promise<TokenSet> {
    if (!t.refreshToken) throw new SocialApiError('unsupported', 'LinkedIn only issues refresh tokens to approved partners; the person must reconnect', { outcome: 'not_created' });
    const r = await this.http.ok('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', headers: FORM_HEADERS, body: form({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: this.cfg.linkedinClientId, client_secret: this.cfg.linkedinClientSecret }) }, mapLinkedIn);
    return this.tokens(r.json, t);
  }

  async listAccounts(t: TokenSet): Promise<CandidateAccount[]> {
    const out: CandidateAccount[] = [];
    const me = await this.http.ok(`${API}/v2/userinfo`, { headers: { authorization: `Bearer ${t.accessToken}` } }, mapLinkedIn);
    const u = (me.json ?? {}) as { sub?: string; name?: string; picture?: string };
    const granted = t.scopes;
    if (u.sub) {
      const missing = ['w_member_social'].filter((s) => granted.length > 0 && !granted.includes(s));
      out.push({ externalAccountId: `urn:li:person:${u.sub}`, displayName: u.name ?? null, avatarUrl: u.picture ?? null, accountType: 'PROFILE', tokens: t, scopesGranted: granted, permissionsMissing: missing, metadata: {} });
    }
    // Company Pages: only when the application was approved for the organization scopes.
    const orgs = await this.http.request(`${API}/rest/organizationAcls`, { query: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' }, headers: this.rest(t) });
    if (orgs.status === 200) {
      for (const el of (orgs.json?.elements ?? []) as Array<{ organization?: string }>) {
        const urn = el.organization;
        if (!urn) continue;
        const id = urn.split(':').pop()!;
        const detail = await this.http.request(`${API}/rest/organizations/${id}`, { headers: this.rest(t) });
        out.push({ externalAccountId: urn, displayName: (detail.json?.localizedName as string) ?? `Organization ${id}`, accountType: 'ORGANIZATION', tokens: t, scopesGranted: granted, permissionsMissing: ['w_organization_social'].filter((s) => granted.length > 0 && !granted.includes(s)), metadata: {} });
      }
    }
    return out;
  }

  validate(c: PublishableContent) {
    return validateAgainstLimits('LINKEDIN', c);
  }

  private text(c: PublishableContent) {
    const tags = c.hashtags.map((h) => `{hashtag|\\#|${h.replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '')}}`);
    return [escapeLinkedIn(c.caption.trim()), c.callToAction?.trim() && !c.caption.includes(c.callToAction.trim()) ? escapeLinkedIn(c.callToAction.trim()) : '', tags.join(' ')].filter(Boolean).join('\n\n');
  }

  private async uploadImage(a: AuthorizedAccount, bytes: Buffer, mime: string): Promise<string> {
    const init = await this.http.ok(`${API}/rest/images`, { method: 'POST', query: { action: 'initializeUpload' }, headers: this.rest(a.tokens, JSON_HEADERS), body: JSON.stringify({ initializeUploadRequest: { owner: a.externalAccountId } }) }, mapLinkedIn);
    const v = init.json?.value as { uploadUrl?: string; image?: string } | undefined;
    if (!v?.uploadUrl || !v.image) throw new SocialApiError('transient', 'LinkedIn did not return an upload URL', { outcome: 'not_created' });
    await this.http.ok(v.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${a.tokens.accessToken}`, 'content-type': mime }, body: bytes }, mapLinkedIn);
    return v.image;
  }

  private async uploadVideo(a: AuthorizedAccount, bytes: Buffer): Promise<string> {
    const init = await this.http.ok(`${API}/rest/videos`, { method: 'POST', query: { action: 'initializeUpload' }, headers: this.rest(a.tokens, JSON_HEADERS), body: JSON.stringify({ initializeUploadRequest: { owner: a.externalAccountId, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } }) }, mapLinkedIn);
    const v = init.json?.value as { video?: string; uploadToken?: string; uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }> } | undefined;
    if (!v?.video || !v.uploadInstructions?.length) throw new SocialApiError('transient', 'LinkedIn did not return upload instructions', { outcome: 'not_created' });
    const etags: string[] = [];
    for (const part of v.uploadInstructions) {
      const r = await this.http.ok(part.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${a.tokens.accessToken}`, 'content-type': 'application/octet-stream' }, body: bytes.subarray(part.firstByte, part.lastByte + 1) }, mapLinkedIn);
      etags.push(r.headers.get('etag') ?? '');
    }
    await this.http.ok(`${API}/rest/videos`, { method: 'POST', query: { action: 'finalizeUpload' }, headers: this.rest(a.tokens, JSON_HEADERS), body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? '', uploadedPartIds: etags } }) }, mapLinkedIn);
    return v.video;
  }

  async publish(a: AuthorizedAccount, c: PublishableContent, ctx: PublishContext): Promise<PublishOutcome> {
    const post: Record<string, unknown> = {
      author: a.externalAccountId, commentary: this.text(c), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    };
    // Uploads are safe to repeat (they only stage media); the post itself is created once, after beforeCreate().
    if (c.kind === 'IMAGE') {
      const m = c.media[0]!;
      post.content = { media: { id: await this.uploadImage(a, await m.read(), m.mimeType), altText: m.altText ?? undefined } };
    } else if (c.kind === 'CAROUSEL') {
      const images: Array<{ id: string; altText?: string }> = [];
      for (const m of c.media) images.push({ id: await this.uploadImage(a, await m.read(), m.mimeType), altText: m.altText ?? undefined });
      post.content = { multiImage: { images } };
    } else if (c.kind === 'VIDEO') {
      post.content = { media: { id: await this.uploadVideo(a, await c.media[0]!.read()), title: c.title ?? undefined } };
    }
    await ctx.beforeCreate();
    const r = await this.http.ok(`${API}/rest/posts`, { method: 'POST', headers: this.rest(a.tokens, JSON_HEADERS), body: JSON.stringify(post) }, mapLinkedIn);
    const urn = r.headers.get('x-restli-id') ?? (r.json?.id as string | undefined);
    if (!urn) throw new SocialApiError('transient', 'LinkedIn did not return the post id', { outcome: 'unknown' });
    return { status: 'PUBLISHED', externalPostId: urn, url: `https://www.linkedin.com/feed/update/${urn}` };
  }

  async status(): Promise<StatusOutcome> {
    return { status: 'FAILED', code: 'PLATFORM_ERROR', message: 'LinkedIn posts are created in a single step.' };
  }

  async fetchMetrics(a: AuthorizedAccount, postUrn: string): Promise<Metrics> {
    try {
      const r = await this.http.ok(`${API}/rest/socialActions/${encodeURIComponent(postUrn)}`, { headers: this.rest(a.tokens) }, mapLinkedIn);
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return { ...EMPTY_METRICS, likes: num(r.json?.likesSummary?.totalLikes), comments: num(r.json?.commentsSummary?.totalFirstLevelComments), raw: r.json, unavailableReason: 'Impressions, reach and shares need LinkedIn analytics permissions that only approved partners receive.' };
    } catch (e) {
      return { ...EMPTY_METRICS, unavailableReason: e instanceof SocialApiError ? `${e.kind}: ${e.message}` : 'unavailable' };
    }
  }
}
