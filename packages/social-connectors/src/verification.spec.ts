import { createAdapters } from './registry';
import { paginateGraph, Http, MAX_PAGES, type FetchLike } from './http';
import { probeMedia } from './probe';
import { matchCandidates } from './reconcile';
import { validateAgainstLimits } from './validate';
import type { AuthorizedAccount, MediaItem, PublishableContent } from './types';

/** Scripted network: handlers receive the URL and answer, requests are recorded. */
function net(handler: (url: string, method: string, body?: unknown) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const requests: Array<{ url: string; method: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    const r = handler(url, method, init?.body);
    const text = r.json === undefined ? '' : JSON.stringify(r.json);
    const status = r.status ?? 200;
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: status < 300, status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => text };
  };
  return { fetchImpl, requests };
}
const cfg = { metaAppId: 'a', metaAppSecret: 's', metaGraphVersion: 'v21.0', tiktokClientKey: 'tk', tiktokClientSecret: 'tks', googleClientId: 'g', googleClientSecret: 'gs', linkedinClientId: 'li', linkedinClientSecret: 'lis', linkedinApiVersion: '202411' };
const acct = (o: Partial<AuthorizedAccount> = {}): AuthorizedAccount => ({ externalAccountId: 'acc-1', accountType: 'PAGE', tokens: { accessToken: 'TOK', scopes: ['video.list'] }, ...o });
const since = new Date('2026-11-12T10:00:00Z');

describe('Meta pagination', () => {
  const pageOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, name: `Page ${from + i}`, access_token: `t${from + i}`, tasks: ['CREATE_CONTENT'], instagram_business_account: { id: `ig${from + i}` } }));

  it('lists every Page of a manager with 230 Pages (not just the first 100) using cursors', async () => {
    const n = net((url) => {
      if (url.includes('/me/permissions')) return { json: { data: [{ permission: 'pages_show_list', status: 'granted' }] } };
      const after = new URL(url).searchParams.get('after');
      if (!after) return { json: { data: pageOf(0, 100), paging: { cursors: { after: 'c1' }, next: 'https://graph.facebook.com/next1' } } };
      if (after === 'c1') return { json: { data: pageOf(100, 100), paging: { cursors: { after: 'c2' }, next: 'https://graph.facebook.com/next2' } } };
      return { json: { data: pageOf(200, 30), paging: { cursors: { after: 'c3' } } } }; // no "next": the end
    });
    const a = createAdapters(cfg, n.fetchImpl);
    const fb = await a.FACEBOOK.listAccounts({ accessToken: 'u', scopes: [] });
    expect(fb).toHaveLength(230);
    expect(new Set(fb.map((x) => x.externalAccountId)).size).toBe(230);
    expect(fb[229]!.externalAccountId).toBe('p229');
    expect(fb.some((x) => x.metadata?.listingTruncated)).toBe(false);
    const ig = await createAdapters(cfg, net((url) => {
      if (url.includes('/me/permissions')) return { json: { data: [] } };
      const after = new URL(url).searchParams.get('after');
      return after ? { json: { data: pageOf(100, 20), paging: { cursors: { after: 'z' } } } } : { json: { data: pageOf(0, 100), paging: { cursors: { after: 'c1' }, next: 'x' } } };
    }).fetchImpl).INSTAGRAM.listAccounts({ accessToken: 'u', scopes: [] });
    expect(ig).toHaveLength(120);
    expect(ig[119]!.parentExternalId).toBe('p119');
  });

  it('follows paging.next when no cursor is given and stops on an empty last page', async () => {
    const n = net((url) => {
      if (url.includes('/list')) return { json: { data: [1, 2], paging: { next: 'https://graph.facebook.com/p2?access_token=T' } } };
      return { json: { data: [3] } };
    });
    const r = await paginateGraph<number>(new Http(n.fetchImpl), 'https://graph.facebook.com/list', {}, () => null);
    expect(r).toEqual({ items: [1, 2, 3], pages: 2, truncated: false });
  });

  it('stops on a repeating cursor (no infinite loop) and flags truncation at the safety cap instead of silently stopping', async () => {
    const loop = net(() => ({ json: { data: [1], paging: { cursors: { after: 'same' }, next: 'x' } } }));
    const r1 = await paginateGraph<number>(new Http(loop.fetchImpl), 'https://graph.facebook.com/l', {}, () => null);
    expect(r1.truncated).toBe(false);
    expect(loop.requests.length).toBeLessThanOrEqual(3);
    let i = 0;
    const endless = net(() => ({ json: { data: [i], paging: { cursors: { after: `c${i++}` }, next: 'x' } } }));
    const r2 = await paginateGraph<number>(new Http(endless.fetchImpl), 'https://graph.facebook.com/l', {}, () => null, 5);
    expect(r2.truncated).toBe(true);
    expect(r2.pages).toBe(5);
    expect(MAX_PAGES).toBeGreaterThanOrEqual(100);
  });

  it('marks accounts as incomplete when the safety cap stopped the listing', async () => {
    let i = 0;
    const n = net((url) => (url.includes('/me/permissions') ? { json: { data: [] } } : { json: { data: pageOf(i * 10, 10), paging: { cursors: { after: `c${i++}` }, next: 'x' } } }));
    const fb = await createAdapters(cfg, n.fetchImpl).FACEBOOK.listAccounts({ accessToken: 'u', scopes: [] });
    expect(fb.length).toBe(MAX_PAGES * 10);
    expect(fb.every((x) => x.metadata?.listingTruncated === true)).toBe(true);
  });
});

describe('YouTube and LinkedIn listings are complete too', () => {
  it('follows nextPageToken for channels', async () => {
    const n = net((url) => {
      const tok = new URL(url).searchParams.get('pageToken');
      return tok ? { json: { items: [{ id: 'c3' }] } } : { json: { items: [{ id: 'c1' }, { id: 'c2' }], nextPageToken: 'n2' } };
    });
    const out = await createAdapters(cfg, n.fetchImpl).YOUTUBE.listAccounts({ accessToken: 't', scopes: [] });
    expect(out.map((x) => x.externalAccountId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('pages LinkedIn organization ACLs by start/count and keeps the personal profile separate from organizations', async () => {
    const els = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ organization: `urn:li:organization:${from + i}` }));
    const n = net((url) => {
      if (url.includes('/v2/userinfo')) return { json: { sub: 'me', name: 'Aminata' } };
      if (url.includes('/rest/organizationAcls')) return { json: { elements: new URL(url).searchParams.get('start') === '0' ? els(0, 100) : els(100, 7) } };
      return { json: { localizedName: 'Org' } };
    });
    const out = await createAdapters(cfg, n.fetchImpl).LINKEDIN.listAccounts({ accessToken: 't', scopes: ['w_member_social'] });
    expect(out.filter((x) => x.accountType === 'PROFILE')).toHaveLength(1);
    const orgs = out.filter((x) => x.accountType === 'ORGANIZATION');
    expect(orgs).toHaveLength(107);
    expect(orgs[0]!.permissionsMissing).toContain('w_organization_social'); // org publishing needs its own scope and approval
    expect(out[0]!.permissionsMissing).toEqual([]);
  });

  it('returns only the personal profile when LinkedIn has not approved organization access', async () => {
    const n = net((url) => (url.includes('/v2/userinfo') ? { json: { sub: 'me' } } : { status: 403, json: { message: 'not enough permissions' } }));
    const out = await createAdapters(cfg, n.fetchImpl).LINKEDIN.listAccounts({ accessToken: 't', scopes: ['w_member_social'] });
    expect(out.map((x) => x.accountType)).toEqual(['PROFILE']);
  });
});

// ─── Media probing and rules ────────────────────────────────────────────────

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const u32 = (...v: number[]) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x, i * 4)); return b; };
function mp4(o: { w: number; h: number; seconds: number; codec?: string; audio?: string }) {
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, o.seconds * 1000), Buffer.alloc(80));
  const tkhd = box('tkhd', Buffer.concat([u32(0x0f, 0, 0, 1, 0, o.seconds * 1000), Buffer.alloc(8 + 8 + 36), u32(o.w * 65536, o.h * 65536)]));
  const stsd = (cc: string) => box('stsd', u32(0, 1), box(cc, Buffer.alloc(8)));
  const vtrak = box('trak', tkhd, box('mdia', box('minf', box('stbl', stsd(o.codec ?? 'avc1')))));
  const atrak = box('trak', box('mdia', box('minf', box('stbl', stsd(o.audio ?? 'mp4a')))));
  return Buffer.concat([box('ftyp', Buffer.from('isom0000isom', 'latin1')), box('moov', mvhd, vtrak, atrak)]);
}

describe('probeMedia', () => {
  it('reads duration, pixel size and codecs from an MP4', () => {
    expect(probeMedia(mp4({ w: 1080, h: 1920, seconds: 12 }))).toMatchObject({ container: 'mp4', width: 1080, height: 1920, durationSeconds: 12, videoCodec: 'avc1', audioCodec: 'mp4a' });
    expect(probeMedia(mp4({ w: 1920, h: 1080, seconds: 5, codec: 'vp09', audio: 'opus' }))).toMatchObject({ videoCodec: 'vp09', audioCodec: 'opus' });
  });
  it('reads PNG and JPEG sizes and reports unknown for anything else', () => {
    const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
    expect(probeMedia(png)).toMatchObject({ container: 'png', width: 640, height: 480 });
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0x04, 0x38, 0x03, 0xc0, 1, 0, 0, 0])]);
    expect(probeMedia(jpg)).toMatchObject({ container: 'jpeg', width: 960, height: 1080 });
    expect(probeMedia(Buffer.from('not media at all'))).toEqual({ container: 'unknown' });
    expect(probeMedia(Buffer.alloc(0))).toEqual({ container: 'unknown' });
  });
});

describe('media rules (aspect ratio, pixels, codec) with clear errors', () => {
  const vid = (o: Partial<MediaItem>): MediaItem => ({ id: 'v', url: 'https://x/v', mimeType: 'video/mp4', sizeBytes: 1_000_000, durationSeconds: 20, width: 1080, height: 1920, videoCodec: 'avc1', audioCodec: 'mp4a', read: async () => Buffer.alloc(0), ...o });
  const img = (o: Partial<MediaItem>): MediaItem => ({ id: 'i', url: 'https://x/i', mimeType: 'image/jpeg', sizeBytes: 1_000, width: 1080, height: 1350, read: async () => Buffer.alloc(0), ...o });
  const video = (m: MediaItem, surface: PublishableContent['surface'] = 'REEL'): PublishableContent => ({ kind: 'VIDEO', surface, caption: 'x', hashtags: [], media: [m] });
  const image = (m: MediaItem): PublishableContent => ({ kind: 'IMAGE', surface: 'FEED', caption: 'x', hashtags: [], media: [m] });
  const msgs = (p: Parameters<typeof validateAgainstLimits>[0], c: PublishableContent) => validateAgainstLimits(p, c).map((i) => i.message);

  it('accepts a 9:16 H.264/AAC reel and a 4:5 JPEG on Instagram', () => {
    expect(msgs('INSTAGRAM', video(vid({})))).toEqual([]);
    expect(msgs('INSTAGRAM', image(img({})))).toEqual([]);
  });
  it('rejects an Instagram image outside 4:5 to 1.91:1 with the numbers and a fix', () => {
    const m = msgs('INSTAGRAM', image(img({ width: 1000, height: 2000 })));
    expect(m[0]).toMatch(/1000x2000.*aspect ratio 0\.50:1.*0\.80:1 to 1\.91:1.*Crop or resize/);
  });
  it('rejects a tiny image and a HEVC-only platform mismatch', () => {
    expect(msgs('INSTAGRAM', image(img({ width: 200, height: 250 })))[0]).toMatch(/at least 320 pixels/);
    expect(msgs('LINKEDIN', video(vid({ videoCodec: 'hvc1' }), 'FEED'))[0]).toMatch(/H\.265\/HEVC codec; LinkedIn accepts H\.264/);
  });
  it('rejects an unsupported audio codec and a video that is too small or too large', () => {
    expect(msgs('INSTAGRAM', video(vid({ audioCodec: 'ac-3' })))[0]).toMatch(/audio uses ac-3; Instagram accepts AAC/);
    expect(msgs('TIKTOK', video(vid({ width: 240, height: 426 }), 'FEED'))[0]).toMatch(/at least 360 pixels/);
    expect(msgs('TIKTOK', video(vid({ width: 5000, height: 2500 }), 'FEED')).join(' ')).toMatch(/at most 4096/);
  });
  it('still enforces size, duration and type, and does not guess when probed facts are absent', () => {
    expect(msgs('INSTAGRAM', video(vid({ durationSeconds: 1 })))[0]).toMatch(/at least 3 s/);
    expect(msgs('INSTAGRAM', video(vid({ sizeBytes: 400 * 1048576 })))[0]).toMatch(/larger than 300 MB/);
    expect(msgs('INSTAGRAM', image(img({ mimeType: 'image/png' })))[0]).toMatch(/accepts these image types: image\/jpeg/);
    expect(msgs('INSTAGRAM', video(vid({ width: null, height: null, videoCodec: null, audioCodec: null })))).toEqual([]);
  });
  it('flags a 36+ megapixel image on LinkedIn', () => {
    expect(msgs('LINKEDIN', image(img({ width: 7000, height: 6000 })))[0]).toMatch(/42\.0 megapixels; LinkedIn accepts at most 36\.2/);
  });
  it('names which of several media items is wrong', () => {
    const c: PublishableContent = { kind: 'CAROUSEL', surface: 'FEED', caption: 'x', hashtags: [], media: [img({}), img({ id: 'i2', width: 100, height: 3000 })] };
    expect(msgs('INSTAGRAM', c).some((x) => x.startsWith('Media 2:'))).toBe(true);
  });
});

// ─── Reconciliation ─────────────────────────────────────────────────────────

describe('matchCandidates', () => {
  const q = { text: 'Fresh bissap\n\n#bissap', since };
  it('one match = FOUND, several = AMBIGUOUS, none = NOT_FOUND; older posts and other text never match', () => {
    const at = '2026-11-12T10:00:30Z';
    expect(matchCandidates([{ id: 'a', text: 'fresh   bissap #bissap', at }], q)).toMatchObject({ result: 'FOUND', externalPostId: 'a' });
    expect(matchCandidates([{ id: 'a', text: 'Fresh bissap\n\n#bissap', at }, { id: 'b', text: 'Fresh bissap #bissap', at }], q)).toMatchObject({ result: 'AMBIGUOUS' });
    expect(matchCandidates([{ id: 'old', text: 'Fresh bissap #bissap', at: '2026-11-01T00:00:00Z' }, { id: 'o', text: 'something else', at }], q)).toEqual({ result: 'NOT_FOUND', checked: 2 });
    expect(matchCandidates([{ id: 'x', text: '', at }], { text: '', since })).toMatchObject({ result: 'NOT_FOUND' });
  });
});

describe('adapter reconcile (read-only lookups)', () => {
  const text = 'Fresh bissap\n\n#bissap';
  const q = { text, since };
  const at = '2026-11-12T10:00:40+0000';

  it('Facebook finds the post in the Page feed, following pages', async () => {
    const n = net((url) => (new URL(url).searchParams.get('after')
      ? { json: { data: [{ id: 'p_9', message: text, created_time: at, permalink_url: '/p/9' }] } }
      : { json: { data: [{ id: 'p_1', message: 'other', created_time: at }], paging: { cursors: { after: 'a' }, next: 'x' } } }));
    const r = await createAdapters(cfg, n.fetchImpl).FACEBOOK.reconcile(acct(), q);
    expect(r).toMatchObject({ result: 'FOUND', externalPostId: 'p_9' });
    expect(n.requests.every((x) => x.method === 'GET')).toBe(true);
  });
  it('Instagram reports NOT_FOUND when the media list has no match, and UNAVAILABLE (never NOT_FOUND) when the lookup itself fails', async () => {
    const ok = net(() => ({ json: { data: [{ id: 'm1', caption: 'other', timestamp: at }] } }));
    expect(await createAdapters(cfg, ok.fetchImpl).INSTAGRAM.reconcile(acct(), q)).toEqual({ result: 'NOT_FOUND', checked: 1 });
    const denied = net(() => ({ status: 400, json: { error: { code: 200, message: 'permission' } } }));
    expect(await createAdapters(cfg, denied.fetchImpl).INSTAGRAM.reconcile(acct(), q)).toMatchObject({ result: 'UNAVAILABLE' });
    const down = net(() => ({ status: 500, json: {} }));
    expect(await createAdapters(cfg, down.fetchImpl).FACEBOOK.reconcile(acct(), q)).toMatchObject({ result: 'UNAVAILABLE' });
  });
  it('TikTok trusts the publish id first, then the video list, and says so when video.list was not granted', async () => {
    const done = net(() => ({ json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [777] } } }));
    expect(await createAdapters(cfg, done.fetchImpl).TIKTOK.reconcile(acct(), { ...q, ref: 'pub1', stage: 'PUBLISH_INIT' })).toMatchObject({ result: 'FOUND', externalPostId: '777' });
    const noScope = net(() => ({ json: {} }));
    const r = await createAdapters(cfg, noScope.fetchImpl).TIKTOK.reconcile(acct({ tokens: { accessToken: 't', scopes: ['video.publish'] } }), q);
    expect(r).toMatchObject({ result: 'UNAVAILABLE', reason: expect.stringContaining('video.list') });
    expect(noScope.requests).toHaveLength(0);
    const list = net(() => ({ json: { data: { videos: [{ id: 'v1', title: text, create_time: Math.floor(Date.parse('2026-11-12T10:00:40Z') / 1000), share_url: 'https://tiktok/v1' }], has_more: false } } }));
    expect(await createAdapters(cfg, list.fetchImpl).TIKTOK.reconcile(acct(), q)).toMatchObject({ result: 'FOUND', externalPostId: 'v1' });
  });
  it('YouTube reads the uploads playlist (1 quota unit) and finds the video by description', async () => {
    const n = net((url) => (url.includes('/channels') ? { json: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] } } : { json: { items: [{ snippet: { description: text, publishedAt: '2026-11-12T10:00:50Z', resourceId: { videoId: 'vid1' } } }] } }));
    expect(await createAdapters(cfg, n.fetchImpl).YOUTUBE.reconcile(acct(), q)).toMatchObject({ result: 'FOUND', externalPostId: 'vid1' });
    expect(n.requests.some((x) => x.url.includes('/search'))).toBe(false);
  });
  it('LinkedIn says it cannot look without the restricted read permission, and finds the post when it can', async () => {
    const denied = net(() => ({ status: 403, json: {} }));
    expect(await createAdapters(cfg, denied.fetchImpl).LINKEDIN.reconcile(acct(), q)).toMatchObject({ result: 'UNAVAILABLE', reason: expect.stringContaining('r_member_social') });
    const ok = net(() => ({ json: { elements: [{ id: 'urn:li:share:1', commentary: 'Fresh bissap\n\n{hashtag|\\#|bissap}', publishedAt: Date.parse('2026-11-12T10:01:00Z') }] } }));
    expect(await createAdapters(cfg, ok.fetchImpl).LINKEDIN.reconcile(acct(), q)).toMatchObject({ result: 'FOUND', externalPostId: 'urn:li:share:1' });
  });
});
