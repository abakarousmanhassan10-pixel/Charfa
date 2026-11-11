import { createAdapters } from './registry';
import { escapeLinkedIn } from './linkedin';
import { redact, type FetchLike } from './http';
import type { SocialApiError } from './types';
import { type AuthorizedAccount, type MediaItem, type PublishableContent, type PublishContext } from './types';

/** A scripted network: requests are matched by "METHOD url-substring" in order, and recorded. */
type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
function net(routes: Array<[string, Reply | ((req: { url: string; method: string; body?: unknown; headers: Record<string, string> }) => Reply)]>) {
  const requests: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }> = [];
  const queue = [...routes];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const req = { method, url, body: init?.body, headers: init?.headers ?? {} };
    requests.push(req);
    const i = queue.findIndex(([m]) => { const [mm, ...rest] = m.split(' '); return mm === method && url.includes(rest.join(' ')); });
    if (i < 0) throw new Error(`unexpected request: ${method} ${url}`);
    const [, r] = queue.splice(i, 1)[0]!;
    const reply = typeof r === 'function' ? r(req) : r;
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => text };
  };
  return { fetchImpl, requests };
}

const cfg = { metaAppId: 'app-1', metaAppSecret: 'secret-1', metaGraphVersion: 'v21.0', tiktokClientKey: 'tk', tiktokClientSecret: 'tks', googleClientId: 'g', googleClientSecret: 'gs', linkedinClientId: 'li', linkedinClientSecret: 'lis', linkedinApiVersion: '202411' };
const adapters = (fetchImpl: FetchLike) => createAdapters(cfg, fetchImpl);
const media = (o: Partial<MediaItem> = {}): MediaItem => ({ id: 'm1', url: 'https://api.example.com/media/m1', mimeType: 'image/jpeg', sizeBytes: 1000, read: async () => Buffer.from('bytes'), ...o });
const content = (o: Partial<PublishableContent> = {}): PublishableContent => ({ kind: 'IMAGE', surface: 'FEED', caption: 'Fresh bissap', hashtags: ['bissap'], media: [media()], ...o });
const account = (o: Partial<AuthorizedAccount> = {}): AuthorizedAccount => ({ externalAccountId: 'acc-1', accountType: 'PAGE', tokens: { accessToken: 'SECRET-TOKEN', scopes: [] }, ...o });
function ctx(o: Partial<PublishContext> = {}) {
  const log: string[] = [];
  const c: PublishContext = { idempotencyKey: 'key-1', resume: null, checkpoint: async (s, r) => { log.push(`checkpoint:${s}:${r}`); }, beforeCreate: async () => { log.push('beforeCreate'); }, ...o };
  return { c, log };
}
const body = (r?: { body?: unknown }) => new URLSearchParams(String(r?.body));

describe('validation (shared limits)', () => {
  const a = adapters(net([]).fetchImpl);
  it('sends text-only posts to manual publishing where the API cannot publish them', () => {
    for (const p of ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const) {
      const issues = a[p].validate(content({ kind: 'TEXT', media: [] }));
      expect(issues.some((i) => i.manual)).toBe(true);
    }
    expect(a.FACEBOOK.validate(content({ kind: 'TEXT', media: [] }))).toEqual([]);
    expect(a.LINKEDIN.validate(content({ kind: 'TEXT', media: [] }))).toEqual([]);
  });
  it('checks media types, sizes, counts and durations per platform', () => {
    expect(a.INSTAGRAM.validate(content({ media: [media({ mimeType: 'image/png' })] })).map((i) => i.message).join()).toMatch(/image types/);
    expect(a.INSTAGRAM.validate(content({ kind: 'CAROUSEL', media: [media()] })).map((i) => i.message).join()).toMatch(/needs 2 to 10/);
    expect(a.INSTAGRAM.validate(content({ kind: 'IMAGE', media: [media({ sizeBytes: 9 * 1048576 })] })).map((i) => i.message).join()).toMatch(/larger than 8 MB/);
    const video = media({ mimeType: 'video/mp4', durationSeconds: 90, width: 1080, height: 1920 });
    expect(a.YOUTUBE.validate(content({ kind: 'VIDEO', surface: 'SHORT', media: [video] })).map((i) => i.message).join()).toMatch(/not last more than 60 s/);
    expect(a.YOUTUBE.validate(content({ kind: 'VIDEO', surface: 'SHORT', media: [{ ...video, durationSeconds: 30, width: 1920, height: 1080 }] })).map((i) => i.message).join()).toMatch(/vertical or square/);
    expect(a.YOUTUBE.validate(content({ kind: 'VIDEO', surface: 'FEED', media: [video] }))).toEqual([]);
    expect(a.FACEBOOK.validate(content({ kind: 'VIDEO', surface: 'REEL', media: [video] })).some((i) => i.manual)).toBe(true); // Facebook Reels: manual
    expect(a.INSTAGRAM.validate(content({ caption: 'x'.repeat(2300) })).map((i) => i.message).join()).toMatch(/2200/);
    expect(a.FACEBOOK.validate(content({ kind: 'TEXT', caption: '', media: [] })).length).toBeGreaterThan(0);
  });
});

describe('Meta adapters', () => {
  it('builds the OAuth URL with the required permissions and asks again when reconnecting', () => {
    const a = adapters(net([]).fetchImpl);
    const u = new URL(a.FACEBOOK.buildAuthorizationUrl({ state: 'st', redirectUri: 'https://api.example.com/cb' }).url);
    expect(u.host).toBe('www.facebook.com');
    expect(u.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('auth_type')).toBeNull();
    expect(new URL(a.INSTAGRAM.buildAuthorizationUrl({ state: 's', redirectUri: 'x', reconnect: true }).url).searchParams.get('auth_type')).toBe('rerequest');
    expect(new URL(a.INSTAGRAM.buildAuthorizationUrl({ state: 's', redirectUri: 'x' }).url).searchParams.get('scope')).toContain('instagram_content_publish');
  });

  it('exchanges the code for a long-lived token and lists pages with their Instagram accounts and missing permissions', async () => {
    const n = net([
      ['GET /oauth/access_token', { json: { access_token: 'short' } }],
      ['GET /oauth/access_token', { json: { access_token: 'long', expires_in: 5_184_000 } }],
      ['GET /me/permissions', { json: { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'declined' }] } }],
      ['GET /me/accounts', { json: { data: [
        { id: 'p1', name: 'Maquis', access_token: 'page-token-1', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: 'ig1', username: 'maquis' } },
        { id: 'p2', name: 'Viewer only', access_token: 'page-token-2', tasks: ['ANALYZE'] },
      ] } }],
    ]);
    const a = adapters(n.fetchImpl);
    const t = await a.FACEBOOK.exchangeCode({ code: 'c', redirectUri: 'https://api.example.com/cb' });
    expect(t.accessToken).toBe('long');
    expect(t.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 86_400_000);
    expect(n.requests[1]!.url).toContain('fb_exchange_token');
    const list = await a.FACEBOOK.listAccounts(t);
    expect(list.map((x) => x.externalAccountId)).toEqual(['p1', 'p2']);
    expect(list[0]!.tokens.accessToken).toBe('page-token-1'); // the Page token, not the user token
    expect(list[0]!.tokens.expiresAt).toBeNull();
    expect(list[0]!.permissionsMissing).toEqual(expect.arrayContaining(['pages_manage_posts', 'read_insights']));
    expect(list[1]!.permissionsMissing).toContain('CREATE_CONTENT (page task)');
    const n2 = net([
      ['GET /me/permissions', { json: { data: [] } }],
      ['GET /me/accounts', { json: { data: [{ id: 'p1', name: 'Maquis', access_token: 'pt', instagram_business_account: { id: 'ig1', username: 'maquis' } }, { id: 'p2', access_token: 'pt2' }] } }],
    ]);
    const ig = await adapters(n2.fetchImpl).INSTAGRAM.listAccounts({ accessToken: 'u', scopes: [] });
    expect(ig).toHaveLength(1);
    expect(ig[0]).toMatchObject({ externalAccountId: 'ig1', accountType: 'INSTAGRAM_BUSINESS', parentExternalId: 'p1' });
  });

  it('publishes to a Facebook Page: text, photo, multi-photo and video, and never reports success without an id', async () => {
    const n = net([
      ['POST /acc-1/feed', { json: { id: 'acc-1_100' } }],
      ['POST /acc-1/photos', { json: { id: 'ph1', post_id: 'acc-1_200' } }],
      ['POST /acc-1/photos', { json: { id: 'u1' } }], ['POST /acc-1/photos', { json: { id: 'u2' } }], ['POST /acc-1/feed', { json: { id: 'acc-1_300' } }],
      ['POST /acc-1/videos', { json: { id: 'vid1' } }],
      ['GET /vid1', { json: { status: { video_status: 'processing' } } }],
      ['GET /vid1', { json: { status: { video_status: 'ready' }, permalink_url: '/acc-1/videos/vid1' } }],
    ]);
    const fb = adapters(n.fetchImpl).FACEBOOK;
    const { c, log } = ctx();
    expect(await fb.publish(account(), content({ kind: 'TEXT', media: [] }), c)).toMatchObject({ status: 'PUBLISHED', externalPostId: 'acc-1_100', url: 'https://www.facebook.com/acc-1_100' });
    expect(log).toEqual(['beforeCreate']);
    expect(body(n.requests[0]).get('message')).toBe('Fresh bissap\n\n#bissap');
    expect(body(n.requests[0]).get('access_token')).toBe('SECRET-TOKEN');
    expect(await fb.publish(account(), content(), ctx().c)).toMatchObject({ externalPostId: 'acc-1_200' });
    const multi = ctx();
    expect(await fb.publish(account(), content({ kind: 'CAROUSEL', media: [media(), media({ id: 'm2' })] }), multi.c)).toMatchObject({ externalPostId: 'acc-1_300' });
    expect(multi.log).toEqual(['checkpoint:PHOTOS:["u1","u2"]', 'beforeCreate']);
    expect(JSON.parse(body(n.requests[4]).get('attached_media')!)).toEqual([{ media_fbid: 'u1' }, { media_fbid: 'u2' }]);
    const v = await fb.publish(account(), content({ kind: 'VIDEO', media: [media({ mimeType: 'video/mp4' })] }), ctx().c);
    expect(v).toMatchObject({ status: 'PROCESSING', ref: 'vid1' });
    expect(await fb.status(account(), 'vid1', 'VIDEO_ACCEPTED')).toMatchObject({ status: 'PROCESSING' });
    expect(await fb.status(account(), 'vid1', 'VIDEO_ACCEPTED')).toMatchObject({ status: 'PUBLISHED', url: 'https://www.facebook.com/acc-1/videos/vid1' });
  });

  it('publishes to Instagram through containers: checkpoint, wait for the video, publish once, resume without a second container', async () => {
    const n = net([
      ['GET /content_publishing_limit', { json: { data: [{ quota_usage: 3, config: { quota_total: 50 } }] } }],
      ['POST /acc-1/media', { json: { id: 'c1' } }],
      ['GET /c1', { json: { status_code: 'IN_PROGRESS' } }],
      ['GET /c1', { json: { status_code: 'FINISHED' } }],
      ['POST /acc-1/media_publish', { json: { id: 'media-9' } }],
      ['GET /media-9', { json: { permalink: 'https://www.instagram.com/reel/abc/' } }],
    ]);
    const ig = adapters(n.fetchImpl).INSTAGRAM;
    const first = ctx();
    const video = content({ kind: 'VIDEO', surface: 'REEL', media: [media({ mimeType: 'video/mp4', durationSeconds: 20 })] });
    const r1 = await ig.publish(account(), video, first.c);
    expect(r1).toMatchObject({ status: 'PROCESSING', ref: 'c1', stage: 'CONTAINER' });
    expect(first.log).toEqual(['checkpoint:CONTAINER:c1']); // nothing was published yet
    expect(body(n.requests[1]).get('media_type')).toBe('REELS');
    expect(body(n.requests[1]).get('video_url')).toBe('https://api.example.com/media/m1');
    // A retry resumes the same container.
    const second = ctx({ resume: { stage: 'CONTAINER', ref: 'c1' } });
    const r2 = await ig.publish(account(), video, second.c);
    expect(r2).toMatchObject({ status: 'PUBLISHED', externalPostId: 'media-9', url: 'https://www.instagram.com/reel/abc/' });
    expect(second.log).toEqual(['beforeCreate']);
    expect(n.requests.filter((r) => r.url.includes('/acc-1/media') && !r.url.includes('media_publish'))).toHaveLength(1); // one container only
  });

  it('publishes an Instagram carousel with child containers', async () => {
    const n = net([
      ['GET /content_publishing_limit', { json: { data: [{ quota_usage: 3, config: { quota_total: 50 } }] } }],
      ['POST /acc-1/media', { json: { id: 'k1' } }], ['POST /acc-1/media', { json: { id: 'k2' } }], ['POST /acc-1/media', { json: { id: 'parent' } }],
      ['GET /parent', { json: { status_code: 'FINISHED' } }], ['POST /acc-1/media_publish', { json: { id: 'media-5' } }], ['GET /media-5', { status: 400, json: { error: { message: 'x', code: 100 } } }],
    ]);
    const r = await adapters(n.fetchImpl).INSTAGRAM.publish(account(), content({ kind: 'CAROUSEL', media: [media(), media({ id: 'm2' })] }), ctx().c);
    expect(r).toMatchObject({ status: 'PUBLISHED', externalPostId: 'media-5', url: null }); // the post exists even though its link could not be read
    expect(body(n.requests[3]).get('children')).toBe('k1,k2');
    expect(body(n.requests[1]).get('is_carousel_item')).toBe('true');
  });

  it('Instagram: a full publishing quota is a retryable rate limit decided BEFORE any container is created; an unreadable quota does not block', async () => {
    const full = net([['GET /content_publishing_limit', { json: { data: [{ quota_usage: 50, config: { quota_total: 50 } }] } }]]);
    const { c, log } = ctx();
    await expect(adapters(full.fetchImpl).INSTAGRAM.publish(account(), content(), c)).rejects.toMatchObject({ kind: 'rate_limit', outcome: 'not_created', opts: expect.objectContaining({ retryAfterMs: 3_600_000 }) });
    expect(log).toEqual([]);
    expect(full.requests).toHaveLength(1);
    const unreadable = net([['GET /content_publishing_limit', { status: 500, json: {} }], ['POST /acc-1/media', { json: { id: 'c9' } }], ['GET /c9', { json: { status_code: 'IN_PROGRESS' } }]]);
    expect(await adapters(unreadable.fetchImpl).INSTAGRAM.publish(account(), content(), ctx().c)).toMatchObject({ status: 'PROCESSING', ref: 'c9' });
  });

  it('maps Meta quota and media errors to specific, actionable outcomes', async () => {
    const run = (error: object) => adapters(net([['POST /acc-1/feed', { status: 400, json: { error } }]]).fetchImpl).FACEBOOK.publish(account(), content({ kind: 'TEXT', media: [] }), ctx().c).catch((e) => e as SocialApiError);
    expect(await run({ message: 'limit', code: 9, error_subcode: 2207042 })).toMatchObject({ kind: 'rate_limit', outcome: 'not_created' });
    expect(await run({ message: 'BUC', code: 80002 })).toMatchObject({ kind: 'rate_limit' });
    expect(await run({ message: 'x', code: 100, error_subcode: 2207026 })).toMatchObject({ kind: 'validation', message: expect.stringContaining('H.264') });
    expect(await run({ message: 'expired', code: 190, error_subcode: 463 })).toMatchObject({ kind: 'auth' });
  });

  it('maps Graph errors, keeps tokens out of messages, and says whether a post may exist', async () => {
    const mk = (status: number, error: object) => adapters(net([['POST /acc-1/feed', { status, json: { error } }]]).fetchImpl).FACEBOOK.publish(account(), content({ kind: 'TEXT', media: [] }), ctx().c).catch((e) => e as SocialApiError);
    const expired = await mk(400, { code: 190, message: 'Error validating access token: SECRET-TOKEN expired' });
    expect(expired).toMatchObject({ kind: 'auth', outcome: 'not_created' });
    const denied = await mk(403, { code: 200, message: 'Requires pages_manage_posts permission' });
    expect(denied).toMatchObject({ kind: 'permission' });
    expect(await mk(400, { code: 4, message: 'rate' })).toMatchObject({ kind: 'rate_limit', outcome: 'not_created' });
    expect(await mk(500, { code: 2, message: 'temporary' })).toMatchObject({ kind: 'transient', outcome: 'unknown' });
    expect(await mk(400, { code: 100, message: 'Invalid parameter' })).toMatchObject({ kind: 'validation', outcome: 'not_created' });
    expect(String(((await mk(400, { code: 190, message: 'token=abc access_token=SECRET-TOKEN' })) as Error).message)).not.toContain('SECRET-TOKEN');
    const dropped = await adapters(async () => { throw new TypeError('socket hang up'); }).FACEBOOK.publish(account(), content({ kind: 'TEXT', media: [] }), ctx().c).catch((e) => e as SocialApiError);
    expect(dropped).toMatchObject({ kind: 'transient', outcome: 'unknown' });
  });

  it('reads metrics: zero is a value, missing is unavailable', async () => {
    const n = net([
      ['GET /p1/insights', { json: { data: [{ name: 'post_impressions', values: [{ value: 120 }] }, { name: 'post_impressions_unique', values: [{ value: 90 }] }] } }],
      ['GET /p1', { json: { reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 3 } } } }],
    ]);
    const m = await adapters(n.fetchImpl).FACEBOOK.fetchMetrics(account(), 'p1');
    expect(m).toMatchObject({ impressions: 120, reach: 90, likes: 0, comments: 3, shares: null, views: null, saves: null });
    const denied = await adapters(net([['GET /p1/insights', { status: 403, json: { error: { code: 10, message: 'no permission' } } }]]).fetchImpl).FACEBOOK.fetchMetrics(account(), 'p1');
    expect(Object.values({ ...denied, raw: undefined, unavailableReason: undefined })).toEqual(expect.not.arrayContaining([0]));
    expect(denied.likes).toBeNull();
    expect(denied.unavailableReason).toMatch(/permission/);
  });
});

const tkSettings = (o: Record<string, unknown> = {}) => ({ privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: false, allowDuet: false, allowStitch: false, commercial: { enabled: false, yourBrand: false, brandedContent: false }, consent: true, ...o }) as never;

describe('TikTok adapter', () => {
  it('builds the URL, exchanges and refreshes tokens', async () => {
    const n = net([
      ['POST /v2/oauth/token/', { json: { access_token: 'ta', refresh_token: 'tr', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish' } }],
      ['POST /v2/oauth/token/', { json: { access_token: 'ta2', refresh_token: 'tr2', expires_in: 86400, scope: 'user.info.basic,video.publish' } }],
      ['POST /v2/oauth/token/', { status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token is expired' } }],
    ]);
    const tk = adapters(n.fetchImpl).TIKTOK;
    expect(new URL(tk.buildAuthorizationUrl({ state: 'st', redirectUri: 'x' }).url).searchParams.get('client_key')).toBe('tk');
    const t = await tk.exchangeCode({ code: 'c', redirectUri: 'x' });
    expect(t).toMatchObject({ accessToken: 'ta', refreshToken: 'tr' });
    expect(body(n.requests[0]).get('grant_type')).toBe('authorization_code');
    const r = await tk.refresh(t);
    expect(r.accessToken).toBe('ta2');
    expect(body(n.requests[1]).get('grant_type')).toBe('refresh_token');
    await expect(tk.refresh(r)).rejects.toMatchObject({ kind: 'auth' });
    await expect(tk.refresh({ accessToken: 'a', scopes: [] })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('publishes a video by URL, then follows the status until the platform confirms', async () => {
    const n = net([
      ['POST /creator_info/query/', { json: { data: { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } } }],
      ['POST /video/init/', { json: { data: { publish_id: 'pub1' }, error: { code: 'ok' } } }],
      ['POST /status/fetch/', { json: { data: { status: 'PROCESSING_DOWNLOAD' } } }],
      ['POST /status/fetch/', { json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] } } }],
    ]);
    const tk = adapters(n.fetchImpl).TIKTOK;
    const { c, log } = ctx();
    const r = await tk.publish(account({ accountType: 'CREATOR' }), content({ kind: 'VIDEO', tiktok: tkSettings({ allowComment: true }), media: [media({ mimeType: 'video/mp4', durationSeconds: 15 })] }), c);
    expect(r).toMatchObject({ status: 'PROCESSING', ref: 'pub1' });
    expect(log).toEqual(['beforeCreate', 'checkpoint:PUBLISH_INIT:pub1']);
    const sent = JSON.parse(String(n.requests[1]!.body));
    expect(sent.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: 'https://api.example.com/media/m1' });
    expect(sent.post_info).toMatchObject({ privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false });
    expect(await tk.status(account(), 'pub1', 'PUBLISH_INIT')).toMatchObject({ status: 'PROCESSING' });
    expect(await tk.status(account(), 'pub1', 'PUBLISH_INIT')).toMatchObject({ status: 'PUBLISHED', externalPostId: '7123' });
  });

  it('is limited to private posts when the app is unaudited, reports platform failures, and does not re-init on resume', async () => {
    const n = net([
      ['POST /creator_info/query/', { json: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } }],
      ['POST /content/init/', { json: { data: { publish_id: 'p2' }, error: { code: 'ok' } } }],
      ['POST /status/fetch/', { json: { data: { status: 'FAILED', fail_reason: 'file_format_check_failed' } } }],
    ]);
    const tk = adapters(n.fetchImpl).TIKTOK;
    await tk.publish(account(), content({ kind: 'CAROUSEL', tiktok: tkSettings({ privacyLevel: 'SELF_ONLY' }), media: [media(), media({ id: 'm2' })] }), ctx().c);
    const sent = JSON.parse(String(n.requests[1]!.body));
    expect(sent.post_info.privacy_level).toBe('SELF_ONLY');
    expect(sent.media_type).toBe('PHOTO');
    expect(sent.post_info.disable_comment).toBe(true);
    expect(sent.source_info.photo_images).toHaveLength(2);
    expect(await tk.status(account(), 'p2', 'PUBLISH_INIT')).toMatchObject({ status: 'FAILED', code: 'PLATFORM_REJECTED' });
    const resumed = await tk.publish(account(), content(), ctx({ resume: { stage: 'PUBLISH_INIT', ref: 'p2' } }).c);
    expect(resumed).toMatchObject({ status: 'PROCESSING', ref: 'p2' });
    expect(n.requests).toHaveLength(3); // no new init request
  });

  describe('TikTok posting rules (Content Sharing Guidelines)', () => {
    const info = (o: Record<string, unknown> = {}) => ['POST /creator_info/query/', { json: { error: { code: 'ok' }, data: { creator_nickname: 'Awa', creator_username: 'awa_maquis', creator_avatar_url: 'https://a/p.png', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 300, ...o } } }] as [string, Reply];
    const vid = (t: Record<string, unknown> = {}) => content({ kind: 'VIDEO', tiktok: tkSettings(t), media: [media({ mimeType: 'video/mp4', durationSeconds: 20, width: 1080, height: 1920, videoCodec: 'avc1' })] });

    it('reads the creator info to show: nickname, options, disabled interactions, maximum duration', async () => {
      const n = net([info({ comment_disabled: true })]);
      expect(await adapters(n.fetchImpl).TIKTOK.creatorInfo!(account())).toEqual({ nickname: 'Awa', username: 'awa_maquis', avatarUrl: 'https://a/p.png', privacyOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], commentDisabled: true, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 300 });
    });

    it('refuses to send anything when the person has not chosen privacy, confirmed, or completed the disclosure', () => {
      const tk = adapters(net([]).fetchImpl).TIKTOK;
      const msgs = (c: PublishableContent) => tk.validate(c).map((i) => i.message).join(' | ');
      expect(msgs(content({ kind: 'VIDEO', media: [media({ mimeType: 'video/mp4', durationSeconds: 20 })] }))).toMatch(/Choose who can view/);
      expect(msgs(vid({ privacyLevel: undefined }))).toMatch(/Choose who can view/);
      expect(msgs(vid({ consent: false }))).toMatch(/Music Usage Confirmation/);
      expect(msgs(vid({ commercial: { enabled: true, yourBrand: false, brandedContent: false } }))).toMatch(/select "Your brand"/);
      expect(msgs(vid({ privacyLevel: 'SELF_ONLY', commercial: { enabled: true, yourBrand: false, brandedContent: true } }))).toMatch(/Branded content visibility cannot be set to private/);
      expect(msgs(content({ kind: 'IMAGE', tiktok: tkSettings({ allowDuet: true }), media: [media()] }))).toMatch(/Duet and Stitch exist for videos only/);
      expect(msgs(vid({ commercial: { enabled: true, yourBrand: true, brandedContent: false } }))).toBe('');
    });

    it('sends exactly what the person chose, including the commercial disclosure, and never forces a privacy default', async () => {
      const n = net([info(), ['POST /video/init/', { json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } }]]);
      await adapters(n.fetchImpl).TIKTOK.publish(account(), vid({ privacyLevel: 'SELF_ONLY', allowComment: true, allowDuet: true, commercial: { enabled: true, yourBrand: true, brandedContent: false } }), ctx().c);
      expect(JSON.parse(String(n.requests[1]!.body)).post_info).toMatchObject({ privacy_level: 'SELF_ONLY', disable_comment: false, disable_duet: false, disable_stitch: true, brand_organic_toggle: true, brand_content_toggle: false });
    });

    it('keeps interactions off that the creator disabled in TikTok, even if they were chosen earlier', async () => {
      const n = net([info({ comment_disabled: true, duet_disabled: true }), ['POST /video/init/', { json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } }]]);
      await adapters(n.fetchImpl).TIKTOK.publish(account(), vid({ allowComment: true, allowDuet: true, allowStitch: true }), ctx().c);
      expect(JSON.parse(String(n.requests[1]!.body)).post_info).toMatchObject({ disable_comment: true, disable_duet: true, disable_stitch: false });
    });

    it('does not post when the chosen visibility is no longer offered (for example the app is still unaudited), and says what to do', async () => {
      const n = net([info({ privacy_level_options: ['SELF_ONLY'] })]);
      const { c, log } = ctx();
      await expect(adapters(n.fetchImpl).TIKTOK.publish(account(), vid({ privacyLevel: 'PUBLIC_TO_EVERYONE' }), c)).rejects.toMatchObject({ kind: 'validation', outcome: 'not_created', message: expect.stringContaining('choose the visibility again') });
      expect(log).toEqual([]);
      expect(n.requests).toHaveLength(1); // only the creator query: nothing was created
    });

    it('does not post a video longer than the creator may post', async () => {
      const n = net([info({ max_video_post_duration_sec: 10 })]);
      await expect(adapters(n.fetchImpl).TIKTOK.publish(account(), vid(), ctx().c)).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('at most 10 s') });
    });
  });
});

describe('YouTube adapter', () => {
  const video = (o: Partial<MediaItem> = {}) => media({ mimeType: 'video/mp4', sizeBytes: 5, durationSeconds: 30, width: 1080, height: 1920, ...o });
  it('uses PKCE, offline access and consent, and refreshes keeping the refresh token', async () => {
    const n = net([
      ['POST oauth2.googleapis.com/token', { json: { access_token: 'ya', refresh_token: 'yr', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.upload' } }],
      ['POST oauth2.googleapis.com/token', { json: { access_token: 'ya2', expires_in: 3600 } }],
    ]);
    const yt = adapters(n.fetchImpl).YOUTUBE;
    const start = yt.buildAuthorizationUrl({ state: 'st', redirectUri: 'x' });
    const u = new URL(start.url);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.codeVerifier).toBeTruthy();
    const t = await yt.exchangeCode({ code: 'c', redirectUri: 'x', codeVerifier: start.codeVerifier });
    expect(body(n.requests[0]).get('code_verifier')).toBe(start.codeVerifier);
    const r = await yt.refresh(t);
    expect(r).toMatchObject({ accessToken: 'ya2', refreshToken: 'yr' });
  });

  it('uploads with a resumable session, checkpoints it, and a Short gets the Shorts marker and URL', async () => {
    const n = net([
      ['POST upload/youtube/v3/videos', { headers: { location: 'https://upload.example/session-1' } }],
      ['PUT https://upload.example/session-1', { status: 200, json: { id: 'yt1', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } } }],
    ]);
    const { c, log } = ctx();
    const r = await adapters(n.fetchImpl).YOUTUBE.publish(account({ accountType: 'CHANNEL' }), content({ kind: 'VIDEO', surface: 'SHORT', title: 'Bissap', media: [video()] }), c);
    expect(r).toMatchObject({ status: 'PUBLISHED', externalPostId: 'yt1', url: 'https://www.youtube.com/shorts/yt1', raw: { privacyStatus: 'private' } });
    expect(log).toEqual(['checkpoint:SESSION:https://upload.example/session-1', 'beforeCreate']);
    const meta = JSON.parse(String(n.requests[0]!.body));
    expect(meta.snippet.title).toBe('Bissap #Shorts');
    expect(meta.snippet.description).toContain('#Shorts');
    expect(n.requests[0]!.headers['x-upload-content-length']).toBe('5');
  });

  it('asks the platform before uploading again after a crash, so a finished upload is never repeated', async () => {
    const done = net([['PUT https://upload.example/session-1', { status: 200, json: { id: 'yt-existing' } }]]);
    const r = await adapters(done.fetchImpl).YOUTUBE.publish(account(), content({ kind: 'VIDEO', media: [video()] }), ctx({ resume: { stage: 'SESSION', ref: 'https://upload.example/session-1' } }).c);
    expect(r).toMatchObject({ status: 'PUBLISHED', externalPostId: 'yt-existing' });
    expect(done.requests).toHaveLength(1);
    expect(done.requests[0]!.headers['content-range']).toBe('bytes */5');
    const partial = net([['PUT https://upload.example/session-1', { status: 308 }], ['PUT https://upload.example/session-1', { status: 200, json: { id: 'yt2' } }]]);
    const r2 = await adapters(partial.fetchImpl).YOUTUBE.publish(account(), content({ kind: 'VIDEO', media: [video()] }), ctx({ resume: { stage: 'SESSION', ref: 'https://upload.example/session-1' } }).c);
    expect(r2).toMatchObject({ externalPostId: 'yt2' });
    expect(partial.requests).toHaveLength(2); // status probe, then the upload
  });

  it('maps quota and permission errors and reads statistics (hidden counts are unavailable, zero is zero)', async () => {
    const quota = await adapters(net([['POST upload/youtube/v3/videos', { status: 403, json: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } }]]).fetchImpl).YOUTUBE.publish(account(), content({ kind: 'VIDEO', media: [video()] }), ctx().c).catch((e) => e as SocialApiError);
    expect(quota).toMatchObject({ kind: 'rate_limit', outcome: 'not_created' });
    const m = await adapters(net([['GET /youtube/v3/videos', { json: { items: [{ statistics: { viewCount: '0', commentCount: '4' } }] } }]]).fetchImpl).YOUTUBE.fetchMetrics(account(), 'yt1');
    expect(m).toMatchObject({ views: 0, comments: 4, likes: null, shares: null, reach: null });
  });
});

describe('LinkedIn adapter', () => {
  it('escapes reserved characters so text is posted exactly as written', () => {
    expect(escapeLinkedIn('50% (new) #tag @you [x] *bold* a_b')).toBe('50% \\(new\\) \\#tag \\@you \\[x\\] \\*bold\\* a\\_b');
  });
  describe('personal and organization connections are separate', () => {
    const orgCfg = { ...cfg, linkedinOrgEnabled: true, linkedinOrgClientId: 'org-app', linkedinOrgClientSecret: 'org-secret' };
    const li = (fetchImpl: FetchLike, c: Record<string, unknown> = {}) => createAdapters({ ...cfg, ...c } as typeof cfg, fetchImpl).LINKEDIN;

    it('lists variants: personal on, organization OFF by default with the reason and what unlocks it', () => {
      const v = li(net([]).fetchImpl).variants!();
      expect(v.find((x) => x.id === 'personal')).toMatchObject({ enabled: true, configured: true, accountType: 'PROFILE', scopes: ['openid', 'profile', 'w_member_social'] });
      const org = v.find((x) => x.id === 'organization')!;
      expect(org).toMatchObject({ enabled: false, accountType: 'ORGANIZATION' });
      expect(org.reason).toMatch(/Community Management API.*LINKEDIN_ORG_ENABLED=true.*LINKEDIN_ORG_APPROVAL_REF/);
      expect(org.scopes).toContain('w_organization_social');
    });

    it('personal authorization asks for personal scopes only (never organization scopes), with the personal application', () => {
      const u = new URL(li(net([]).fetchImpl, orgCfg).buildAuthorizationUrl({ state: 's', redirectUri: 'x' }).url);
      expect(u.searchParams.get('client_id')).toBe('li');
      expect(u.searchParams.get('scope')).toBe('openid profile w_member_social');
    });

    it('organization authorization is refused while disabled, and uses its own scopes and application once enabled', () => {
      expect(() => li(net([]).fetchImpl).buildAuthorizationUrl({ state: 's', redirectUri: 'x', variant: 'organization' })).toThrow(/disabled until LinkedIn approves/);
      const u = new URL(li(net([]).fetchImpl, orgCfg).buildAuthorizationUrl({ state: 's', redirectUri: 'x', variant: 'organization' }).url);
      expect(u.searchParams.get('client_id')).toBe('org-app');
      expect(u.searchParams.get('scope')).toBe('w_organization_social r_organization_social rw_organization_admin');
    });

    it('exchanges and refreshes with the application that issued the token', async () => {
      const n = net([
        ['POST /oauth/v2/accessToken', { json: { access_token: 'a', refresh_token: 'r', expires_in: 100, scope: 'w_organization_social' } }],
        ['POST /oauth/v2/accessToken', { json: { access_token: 'a2', refresh_token: 'r2', expires_in: 100, scope: 'w_organization_social' } }],
        ['POST /oauth/v2/accessToken', { json: { access_token: 'p', refresh_token: 'pr', expires_in: 100, scope: 'w_member_social' } }],
        ['POST /oauth/v2/accessToken', { json: { access_token: 'p2', expires_in: 100, scope: 'w_member_social' } }],
      ]);
      const a = li(n.fetchImpl, orgCfg);
      const t = await a.exchangeCode({ code: 'c', redirectUri: 'x', variant: 'organization' });
      await a.refresh(t);
      const pt = await a.exchangeCode({ code: 'c', redirectUri: 'x' });
      await a.refresh(pt);
      expect(n.requests.map((r) => body(r).get('client_id'))).toEqual(['org-app', 'org-app', 'li', 'li']);
      await expect(li(net([]).fetchImpl).exchangeCode({ code: 'c', redirectUri: 'x', variant: 'organization' })).rejects.toMatchObject({ kind: 'unsupported' });
    });

    it('a personal connection lists only the profile and never asks LinkedIn about organizations', async () => {
      const n = net([['GET /v2/userinfo', { json: { sub: 'abc', name: 'Awa M' } }]]);
      const list = await li(n.fetchImpl, orgCfg).listAccounts({ accessToken: 't', scopes: ['w_member_social'] });
      expect(list.map((a) => [a.externalAccountId, a.accountType])).toEqual([['urn:li:person:abc', 'PROFILE']]);
      expect(n.requests).toHaveLength(1);
    });

    it('an organization connection lists the Company Pages the member administers; a LinkedIn refusal is an error, not "no pages"', async () => {
      const n = net([['GET /rest/organizationAcls', { json: { elements: [{ organization: 'urn:li:organization:55' }] } }], ['GET /rest/organizations/55', { json: { localizedName: 'Maquis Awa' } }]]);
      const list = await li(n.fetchImpl, orgCfg).listAccounts({ accessToken: 't', scopes: ['w_organization_social'] }, { variant: 'organization' });
      expect(list.map((a) => [a.externalAccountId, a.accountType, a.permissionsMissing])).toEqual([['urn:li:organization:55', 'ORGANIZATION', []]]);
      expect(n.requests[0]!.headers['linkedin-version']).toBe('202411');
      await expect(li(net([['GET /rest/organizationAcls', { status: 403, json: {} }]]).fetchImpl, orgCfg).listAccounts({ accessToken: 't', scopes: [] }, { variant: 'organization' })).rejects.toMatchObject({ kind: 'permission' });
      await expect(li(net([]).fetchImpl).listAccounts({ accessToken: 't', scopes: [] }, { variant: 'organization' })).rejects.toMatchObject({ kind: 'unsupported' });
    });

    it('never publishes to an organization while organization publishing is disabled, even for a stored organization account', async () => {
      const n = net([]);
      await expect(li(n.fetchImpl).publish(account({ accountType: 'ORGANIZATION', externalAccountId: 'urn:li:organization:55' }), content({ kind: 'TEXT', media: [] }), ctx().c)).rejects.toMatchObject({ kind: 'unsupported', outcome: 'not_created' });
      expect(n.requests).toHaveLength(0);
    });
  });
  it('publishes text, an image after upload, and a video in parts; the post id comes from the response header', async () => {
    const n = net([
      ['POST /rest/posts', { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }],
      ['POST /rest/images', { json: { value: { uploadUrl: 'https://upload.linkedin.test/img', image: 'urn:li:image:9' } } }],
      ['PUT https://upload.linkedin.test/img', { status: 201 }],
      ['POST /rest/posts', { status: 201, headers: { 'x-restli-id': 'urn:li:share:2' } }],
      ['POST /rest/videos', { json: { value: { video: 'urn:li:video:7', uploadToken: 'tok', uploadInstructions: [{ uploadUrl: 'https://upload.linkedin.test/v1', firstByte: 0, lastByte: 2 }, { uploadUrl: 'https://upload.linkedin.test/v2', firstByte: 3, lastByte: 4 }] } } }],
      ['PUT https://upload.linkedin.test/v1', { status: 200, headers: { etag: 'e1' } }], ['PUT https://upload.linkedin.test/v2', { status: 200, headers: { etag: 'e2' } }],
      ['POST /rest/videos', { status: 200 }],
      ['POST /rest/posts', { status: 201, headers: { 'x-restli-id': 'urn:li:share:3' } }],
    ]);
    const li = adapters(n.fetchImpl).LINKEDIN;
    const acc = account({ externalAccountId: 'urn:li:person:abc', accountType: 'PROFILE' });
    const text = await li.publish(acc, content({ kind: 'TEXT', caption: 'Launch (new) #1', hashtags: ['bissap'], media: [] }), ctx().c);
    expect(text).toMatchObject({ status: 'PUBLISHED', externalPostId: 'urn:li:share:1', url: 'https://www.linkedin.com/feed/update/urn:li:share:1' });
    const post = JSON.parse(String(n.requests[0]!.body));
    expect(post.author).toBe('urn:li:person:abc');
    expect(post.commentary).toBe('Launch \\(new\\) \\#1\n\n{hashtag|\\#|bissap}');
    expect(post.lifecycleState).toBe('PUBLISHED');
    expect((await li.publish(acc, content(), ctx().c))).toMatchObject({ externalPostId: 'urn:li:share:2' });
    expect(JSON.parse(String(n.requests[3]!.body)).content.media.id).toBe('urn:li:image:9');
    const vid = await li.publish(acc, content({ kind: 'VIDEO', media: [media({ mimeType: 'video/mp4', read: async () => Buffer.from('12345') })] }), ctx().c);
    expect(vid).toMatchObject({ externalPostId: 'urn:li:share:3' });
    expect(JSON.parse(String(n.requests[7]!.body)).finalizeUploadRequest.uploadedPartIds).toEqual(['e1', 'e2']);
  });
  it('cannot refresh without a partner refresh token, and maps permission errors', async () => {
    const li = adapters(net([['POST /rest/posts', { status: 403, json: { message: 'Not enough permissions to access: /posts.CREATE' } }]]).fetchImpl).LINKEDIN;
    await expect(li.refresh({ accessToken: 'a', scopes: [] })).rejects.toMatchObject({ kind: 'unsupported' });
    const err = await li.publish(account(), content({ kind: 'TEXT', media: [] }), ctx().c).catch((e) => e as SocialApiError);
    expect(err).toMatchObject({ kind: 'permission', outcome: 'not_created' });
  });
});

describe('redact', () => {
  it('removes credentials from text', () => {
    expect(redact('access_token=abc123&x=1 Bearer abcDEF.123 client_secret: "s3cret"')).not.toMatch(/abc123|abcDEF|s3cret/);
  });
});

describe('platform error mapping (rate limits, restrictions, duplicates)', () => {
  const failing = (platform: 'TIKTOK' | 'YOUTUBE' | 'LINKEDIN', route: string, status: number, json: unknown, content_: PublishableContent) => {
    const n = net([platform === 'TIKTOK' ? ['POST /creator_info/query/', { json: { error: { code: 'ok' }, data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] } } }] : ['GET /none', {}], [route, { status, json }]] as never);
    return adapters(n.fetchImpl)[platform].publish(account(), content_, ctx().c).catch((e) => e as SocialApiError);
  };
  const tkVideo = () => content({ kind: 'VIDEO', tiktok: tkSettings(), media: [media({ mimeType: 'video/mp4', durationSeconds: 15 })] });

  it('TikTok: explains the audit restriction, domain verification and visibility mismatch, and treats posting caps as rate limits', async () => {
    const run = (code: string) => failing('TIKTOK', 'POST /video/init/', 400, { error: { code, message: 'm' } }, tkVideo());
    expect(await run('unaudited_client_can_only_post_to_private_accounts')).toMatchObject({ kind: 'validation', outcome: 'not_created', message: expect.stringContaining('passed its audit') });
    expect(await run('url_ownership_unverified')).toMatchObject({ kind: 'validation', message: expect.stringContaining('Verify the TOUMA media domain') });
    expect(await run('privacy_level_option_mismatch')).toMatchObject({ kind: 'validation', message: expect.stringContaining('choose the visibility again') });
    expect(await run('spam_risk_too_many_posts')).toMatchObject({ kind: 'rate_limit', opts: expect.objectContaining({ retryAfterMs: 6 * 3_600_000 }) });
    expect(await run('spam_risk_user_banned_from_posting')).toMatchObject({ kind: 'permission' });
  });

  it('YouTube: upload limit is a rate limit, a missing channel is a permission problem with the fix', async () => {
    const vid = content({ kind: 'VIDEO', media: [media({ mimeType: 'video/mp4', sizeBytes: 5, durationSeconds: 30 })] });
    const run = (reason: string, status = 403) => failing('YOUTUBE', 'POST /upload/youtube/v3/videos', status, { error: { message: 'm', errors: [{ reason }] } }, vid);
    expect(await run('uploadLimitExceeded')).toMatchObject({ kind: 'rate_limit', outcome: 'not_created' });
    expect(await run('youtubeSignupRequired')).toMatchObject({ kind: 'permission', message: expect.stringContaining('no YouTube channel') });
    expect(await run('authError', 401)).toMatchObject({ kind: 'auth' });
    expect(await run('quotaExceeded')).toMatchObject({ kind: 'rate_limit', opts: expect.objectContaining({ retryAfterMs: 3_600_000 }) });
  });

  it('YouTube: a video published as private is reported as such, never as public', async () => {
    const n = net([
      ['POST /upload/youtube/v3/videos', { headers: { location: 'https://upload.youtube.test/session1' } }],
      ['PUT https://upload.youtube.test/session1', { json: { id: 'vid9', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } } }],
    ]);
    const out = await adapters(n.fetchImpl).YOUTUBE.publish(account(), content({ kind: 'VIDEO', media: [media({ mimeType: 'video/mp4', sizeBytes: 5, durationSeconds: 30 })] }), ctx().c);
    expect(out).toMatchObject({ status: 'PUBLISHED', externalPostId: 'vid9', notice: expect.stringContaining('not public') });
    const pub = net([['POST /upload/youtube/v3/videos', { headers: { location: 'https://upload.youtube.test/s2' } }], ['PUT https://upload.youtube.test/s2', { json: { id: 'vid10', status: { privacyStatus: 'public' } } }]]);
    expect(await adapters(pub.fetchImpl).YOUTUBE.publish(account(), content({ kind: 'VIDEO', media: [media({ mimeType: 'video/mp4', sizeBytes: 5, durationSeconds: 30 })] }), ctx().c)).toMatchObject({ status: 'PUBLISHED', notice: null });
  });

  it('LinkedIn: DUPLICATE_POST means the post probably exists, so the outcome is unknown (reconcile), not a plain failure', async () => {
    const err = await failing('LINKEDIN', 'POST /rest/posts', 422, { code: 'DUPLICATE_POST', message: 'Content is a duplicate of urn:li:share:1' }, content({ kind: 'TEXT', media: [] }));
    expect(err).toMatchObject({ kind: 'validation', outcome: 'unknown' });
  });
});
