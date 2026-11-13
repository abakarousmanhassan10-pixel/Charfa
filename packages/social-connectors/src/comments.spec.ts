import { createAdapters } from './registry';
import type { FetchLike } from './http';
import type { AuthorizedAccount, SocialApiError } from './types';

/** Comment reading and replying against a scripted network: nothing reaches a real platform. */
type Reply = { status?: number; json?: unknown };
function net(routes: Array<[string, Reply]>) {
  const requests: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string> }> = [];
  const queue = [...routes];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: init?.body, headers: init?.headers ?? {} });
    const i = queue.findIndex(([m]) => { const [mm, ...rest] = m.split(' '); return mm === method && url.includes(rest.join(' ')); });
    if (i < 0) throw new Error(`unexpected request: ${method} ${url}`);
    const r = queue.splice(i, 1)[0]![1];
    const text = r.json === undefined ? '' : JSON.stringify(r.json);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
  };
  return { fetchImpl, requests };
}
const cfg = { metaAppId: 'app-1', metaAppSecret: 'secret-1', metaGraphVersion: 'v21.0', tiktokClientKey: 'tk', tiktokClientSecret: 'tks', googleClientId: 'g', googleClientSecret: 'gs', linkedinClientId: 'l', linkedinClientSecret: 'ls' } as never;
const adapters = (f: FetchLike) => createAdapters(cfg, f);
const account = (o: Partial<AuthorizedAccount> = {}): AuthorizedAccount => ({ externalAccountId: 'acc-1', accountType: 'PAGE', tokens: { accessToken: 'SECRET-TOKEN', scopes: [] }, ...o });

describe('comments on the business\'s own posts', () => {
  it('only the platforms with an official comment API implement it: TikTok and LinkedIn do not', () => {
    const a = adapters(net([]).fetchImpl);
    expect(typeof a.FACEBOOK.fetchComments).toBe('function');
    expect(typeof a.INSTAGRAM.replyToComment).toBe('function');
    expect(typeof a.YOUTUBE.fetchComments).toBe('function');
    expect(a.TIKTOK.fetchComments).toBeUndefined();
    expect(a.LINKEDIN.replyToComment).toBeUndefined();
  });

  it('Facebook: reads comments (marking the Page\'s own) and posts a reply to the comment endpoint', async () => {
    const n = net([
      ['GET /post-1/comments', { json: { data: [{ id: 'c1', message: 'How much?', created_time: '2027-01-01T10:00:00+0000', from: { id: 'u9', name: 'Awa' } }, { id: 'c2', message: 'We answer', from: { id: 'acc-1', name: 'Shop' }, parent: { id: 'c1' } }, { id: 'c3' }], paging: { cursors: { after: 'CUR' }, next: 'https://x' } } }],
      ['POST /c1/comments', { json: { id: 'c1_reply' } }],
    ]);
    const fb = adapters(n.fetchImpl).FACEBOOK;
    const page = await fb.fetchComments!(account(), 'post-1');
    expect(page.items).toHaveLength(2); // an item without text is skipped
    expect(page.items[0]).toMatchObject({ externalId: 'c1', body: 'How much?', authorName: 'Awa', isFromBusiness: false, parentExternalId: null });
    expect(page.items[1]).toMatchObject({ isFromBusiness: true, parentExternalId: 'c1' });
    expect(page.nextCursor).toBe('CUR');
    expect(await fb.replyToComment!(account(), 'c1', 'It costs 1500 XAF')).toEqual({ externalId: 'c1_reply' });
    expect(new URLSearchParams(String(n.requests[1]!.body)).get('message')).toBe('It costs 1500 XAF');
  });

  it('Instagram: replies through /replies; YouTube: lists threads and inserts a reply with the parent id', async () => {
    const n = net([
      ['POST /ig-c1/replies', { json: { id: 'ig-r1' } }],
      ['GET /youtube/v3/commentThreads', { json: { items: [{ id: 't1', snippet: { topLevelComment: { id: 'yc1', snippet: { textDisplay: 'Nice', authorDisplayName: 'Bob', authorChannelId: { value: 'UC9' }, publishedAt: '2027-01-02T00:00:00Z' } } } }], nextPageToken: 'P2' } }],
      ['POST /youtube/v3/comments', { json: { id: 'yr1' } }],
    ]);
    const a = adapters(n.fetchImpl);
    expect(await a.INSTAGRAM.replyToComment!(account(), 'ig-c1', 'Thanks')).toEqual({ externalId: 'ig-r1' });
    const page = await a.YOUTUBE.fetchComments!(account({ externalAccountId: 'UC1' }), 'vid-1');
    expect(page).toMatchObject({ nextCursor: 'P2', items: [{ externalId: 'yc1', body: 'Nice', authorName: 'Bob', isFromBusiness: false }] });
    expect(await a.YOUTUBE.replyToComment!(account(), 'yc1', 'Thanks!')).toEqual({ externalId: 'yr1' });
    expect(JSON.parse(String(n.requests[2]!.body))).toEqual({ snippet: { parentId: 'yc1', textOriginal: 'Thanks!' } });
  });

  it('platform refusals are normalized (permission, rate limit) and the token never leaks into the error', async () => {
    const n = net([
      ['GET /p/comments', { status: 403, json: { error: { message: 'Requires pages_read_engagement (access_token=SECRET-TOKEN)', code: 10 } } }],
      ['POST /youtube/v3/comments', { status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } } }],
    ]);
    const a = adapters(n.fetchImpl);
    const e1 = (await a.FACEBOOK.fetchComments!(account(), 'p').catch((e) => e)) as SocialApiError;
    expect(e1.kind).toBe('permission');
    expect(e1.message).not.toContain('SECRET-TOKEN');
    const e2 = (await a.YOUTUBE.replyToComment!(account(), 'c', 'x').catch((e) => e)) as SocialApiError;
    expect(['rate_limit', 'permission']).toContain(e2.kind);
  });
});
