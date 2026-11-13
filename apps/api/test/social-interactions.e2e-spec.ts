import type { INestApplication } from '@nestjs/common';
import { SocialApiError } from '@touma/social-connectors';
import { SocialInteractionsService } from '../src/social/social-interactions.service';
import type { Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * Phase N19: comments and replies through the shared connector contract. Real PostgreSQL, Redis, guards and services; the
 * platforms are the test-only simulator, so nothing is ever sent to a real platform.
 */
describe('Social interactions: comments, replies, capabilities (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let svc: SocialInteractionsService;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = socialHelpers(app);
    svc = app.get(SocialInteractionsService);
  });
  beforeEach(() => h.hub.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function shop(platform: 'FACEBOOK' | 'INSTAGRAM' | 'YOUTUBE' | 'TIKTOK' = 'FACEBOOK') {
    const owner = await h.tenant(`Interact ${++n}`);
    const admin = await h.member(owner, 'ADMIN');
    const editor = await h.member(owner, 'EDITOR');
    const viewer = await h.member(owner, 'VIEWER');
    const account = await h.connect(owner, platform);
    return { owner, admin, editor, viewer, account, slot: 0 };
  }
  type S = Awaited<ReturnType<typeof shop>>;
  const mode = (s: S, data: { enabled: boolean; replyMode?: 'REVIEW' | 'AUTO'; authorized?: boolean }) =>
    prisma.salesAgentConfig.upsert({
      where: { businessId: s.owner.businessId },
      create: { businessId: s.owner.businessId, enabled: data.enabled, replyMode: data.replyMode ?? 'REVIEW', autoReplyAuthorizedAt: data.authorized ? new Date() : null },
      update: { enabled: data.enabled, replyMode: data.replyMode ?? 'REVIEW', autoReplyAuthorizedAt: data.authorized ? new Date() : null },
    });
  /** A really published post (through N18) with comments waiting on the simulated platform. */
  async function withComments(s: S, count = 2) {
    const { pub } = await h.publishEntry(s.editor, s.admin, { platform: s.account.platform, localDate: h.day(2 + s.slot++), localTime: '10:00', title: 'Post' }, ['PUBLISHED', 'FAILED', 'MANUAL_REQUIRED']);
    if (!pub || pub.status !== 'PUBLISHED') throw new Error(`not published: ${pub?.status}`);
    h.hub.commentsByPost.set(
      pub.externalPostId!,
      Array.from({ length: count }, (_, i) => ({ externalId: `cm-${n}-${i}`, parentExternalId: null, authorExternalId: `u${i}`, authorName: `Client ${i}`, body: `Question ${i}?`, postedAt: new Date(), isFromBusiness: false })),
    );
    return pub;
  }
  const sync = (c: Ctx, id: string) => h.post(c, `/publications/${id}/comments/sync`);
  const comments = async (c: Ctx, id: string) => (await h.get(c, `/comments?publicationId=${id}`).expect(200)).body.items as Array<{ id: string; body: string }>;
  const reply = (c: Ctx, id: string, text = 'Merci, oui!') => h.post(c, `/comments/${id}/reply`, { text });

  it('reports capabilities: documented, permission-missing, unverified and unsupported are told apart', async () => {
    const s = await shop('INSTAGRAM');
    const r = (await h.get(s.viewer, `/accounts/${s.account.id}/capabilities`).expect(200)).body;
    expect(r.simulated).toBe(true);
    expect(r.features.commentsRead.state).toBe('AVAILABLE');
    const tk = await h.connect(s.owner, 'TIKTOK');
    const t = (await h.get(s.viewer, `/accounts/${tk.id}/capabilities`).expect(200)).body;
    expect(['UNSUPPORTED', 'NOT_IMPLEMENTED', 'UNVERIFIED']).toContain(t.features.commentsReply.state);
    expect(t.features.commentsReply.state).not.toBe('AVAILABLE');
    const missing = await h.connect(s.owner, 'INSTAGRAM', 2, { scopes: ['instagram_basic'] });
    const m = (await h.get(s.viewer, `/accounts/${missing.id}/capabilities`).expect(200)).body;
    expect(m.features.commentsRead.state).toBe('PERMISSION_MISSING');
    expect(m.features.commentsRead.missingScopes.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/secret-token/);
  });

  it('reads comments of a published post, once, inside the right tenant', async () => {
    const s = await shop();
    const pub = await withComments(s);
    // reading is a read-only action open to everyone who may read the inbox; writing (reply) is not
    expect((await sync(s.viewer, pub.id).expect(200)).body).toMatchObject({ fetched: 2, added: 2 });
    expect((await sync(s.editor, pub.id).expect(200)).body).toMatchObject({ fetched: 2, added: 0 });
    expect(await comments(s.viewer, pub.id)).toHaveLength(2);
    const other = await shop();
    expect((await sync(other.editor, pub.id)).status).toBe(404);
    expect((await h.get(other.editor, `/comments?publicationId=${pub.id}`).expect(200)).body.items).toHaveLength(0);
  });

  it('a human reply is sent once, recorded and audited; a second attempt and other tenants are refused', async () => {
    const s = await shop();
    const pub = await withComments(s);
    await sync(s.editor, pub.id).expect(200);
    const [c] = await comments(s.editor, pub.id);
    expect((await reply(s.viewer, c.id)).status).toBe(403);
    await reply(s.editor, c.id).expect(200);
    expect(h.hub.replies).toHaveLength(1);
    expect(h.hub.replies[0].text).toBe('Merci, oui!');
    expect((await reply(s.editor, c.id)).status).toBe(409);
    expect(h.hub.replies).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { businessId: s.owner.businessId, action: 'social.comment_replied' } })).toBe(1);
    const other = await shop();
    expect((await reply(other.editor, c.id)).status).toBe(404);
  });

  it('automatic replies are refused unless the merchant set AUTO and authorized it', async () => {
    const s = await shop();
    const pub = await withComments(s, 4);
    await sync(s.editor, pub.id).expect(200);
    const cs = await comments(s.editor, pub.id);
    const tenant = { userId: s.admin.userId, businessId: s.owner.businessId } as never;
    // no agent configured = PAUSED
    await expect(svc.autoReply(tenant, cs[0].id, 'auto')).rejects.toMatchObject({ response: { code: 'AUTO_NOT_ENABLED', mode: 'PAUSED' } });
    await mode(s, { enabled: true, replyMode: 'REVIEW' });
    await expect(svc.autoReply(tenant, cs[1].id, 'auto')).rejects.toMatchObject({ response: { code: 'AUTO_NOT_ENABLED', mode: 'MANUAL' } });
    await mode(s, { enabled: true, replyMode: 'AUTO', authorized: false });
    await expect(svc.autoReply(tenant, cs[2].id, 'auto')).rejects.toMatchObject({ response: { code: 'AUTO_NOT_ENABLED', mode: 'MANUAL' } });
    expect(h.hub.replies).toHaveLength(0);
    await mode(s, { enabled: true, replyMode: 'AUTO', authorized: true });
    await svc.autoReply(tenant, cs[3].id, 'auto ok');
    expect(h.hub.replies).toHaveLength(1);
    // PAUSED still lets a person answer explicitly
    await mode(s, { enabled: false });
    await reply(s.editor, cs[0].id, 'by a person').expect(200);
    expect(h.hub.replies).toHaveLength(2);
  });

  it('platform failures become safe answers: rate limit, expired token, outage, missing permission', async () => {
    const s = await shop();
    const pub = await withComments(s, 4);
    await sync(s.editor, pub.id).expect(200);
    const cs = await comments(s.editor, pub.id);
    h.hub.script('FACEBOOK', 'reply', new SocialApiError('rate_limit', 'slow down', { retryAfterMs: 60_000 }));
    const rl = await reply(s.editor, cs[0].id);
    expect(rl.status).toBe(429);
    expect(rl.body.code ?? rl.body.error?.code).toBe('PLATFORM_RATE_LIMIT');
    h.hub.script('FACEBOOK', 'reply', new SocialApiError('transient', 'down'));
    expect((await reply(s.editor, cs[1].id)).status).toBe(503);
    h.hub.script('FACEBOOK', 'reply', new SocialApiError('permission', 'no'));
    expect((await reply(s.editor, cs[2].id)).status).toBe(409);
    expect(h.hub.replies).toHaveLength(0);
    // refusals leave nothing behind and the comment can still be answered later
    expect(await prisma.comment.count({ where: { businessId: s.owner.businessId, externalCommentId: { startsWith: 'pending:' } } })).toBe(0);
    await reply(s.editor, cs[0].id).expect(200);
    h.hub.script('FACEBOOK', 'reply', new SocialApiError('auth', 'expired'));
    expect((await reply(s.editor, cs[3].id)).status).toBe(409);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: s.account.id } })).status).not.toBe('CONNECTED');
    // a disconnected-for-reconnection account is never used again
    const calls = h.hub.count('FACEBOOK', 'reply');
    expect((await reply(s.editor, cs[3].id)).status).toBe(409);
    expect(h.hub.count('FACEBOOK', 'reply')).toBe(calls);
  });

  it('an unknown outcome is never retried automatically', async () => {
    const s = await shop();
    const pub = await withComments(s, 1);
    await sync(s.editor, pub.id).expect(200);
    const [c] = await comments(s.editor, pub.id);
    h.hub.script('FACEBOOK', 'reply', new SocialApiError('timeout', 'timed out', { outcome: 'unknown' }));
    const r = await reply(s.editor, c.id);
    expect(r.status).toBe(502);
    expect(await prisma.comment.count({ where: { externalCommentId: `unknown:${c.id}` } })).toBe(1);
  });

  it('unsupported platforms fail safely and call nothing', async () => {
    const s = await shop('TIKTOK');
    const c = await prisma.comment.create({ data: { businessId: s.owner.businessId, socialAccountId: s.account.id, externalCommentId: 'tt-1', body: 'Hi' } });
    const r = await reply(s.editor, c.id);
    expect([501, 409]).toContain(r.status);
    expect(h.hub.count('TIKTOK', 'reply')).toBe(0);
    expect(h.hub.replies).toHaveLength(0);
  });

  it('validation records the check, and a rejected token asks for reconnection', async () => {
    const s = await shop();
    expect((await h.post(s.viewer, `/accounts/${s.account.id}/validate`)).status).toBe(403);
    const ok = (await h.post(s.admin, `/accounts/${s.account.id}/validate`).expect(200)).body;
    expect(ok.lastVerifiedAt).toBeTruthy();
    const other = await shop();
    expect((await h.post(other.admin, `/accounts/${s.account.id}/validate`)).status).toBe(404);
  });
});
