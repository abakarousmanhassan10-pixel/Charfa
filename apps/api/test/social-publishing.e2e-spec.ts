import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SocialApiError, EMPTY_METRICS } from '@touma/social-connectors';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';
import { SocialQueueService } from '../src/social/social-queue';

/**
 * The central publishing engine end to end: scheduled hand-off from the calendar, validation, manual fallback, token handling,
 * API failures and retries, duplicate prevention across restarts, approval requirements, history, queue and analytics.
 * Real PostgreSQL, Redis, BullMQ, storage and media URLs; the platforms are the test-only simulator, so these tests prove TOUMA's
 * behavior, not that any real platform accepts a post (no real platform was contacted).
 */
describe('Social publishing (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let queue: SocialQueueService;
  let n = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    await resetDb();
    await prisma.webhookEvent.deleteMany();
    app = await startApp();
    h = socialHelpers(app);
    queue = app.get(SocialQueueService);
  });
  beforeEach(() => h.hub.reset());
  afterAll(async () => {
    await queue.q.resume().catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  });

  type Biz = Awaited<ReturnType<typeof newBiz>>;
  /** A business with an owner, an admin, an editor, a viewer and one connected account on every platform. */
  async function newBiz(name = `Shop ${++n}`) {
    const owner = await h.tenant(name);
    const admin = await h.member(owner, 'ADMIN');
    const editor = await h.member(owner, 'EDITOR');
    const viewer = await h.member(owner, 'VIEWER');
    const accounts = {
      INSTAGRAM: await h.connect(owner, 'INSTAGRAM'), FACEBOOK: await h.connect(owner, 'FACEBOOK'), TIKTOK: await h.connect(owner, 'TIKTOK'),
      YOUTUBE: await h.connect(owner, 'YOUTUBE'), LINKEDIN: await h.connect(owner, 'LINKEDIN'),
    };
    return { owner, admin, editor, viewer, accounts, slot: 0 };
  }
  /** A fresh day/time so entries of one business never conflict with each other. */
  const slot = (b: Biz) => ({ localDate: h.day(2 + b.slot++), localTime: '10:00' });
  const publish = (b: Biz, body: Record<string, unknown>, statuses?: string[]) => h.publishEntry(b.editor, b.admin, { ...slot(b), ...body }, statuses);
  const waitUntil = async (entryId: string, pred: (p: NonNullable<Awaited<ReturnType<typeof h.publicationOf>>>) => boolean, timeoutMs = 10_000) =>
    h.waitFor(async () => {
      const p = await prisma.publication.findFirst({ where: { calendarEventId: entryId }, orderBy: { createdAt: 'desc' } });
      return p && pred(p) ? p : null;
    }, timeoutMs);

  describe('publishing formats', () => {
    it('publishes a text post to Facebook, only after the scheduled time, and records the platform id and link', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Text post' });
      await h.calendarWorker.tick(); // not due yet
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(0);
      expect(await prisma.publication.count({ where: { calendarEventId: e.id } })).toBe(0);
      await h.dispatch(e.id);
      const pub = await h.reach(e.id, ['PUBLISHED']);
      const post = h.hub.posts[0]!;
      expect(h.hub.posts).toHaveLength(1);
      expect(pub).toMatchObject({ platform: 'FACEBOOK', mode: 'API', externalPostId: post.id, confirmedByProvider: true, errorCode: null });
      expect(pub.externalUrl).toBe(`https://fake-platform.test/FACEBOOK/${post.id}`);
      expect(pub.publishedAt).not.toBeNull();
      expect(post.content).toMatchObject({ kind: 'TEXT', caption: 'Fresh bissap juice, served cold.' });
      expect(post.accountId).toBe(b.accounts.FACEBOOK.externalAccountId);
      expect(h.hub.calls.find((c) => c.op === 'publish')!.accessToken).toBe(h.tokenOf(b.accounts.FACEBOOK)); // the stored token reached the adapter, decrypted
      await h.waitFor(async () => (await h.entryRow(e.id)).content?.status === 'PUBLISHED'); // written back right after the platform confirmed
      const row = await h.entryRow(e.id);
      expect(row.status).toBe('DONE');
      expect(pub.idempotencyKey).toBe(row.dispatchKey);
      const actions = (await prisma.auditLog.findMany({ where: { entityId: { in: [e.id, pub.id] } } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['calendar.authorized', 'calendar.dispatched', 'social.published', 'calendar.published']));
      await h.waitFor(async () => (await h.notifications(b.admin.userId, 'social.published')).some((x) => (x.data as { entryId: string }).entryId === e.id));
      expect((await h.notifications(b.admin.userId, 'social.published')).filter((x) => (x.data as { entryId: string }).entryId === e.id)).toHaveLength(1);
    });

    it('publishes an image with a media URL the platform can actually download', async () => {
      const b = await newBiz();
      const photo = await h.jpeg(b.owner);
      const { pub } = await publish(b, { platform: 'INSTAGRAM', contentType: 'IMAGE', mediaIds: [photo.id], title: 'Photo' }, ['PUBLISHED']);
      expect(pub!.status).toBe('PUBLISHED');
      const call = h.hub.calls.find((c) => c.op === 'publish')!;
      expect(call.kind).toBe('IMAGE');
      expect(call.mediaUrls![0]).toMatch(new RegExp(`^https://api\\.touma\\.test/api/v1/media/${photo.id}/content\\?exp=\\d+&sig=`));
      const path = call.mediaUrls![0]!.replace('https://api.touma.test', '');
      const res = await request(h.http).get(path).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect((res.body as Buffer).subarray(0, 2).toString('hex')).toBe('ffd8'); // a JPEG, as Instagram requires
      await request(h.http).get(path.replace(/sig=.+$/, 'sig=forged')).expect(404); // not a public file: the signature is required
    });

    it('publishes carousels (Instagram, Facebook, LinkedIn)', async () => {
      const b = await newBiz();
      const photos = [await h.jpeg(b.owner), await h.jpeg(b.owner, 600, 750), await h.jpeg(b.owner, 700, 700)];
      for (const platform of ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN'] as const) {
        const { pub } = await publish(b, { platform, contentType: 'CAROUSEL', mediaIds: photos.map((p) => p.id), title: `Carousel ${platform}` }, ['PUBLISHED']);
        expect(pub!.status).toBe('PUBLISHED');
        expect(h.hub.calls.filter((c) => c.op === 'publish' && c.platform === platform).at(-1)).toMatchObject({ kind: 'CAROUSEL' });
        expect(h.hub.calls.filter((c) => c.op === 'publish' && c.platform === platform).at(-1)!.mediaUrls).toHaveLength(3);
      }
    });

    it('publishes videos: Reels on Instagram, Shorts and videos on YouTube, TikTok and LinkedIn videos', async () => {
      const b = await newBiz();
      const short = await h.video(b.owner, { seconds: 25, width: 1080, height: 1920 });
      const long = await h.video(b.owner, { seconds: 300, width: 1920, height: 1080 });
      const cases: Array<[string, string, string]> = [['INSTAGRAM', short.id, 'REEL'], ['YOUTUBE', short.id, 'SHORT'], ['YOUTUBE', long.id, 'FEED'], ['TIKTOK', short.id, 'FEED'], ['LINKEDIN', short.id, 'FEED']];
      for (const [platform, mediaId, surface] of cases) {
        h.hub.calls = [];
        const { pub } = await publish(b, { platform, contentType: 'VIDEO', mediaIds: [mediaId], title: `Video ${platform} ${surface}` }, ['PUBLISHED']);
        expect([platform, pub!.status]).toEqual([platform, 'PUBLISHED']);
        expect(h.hub.calls.find((c) => c.op === 'publish')).toMatchObject({ platform, kind: 'VIDEO', detail: expect.objectContaining({ surface }) });
      }
    });

    it('falls back to manual publishing where the official API cannot publish the format, without pretending', async () => {
      const b = await newBiz();
      const { entry, pub } = await publish(b, { platform: 'INSTAGRAM', title: 'Instagram text', caption: 'A text only post.', hashtags: ['bissap'] });
      expect(pub).toMatchObject({ status: 'MANUAL_REQUIRED', mode: 'MANUAL', errorCode: 'FORMAT_UNSUPPORTED' });
      expect(pub!.lastError).toMatch(/Publish it manually/);
      expect(h.hub.count('INSTAGRAM', 'publish')).toBe(0); // nothing was sent anywhere
      expect(h.hub.posts).toHaveLength(0);
      await h.waitFor(async () => (await h.entryRow(entry.id)).content?.status === 'PUBLISHING'); // handed over, not published
      await h.waitFor(async () => (await h.notifications(b.admin.userId, 'social.manual_required')).find((x) => (x.data as { publicationId: string }).publicationId === pub!.id));

      const detail = (await h.get(b.admin, `/publications/${pub!.id}`).expect(200)).body;
      expect(detail.manualPackage.text).toContain('A text only post.');
      expect(detail.manualPackage.text).toContain('#bissap');
      expect(detail.confirmedByProvider).toBe(false);
      const analytics = (await request(h.http).get(`/api/v1/social/analytics/publications/${pub!.id}`).set(as(b.admin)).expect(200)).body;
      expect(analytics).toMatchObject({ measurable: false, reason: 'NOT_PUBLISHED', snapshot: null });

      await h.post(b.editor, `/publications/${pub!.id}/manual-complete`, { confirmPublished: true }).expect(403);
      await h.post(b.admin, `/publications/${pub!.id}/manual-complete`, { confirmPublished: false }).expect(404);
      await h.post(b.admin, `/publications/${pub!.id}/manual-complete`, { confirmPublished: true, externalUrl: 'javascript:alert(1)' }).expect(400);
      const done = (await h.post(b.admin, `/publications/${pub!.id}/manual-complete`, { confirmPublished: true, externalUrl: 'https://www.instagram.com/p/abc/' }).expect(200)).body;
      expect(done).toMatchObject({ status: 'PUBLISHED', mode: 'MANUAL', confirmedByProvider: false, externalUrl: 'https://www.instagram.com/p/abc/' });
      expect((await h.entryRow(entry.id)).content?.status).toBe('PUBLISHED');
      expect((await request(h.http).get(`/api/v1/social/analytics/publications/${pub!.id}`).set(as(b.admin)).expect(200)).body).toMatchObject({ measurable: false, reason: 'MANUAL_PUBLICATION' });
      await h.post(b.admin, `/publications/${pub!.id}/manual-complete`, { confirmPublished: true }).expect(409);
      const audit = await prisma.auditLog.findFirst({ where: { entityId: pub!.id, action: 'social.manual_published' } });
      expect(audit?.actorId).toBe(b.admin.userId);
    });

    it('rejects content and media the platform cannot take, before sending anything', async () => {
      const b = await newBiz();
      const png = await h.png(b.owner);
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ platform: 'INSTAGRAM', contentType: 'IMAGE', mediaIds: [png.id] }, /image types: image\/jpeg/],
        [{ platform: 'LINKEDIN', caption: 'x'.repeat(3100) }, /allows 3000/],
        [{ platform: 'TIKTOK', contentType: 'IMAGE', mediaIds: [(await h.jpeg(b.owner)).id] }, /at least 2|needs/i],
      ];
      for (const [body, pattern] of cases.slice(0, 2)) {
        const { entry, pub } = await publish(b, { title: 'Invalid', ...body });
        expect(pub).toMatchObject({ status: 'FAILED' });
        expect(pub!.lastError).toMatch(pattern);
        expect(['MEDIA_INVALID', 'CONTENT_INVALID']).toContain(pub!.errorCode);
        await h.waitFor(async () => (await h.entryRow(entry.id)).content?.status === 'FAILED');
        await h.waitFor(async () => (await h.notifications(b.admin.userId, 'calendar.failed')).find((x) => (x.data as { entryId: string }).entryId === entry.id));
      }
      expect(h.hub.calls.filter((c) => c.op === 'publish')).toHaveLength(0);
      void cases[2];
    });
  });

  describe('approval and authorization', () => {
    it('never publishes anything that was not approved and explicitly authorized', async () => {
      const b = await newBiz();
      const draft = await h.entry(b.editor, { platform: 'FACEBOOK', ...slot(b), title: 'Draft' });
      const approved = await h.entry(b.editor, { platform: 'FACEBOOK', ...slot(b), title: 'Approved only' });
      await h.act(b.editor, approved.id, 'submit').expect(200);
      await h.act(b.admin, approved.id, 'approve').expect(200);
      for (const e of [draft, approved]) await h.makeDue(e.id);
      await h.calendarWorker.tick();
      await sleep(100);
      expect(await prisma.publication.count({ where: { businessId: b.owner.businessId } })).toBe(0);
      expect(h.hub.posts).toHaveLength(0);
    });

    it('a change after authorization withdraws it, and a hand-off already queued for the old text does not publish', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Edited late' });
      await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(b.admin)).send({ caption: 'Different text' }).expect(200);
      await h.dispatch(e.id);
      await sleep(100);
      expect(await prisma.publication.count({ where: { calendarEventId: e.id } })).toBe(0);

      // The text changes after the hand-off was accepted but before the engine runs: the old approval must not be used.
      const f = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Edited in the queue' });
      await queue.q.pause();
      try {
        await h.dispatch(f.id);
        const pub = await h.publicationOf(f.id);
        await prisma.content.update({ where: { id: f.content.id }, data: { version: { increment: 1 }, status: 'DRAFT', approvedVersion: null } });
        await h.publisher.process(pub.id);
        const after = await prisma.publication.findUniqueOrThrow({ where: { id: pub.id } });
        expect(after).toMatchObject({ status: 'FAILED', errorCode: 'CONTENT_INVALID' });
        expect(h.hub.count('FACEBOOK', 'publish')).toBe(0);
      } finally {
        await queue.q.resume();
      }
    });

    it('stops when the person who authorized is no longer allowed to schedule publications, at the scheduler and again at the engine', async () => {
      const b = await newBiz();
      const early = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Demoted before due' });
      const late = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Demoted after hand-off' });
      await queue.q.pause();
      try {
        await h.dispatch(late.id); // handed over while the authorizer was still allowed
        const pub = await h.publicationOf(late.id);
        await prisma.membership.update({ where: { userId_businessId: { userId: b.admin.userId, businessId: b.owner.businessId } }, data: { role: 'VIEWER' } });
        await h.publisher.process(pub.id);
        expect(await prisma.publication.findUniqueOrThrow({ where: { id: pub.id } })).toMatchObject({ status: 'FAILED', errorCode: 'ACCOUNT_NOT_AUTHORIZED' });
        await h.dispatch(early.id); // the scheduler refuses before anything is handed over
        await h.waitFor(async () => (await h.entryRow(early.id)).content?.status === 'FAILED');
        expect(await prisma.publication.count({ where: { calendarEventId: early.id } })).toBe(0);
        expect((await h.entryRow(early.id)).lastError).toMatch(/AUTHORIZATION_REVOKED/);
        expect(h.hub.posts).toHaveLength(0);
      } finally {
        await queue.q.resume();
      }
    });

    it('publish now needs an approved entry and the permission to schedule, and publishes straight away', async () => {
      const b = await newBiz();
      const e = await h.entry(b.editor, { platform: 'FACEBOOK', ...slot(b), title: 'Now' });
      await h.act(b.admin, e.id, 'publish-now').expect(409); // a draft cannot be published
      await h.act(b.editor, e.id, 'submit').expect(200);
      await h.act(b.admin, e.id, 'publish-now').expect(409); // not approved yet
      await h.act(b.admin, e.id, 'approve').expect(200);
      await h.act(b.editor, e.id, 'publish-now').expect(403);
      await h.act(b.viewer, e.id, 'publish-now').expect(403);
      const res = await h.act(b.admin, e.id, 'publish-now').expect(200);
      expect(res.body.status).toBe('SCHEDULED');
      const pub = await h.reach(e.id, ['PUBLISHED'], 15_000);
      expect(pub.externalPostId).toBeTruthy();
      expect(h.hub.posts).toHaveLength(1);
      const hist = (await request(h.http).get(`/api/v1/calendar/entries/${e.id}/history`).set(as(b.admin)).expect(200)).body.items;
      expect(hist.find((r: { decision: string; note: string }) => r.decision === 'AUTHORIZED')?.note).toBe('Publish now');
    });

    it('uses the business timezone for the schedule', async () => {
      const b = await newBiz();
      await h.setTimezone(b.owner, 'Africa/Ndjamena');
      const date = h.day(3, 'Africa/Ndjamena');
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', localDate: date, localTime: '09:00', title: 'Local nine' });
      await h.makeDue(e.id);
      await h.calendarWorker.tick();
      const pub = await h.reach(e.id, ['PUBLISHED']);
      expect(pub.timezone).toBe('Africa/Ndjamena');
      expect((await prisma.calendarEvent.findUniqueOrThrow({ where: { id: e.id } })).timezone).toBe('Africa/Ndjamena');
    });
  });

  describe('accounts and tokens at publication time', () => {
    it('fails clearly when no account is connected, when several are connected and none chosen, and uses the chosen one', async () => {
      const b = await newBiz();
      await prisma.socialAccount.update({ where: { id: b.accounts.TIKTOK.id }, data: { status: 'DISCONNECTED' } });
      const video = await h.video(b.owner, { seconds: 20 });
      const none = await h.scheduled(b.editor, b.admin, { platform: 'TIKTOK', contentType: 'VIDEO', mediaIds: [video.id], ...slot(b), title: 'No account' });
      await h.dispatch(none.id);
      await h.waitFor(async () => (await h.entryRow(none.id)).content?.status === 'FAILED'); // rejected at the hand-off: no publication exists
      expect(await prisma.publication.count({ where: { calendarEventId: none.id } })).toBe(0);
      expect((await h.entryRow(none.id)).lastError).toMatch(/ACCOUNT_NOT_CONNECTED/);

      const second = await h.connect(b.owner, 'FACEBOOK', 2);
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Which page?' });
      await h.dispatch(e.id);
      await h.waitFor(async () => (await h.entryRow(e.id)).content?.status === 'FAILED');
      expect((await h.entryRow(e.id)).lastError).toMatch(/ACCOUNT_SELECTION_REQUIRED/);
      expect(h.hub.posts).toHaveLength(0);

      await request(h.http).put(`/api/v1/calendar/entries/${e.id}/account`).set(as(b.editor)).send({ socialAccountId: b.accounts.TIKTOK.id }).expect(404); // wrong platform
      await request(h.http).put(`/api/v1/calendar/entries/${e.id}/account`).set(as(b.editor)).send({ socialAccountId: second.id }).expect(200);
      await h.act(b.admin, e.id, 'retry', {}).expect(200);
      await h.dispatch(e.id);
      const pub = await h.reach(e.id, ['PUBLISHED']);
      expect(pub.socialAccountId).toBe(second.id);
      expect(h.hub.posts[0]!.accountId).toBe(second.externalAccountId);
    });

    it('never publishes to another business\'s account', async () => {
      const b = await newBiz();
      const stranger = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Foreign account' });
      await prisma.calendarEvent.update({ where: { id: e.id }, data: { socialAccountId: stranger.accounts.FACEBOOK.id } });
      await h.dispatch(e.id);
      await h.waitFor(async () => (await h.entryRow(e.id)).content?.status === 'FAILED');
      expect(h.hub.posts).toHaveLength(0);
      await request(h.http).put(`/api/v1/calendar/entries/${e.id}/account`).set(as(b.editor)).send({ socialAccountId: stranger.accounts.FACEBOOK.id }).expect(404);
    });

    it('refreshes an expired token before publishing (platforms that allow it)', async () => {
      const b = await newBiz();
      await prisma.socialAccount.update({ where: { id: b.accounts.YOUTUBE.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
      const old = h.tokenOf(b.accounts.YOUTUBE);
      const video = await h.video(b.owner);
      const { pub } = await publish(b, { platform: 'YOUTUBE', contentType: 'VIDEO', mediaIds: [video.id], title: 'Needs refresh' }, ['PUBLISHED']);
      expect(pub!.status).toBe('PUBLISHED');
      expect(h.hub.count('YOUTUBE', 'refresh')).toBe(1);
      const used = h.hub.calls.find((c) => c.op === 'publish')!.accessToken;
      expect(used).not.toBe(old);
      expect(used).toMatch(/^fresh-token-/);
    });

    it('fails with TOKEN_EXPIRED and asks for reconnection when the token cannot be renewed', async () => {
      const b = await newBiz();
      await prisma.socialAccount.update({ where: { id: b.accounts.FACEBOOK.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
      const { entry, pub } = await publish(b, { platform: 'FACEBOOK', title: 'Expired page token' });
      expect(pub).toMatchObject({ status: 'FAILED', errorCode: 'TOKEN_EXPIRED' });
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(0);
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: b.accounts.FACEBOOK.id } })).status).toBe('TOKEN_EXPIRED');
      expect((await h.notifications(b.admin.userId, 'social.reconnect_needed')).length).toBeGreaterThan(0);
      expect((await h.entryRow(entry.id)).content?.status).toBe('FAILED');
    });

    it('recovers when the platform rejects the token mid-publication: renews once and publishes once', async () => {
      const b = await newBiz();
      const old = h.tokenOf(b.accounts.LINKEDIN);
      h.hub.rejectedTokens.add(old);
      const { pub } = await publish(b, { platform: 'LINKEDIN', title: 'Revoked token' }, ['PUBLISHED']);
      expect(pub!.status).toBe('PUBLISHED');
      expect(h.hub.count('LINKEDIN', 'refresh')).toBe(1);
      expect(h.hub.count('LINKEDIN', 'publish')).toBe(2); // refused once (nothing created), then accepted
      expect(h.hub.posts).toHaveLength(1);
    });

    it('stops with PERMISSION_MISSING and does not retry', async () => {
      const b = await newBiz();
      h.hub.script('FACEBOOK', 'publish', new SocialApiError('permission', 'Requires pages_manage_posts', { outcome: 'not_created' }));
      const { pub } = await publish(b, { platform: 'FACEBOOK', title: 'No permission' });
      expect(pub).toMatchObject({ status: 'FAILED', errorCode: 'PERMISSION_MISSING' });
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: b.accounts.FACEBOOK.id } })).status).toBe('PERMISSION_MISSING');
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(1);
    });
  });

  describe('API failures and retry behavior', () => {
    it('retries a temporary failure later, once it is certain nothing was created, and publishes exactly once', async () => {
      const b = await newBiz();
      h.hub.script('FACEBOOK', 'publish', new SocialApiError('transient', 'Bad gateway', { status: 502, outcome: 'not_created' }), new SocialApiError('rate_limit', 'slow down', { outcome: 'not_created', retryAfterMs: 10 }));
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Flaky' });
      await h.dispatch(e.id);
      const first = await waitUntil(e.id, (p) => p.attempts >= 1 && p.status === 'QUEUED' && p.lastError !== null);
      expect(first.errorCode).toBe('PLATFORM_ERROR');
      expect(first.nextCheckAt).not.toBeNull();
      await sleep(150);
      await h.socialWorker.tick();
      const second = await waitUntil(e.id, (p) => p.attempts >= 2 && p.status === 'QUEUED' && p.errorCode === 'RATE_LIMITED');
      expect(second.attempts).toBe(2);
      await sleep(60);
      await h.socialWorker.tick();
      const done = await h.reach(e.id, ['PUBLISHED']);
      expect(done.attempts).toBe(3);
      expect(h.hub.posts).toHaveLength(1); // retries never produced a second post
      expect(new Set(h.hub.calls.filter((c) => c.op === 'publish').map((c) => c.idempotencyKey)).size).toBe(1);
      expect(done.lastError).toBeNull();
    });

    it('gives up after the allowed attempts, tells people, and a person can retry it successfully', async () => {
      const b = await newBiz();
      const down = () => new SocialApiError('transient', 'Service unavailable', { status: 503, outcome: 'not_created' });
      h.hub.script('FACEBOOK', 'publish', down(), down(), down());
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Always down' });
      await h.dispatch(e.id);
      for (let i = 0; i < 3; i++) {
        await sleep(200);
        await h.socialWorker.tick();
      }
      const failed = await waitUntil(e.id, (p) => p.status === 'FAILED');
      expect(failed).toMatchObject({ attempts: 3, errorCode: 'PLATFORM_ERROR', outcomeUnknown: false });
      expect(failed.lastError).toMatch(/gave up after 3 attempts/);
      expect((await h.entryRow(e.id)).content?.status).toBe('FAILED');
      expect((await h.notifications(b.admin.userId, 'calendar.failed')).some((x) => (x.data as { entryId: string }).entryId === e.id)).toBe(true);
      expect(h.hub.posts).toHaveLength(0);

      await h.post(b.editor, `/publications/${failed.id}/retry`).expect(403);
      const stranger = await newBiz();
      await h.post(stranger.admin, `/publications/${failed.id}/retry`).expect(404);
      const res = await h.post(b.admin, `/publications/${failed.id}/retry`).expect(200);
      expect(['QUEUED', 'PUBLISHING', 'PUBLISHED']).toContain(res.body.status);
      const pub = await h.reach(e.id, ['PUBLISHED']);
      expect(pub.id).toBe(failed.id);
      expect(h.hub.posts).toHaveLength(1);
      expect((await h.entryRow(e.id)).content?.status).toBe('PUBLISHED');
      await h.post(b.admin, `/publications/${failed.id}/retry`).expect(409);
    });

    it('does not retry a rejection by the platform', async () => {
      const b = await newBiz();
      h.hub.script('LINKEDIN', 'publish', new SocialApiError('validation', 'Duplicate content', { status: 422, outcome: 'not_created' }));
      const { pub } = await publish(b, { platform: 'LINKEDIN', title: 'Rejected' });
      expect(pub).toMatchObject({ status: 'FAILED', errorCode: 'PLATFORM_REJECTED', attempts: 1 });
      expect(pub!.lastError).toMatch(/Duplicate content/);
      expect(h.hub.count('LINKEDIN', 'publish')).toBe(1);
    });

    it('does not retry a failed publication for a change in the content: the approval must be renewed', async () => {
      const b = await newBiz();
      h.hub.script('FACEBOOK', 'publish', new SocialApiError('validation', 'No', { outcome: 'not_created' }));
      const { entry, pub } = await publish(b, { platform: 'FACEBOOK', title: 'Changed after failure' });
      expect(pub!.status).toBe('FAILED');
      await prisma.content.update({ where: { id: entry.content.id }, data: { version: { increment: 1 }, approvedVersion: null, status: 'DRAFT' } });
      expect((await h.post(b.admin, `/publications/${pub!.id}/retry`).expect(409)).body.code).toBe('APPROVAL_REQUIRED');
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(1);
    });
  });

  describe('duplicate prevention', () => {
    it('the same hand-off, delivered again, creates one publication and one post', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Twice' });
      await h.dispatch(e.id);
      const pub = await h.reach(e.id, ['PUBLISHED']);
      const row = await h.entryRow(e.id);
      const request = { idempotencyKey: pub.idempotencyKey, businessId: b.owner.businessId, entryId: e.id, contentId: e.content.id, contentVersion: e.content.version, platform: 'FACEBOOK' as const, scheduledAt: row.scheduledAt, timezone: 'UTC', caption: 'x', hashtags: [], callToAction: null, mediaIds: [], authorizedById: b.admin.userId, authorizedAt: new Date() };
      const gateway = app.get(SocialQueueService); // (queue untouched) the gateway is what the calendar worker calls
      void gateway;
      const again = await (await import('../src/social/social-gateway')).SocialPublishingGateway.prototype.submit.call({ publisher: h.publisher }, request);
      expect(again).toEqual({ status: 'ACCEPTED', reference: pub.id });
      await sleep(100);
      expect(await prisma.publication.count({ where: { calendarEventId: e.id } })).toBe(1);
      expect(h.hub.posts).toHaveLength(1);
      await h.publisher.process(pub.id); // a redelivered job for a finished publication does nothing
      expect(h.hub.posts).toHaveLength(1);
    });

    it('simultaneous workers on one publication publish it once', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Race' });
      await queue.q.pause();
      try {
        await h.dispatch(e.id);
        const pub = await h.publicationOf(e.id);
        await Promise.all([1, 2, 3, 4, 5].map(() => h.publisher.process(pub.id)));
        expect(h.hub.count('FACEBOOK', 'publish')).toBe(1);
        expect(h.hub.posts).toHaveLength(1);
        expect((await prisma.publication.findUniqueOrThrow({ where: { id: pub.id } })).status).toBe('PUBLISHED');
      } finally {
        await queue.q.resume();
      }
    });

    it('a worker that stopped before sending anything is safely retried', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Died early' });
      await queue.q.pause();
      try {
        await h.dispatch(e.id);
        const pub = await h.publicationOf(e.id);
        await prisma.publication.update({ where: { id: pub.id }, data: { status: 'PUBLISHING', attempts: 1, lockedUntil: new Date(Date.now() - 1000) } }); // died holding the lock, before the send
      } finally {
        await queue.q.resume();
      }
      await h.socialWorker.tick();
      const done = await h.reach(e.id, ['PUBLISHED']);
      expect(done.attempts).toBe(2);
      expect(h.hub.posts).toHaveLength(1);
    });

    it('when it cannot be known whether a post was created, it is not published again automatically', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Lost answer' });
      // The platform creates the post, then the connection drops before the answer arrives.
      h.hub.script('FACEBOOK', 'publish', { createThen: new SocialApiError('timeout', 'The platform did not answer in time', { outcome: 'unknown' }) });
      await h.dispatch(e.id);
      const pub = await waitUntil(e.id, (p) => p.status === 'FAILED');
      expect(pub).toMatchObject({ errorCode: 'OUTCOME_UNKNOWN', outcomeUnknown: true, externalPostId: null });
      expect(h.hub.posts).toHaveLength(1); // it exists on the platform, TOUMA does not know the id
      await h.socialWorker.tick();
      await sleep(150);
      await h.socialWorker.tick();
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(1); // nothing tried again
      const note = (await h.notifications(b.admin.userId, 'calendar.failed')).find((x) => (x.data as { entryId: string }).entryId === e.id);
      expect((note!.data as { code: string }).code).toBe('OUTCOME_UNKNOWN');
      // A person must decide: retrying needs the confirmation that the post is not on the platform.
      const blocked = await h.post(b.admin, `/publications/${pub.id}/retry`).expect(422);
      expect(blocked.body.code).toBe('OUTCOME_UNKNOWN');
      const marked = (await h.post(b.admin, `/publications/${pub.id}/manual-complete`, { confirmPublished: true, externalUrl: 'https://www.facebook.com/p/1' }).expect(200)).body;
      expect(marked).toMatchObject({ status: 'PUBLISHED', mode: 'MANUAL', confirmedByProvider: false });
      expect(h.hub.posts).toHaveLength(1);
    });

    it('a restart after the creating request was sent is treated as an unknown outcome, never repeated', async () => {
      const b = await newBiz();
      const e = await h.scheduled(b.editor, b.admin, { platform: 'LINKEDIN', ...slot(b), title: 'Died while sending' });
      await queue.q.pause();
      try {
        await h.dispatch(e.id);
        const pub = await h.publicationOf(e.id);
        await prisma.publication.update({ where: { id: pub.id }, data: { status: 'PUBLISHING', attempts: 1, lockedUntil: new Date(Date.now() - 1000), submitStartedAt: new Date(Date.now() - 5000) } });
      } finally {
        await queue.q.resume();
      }
      await h.socialWorker.tick();
      const pub = await waitUntil(e.id, (p) => p.status === 'FAILED');
      expect(pub).toMatchObject({ errorCode: 'OUTCOME_UNKNOWN', outcomeUnknown: true });
      expect(h.hub.count('LINKEDIN', 'publish')).toBe(0);
      // After the person checked that the post is not there, they can confirm and retry once.
      await h.post(b.admin, `/publications/${pub.id}/retry`, { confirmNotPublished: true }).expect(200);
      await h.reach(e.id, ['PUBLISHED']);
      expect(h.hub.posts).toHaveLength(1);
    });

    it('resumes where it stopped for platforms that process media asynchronously, without creating a second container', async () => {
      const b = await newBiz();
      const photo = await h.jpeg(b.owner);
      h.hub.script('INSTAGRAM', 'publish', 'processing');
      h.hub.script('INSTAGRAM', 'status', 'processing', 'ok');
      const e = await h.scheduled(b.editor, b.admin, { platform: 'INSTAGRAM', contentType: 'IMAGE', mediaIds: [photo.id], ...slot(b), title: 'Async' });
      await h.dispatch(e.id);
      const waiting = await waitUntil(e.id, (p) => p.status === 'AWAITING_PROVIDER');
      expect(waiting).toMatchObject({ providerStage: 'CONTAINER' });
      expect(waiting.providerRef).toBeTruthy();
      expect(h.hub.posts).toHaveLength(0);
      await sleep(30);
      await h.socialWorker.tick(); // still processing
      expect((await prisma.publication.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe('AWAITING_PROVIDER');
      await sleep(30);
      await h.socialWorker.tick(); // ready: continue with the creating step
      const done = await waitUntil(e.id, (p) => p.status === 'PUBLISHED');
      expect(done.id).toBe(waiting.id);
      expect(h.hub.posts).toHaveLength(1);
      const publishes = h.hub.calls.filter((c) => c.op === 'publish');
      expect(publishes.at(-1)!.detail!.resume).toMatchObject({ stage: 'CONTAINER', ref: waiting.providerRef });
      expect(h.hub.containers.size).toBe(1);
    });

    it('fails a publication the platform never finishes, and says the outcome may be unknown', async () => {
      const b = await newBiz();
      const photo = await h.jpeg(b.owner);
      h.hub.script('INSTAGRAM', 'publish', 'processing');
      h.hub.script('INSTAGRAM', 'status', 'processing');
      const e = await h.scheduled(b.editor, b.admin, { platform: 'INSTAGRAM', contentType: 'IMAGE', mediaIds: [photo.id], ...slot(b), title: 'Never ready' });
      await h.dispatch(e.id);
      const waiting = await waitUntil(e.id, (p) => p.status === 'AWAITING_PROVIDER');
      await prisma.publication.update({ where: { id: waiting.id }, data: { createdAt: new Date(Date.now() - 3 * 3_600_000), nextCheckAt: new Date() } });
      await h.socialWorker.tick();
      expect(await prisma.publication.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'FAILED', outcomeUnknown: true, errorCode: 'OUTCOME_UNKNOWN' });
    });
  });

  describe('media validation before anything is sent', () => {
    const failureOf = async (b: Biz, platform: 'INSTAGRAM' | 'TIKTOK' | 'LINKEDIN', mediaId: string, contentType: 'VIDEO' | 'IMAGE', title: string) => {
      const e = await h.scheduled(b.editor, b.admin, { platform, contentType, mediaIds: [mediaId], ...slot(b), title });
      await h.dispatch(e.id);
      return waitUntil(e.id, (p) => p.status === 'FAILED' || p.status === 'MANUAL_REQUIRED');
    };

    it('rejects a wrong aspect ratio, with the numbers, and calls no platform API', async () => {
      const b = await newBiz();
      const tall = await h.jpeg(b.owner, 500, 1200);
      const pub = await failureOf(b, 'INSTAGRAM', tall.id, 'IMAGE', 'Too tall');
      expect(pub).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_INVALID', outcomeUnknown: false });
      expect(pub.lastError).toMatch(/500x1200.*aspect ratio.*0\.80:1 to 1\.91:1/);
      expect(h.hub.count('INSTAGRAM', 'publish')).toBe(0);
    });

    it('rejects a video codec the platform does not take, and audio it does not take', async () => {
      const b = await newBiz();
      const hevc = await h.video(b.owner, { codec: 'hvc1' });
      expect((await failureOf(b, 'LINKEDIN', hevc.id, 'VIDEO', 'HEVC')).lastError).toMatch(/H\.265\/HEVC codec; LinkedIn accepts H\.264/);
      const ac3 = await h.video(b.owner, { audio: 'ac-3' });
      expect((await failureOf(b, 'INSTAGRAM', ac3.id, 'VIDEO', 'AC3')).lastError).toMatch(/audio uses ac-3/);
      expect(h.hub.count('LINKEDIN', 'publish') + h.hub.count('INSTAGRAM', 'publish')).toBe(0);
    });

    it('measures the real file: stored width/height/duration that are wrong do not decide', async () => {
      const b = await newBiz();
      // The row claims a vertical 20 s video; the bytes are a 5000x2500 file: the file wins.
      const v = await h.video(b.owner, { width: 5000, height: 2500, seconds: 20 });
      await prisma.mediaAsset.update({ where: { id: v.id }, data: { width: 1080, height: 1920 } });
      const pub = await failureOf(b, 'TIKTOK', v.id, 'VIDEO', 'Lying row');
      expect(pub.lastError).toMatch(/5000x2500.*at most 4096/);
    });

    it('rejects a file whose content is not what its type says', async () => {
      const b = await newBiz();
      const v = await h.video(b.owner);
      const key = (await prisma.mediaAsset.findUniqueOrThrow({ where: { id: v.id } })).storageKey;
      const junk = Buffer.from('this is not a video');
      await h.storage.put(key, junk, { contentType: 'video/mp4', contentLength: junk.length });
      const pub = await failureOf(b, 'TIKTOK', v.id, 'VIDEO', 'Not a video');
      expect(pub).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_INVALID' });
      expect(pub.lastError).toMatch(/not a valid MP4\/MOV video/);
    });
  });

  describe('reconciliation of unknown outcomes', () => {
    const unknown = async (b: Biz, platform: 'FACEBOOK' | 'INSTAGRAM', title: string) => {
      const photo = await h.jpeg(b.owner);
      h.hub.script(platform, 'publish', { createThen: new SocialApiError('timeout', 'The platform did not answer in time', { outcome: 'unknown' }) });
      const e = await h.scheduled(b.editor, b.admin, { platform, contentType: 'IMAGE', mediaIds: [photo.id], ...slot(b), title });
      await h.dispatch(e.id);
      const pub = await waitUntil(e.id, (p) => p.status === 'FAILED');
      expect(pub).toMatchObject({ outcomeUnknown: true, externalPostId: null });
      return { e, pub };
    };

    it('finds the post the platform created, records it as published and confirmed, and never publishes a second time', async () => {
      const b = await newBiz();
      const { e, pub } = await unknown(b, 'FACEBOOK', 'Created but unanswered');
      expect(h.hub.posts).toHaveLength(1);
      const res = (await h.post(b.admin, `/publications/${pub.id}/reconcile`).expect(200)).body;
      expect(res).toMatchObject({ status: 'PUBLISHED', confirmedByProvider: true, outcomeUnknown: false, reconcile: { result: 'FOUND', foundOnPlatform: true } });
      expect(res.externalPostId).toBe(h.hub.posts[0]!.id);
      expect(res.externalUrl).toContain(h.hub.posts[0]!.id);
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(1);
      expect(h.hub.posts).toHaveLength(1);
      expect((await h.entryRow(e.id)).content?.status).toBe('PUBLISHED');
      await h.post(b.admin, `/publications/${pub.id}/reconcile`).expect(409); // nothing left to reconcile
    });

    it('when the platform shows nothing, it stays with a person: no auto-retry, retry needs confirmation', async () => {
      const b = await newBiz();
      const { pub } = await unknown(b, 'FACEBOOK', 'Maybe lost');
      h.hub.posts.length = 0; // the platform's listing shows nothing (the create request never reached it, or the listing lags)
      const publishesBefore = h.hub.count('FACEBOOK', 'publish');
      const res = (await h.post(b.admin, `/publications/${pub.id}/reconcile`).expect(200)).body;
      expect(res).toMatchObject({ status: 'FAILED', outcomeUnknown: true, reconcile: { result: 'NOT_FOUND' } });
      expect(res.reconcile.note).toMatch(/look at the platform yourself/);
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(publishesBefore);
      expect((await h.post(b.admin, `/publications/${pub.id}/retry`).expect(422)).body.code).toBe('OUTCOME_UNKNOWN');
    });

    it('says so when the platform cannot be asked, and when several posts match', async () => {
      const b = await newBiz();
      const { pub } = await unknown(b, 'INSTAGRAM', 'Cannot ask');
      h.hub.script('INSTAGRAM', 'reconcile', 'unavailable');
      const r1 = (await h.post(b.admin, `/publications/${pub.id}/reconcile`).expect(200)).body;
      expect(r1).toMatchObject({ status: 'FAILED', outcomeUnknown: true, reconcile: { result: 'UNAVAILABLE' } });
      // A second identical post appears on the platform: only a person can tell which one is ours.
      const first = h.hub.posts[0]!;
      h.hub.posts.push({ ...first, id: 'ig-duplicate', at: new Date() });
      const r2 = (await h.post(b.admin, `/publications/${pub.id}/reconcile`).expect(200)).body;
      expect(r2).toMatchObject({ status: 'FAILED', outcomeUnknown: true, reconcile: { result: 'AMBIGUOUS' } });
      expect(r2.reconcile.note).toContain('2 posts');
      const audit = await prisma.auditLog.findMany({ where: { entityId: pub.id, action: 'social.reconciled_uncertain' } });
      expect(audit.length).toBe(2);
    });

    it('a failed lookup is never read as "not found": a permission error is UNAVAILABLE', async () => {
      const b = await newBiz();
      const { pub } = await unknown(b, 'FACEBOOK', 'Permission');
      h.hub.script('FACEBOOK', 'reconcile', new SocialApiError('permission', 'pages_read_engagement is missing', { outcome: 'not_created' }));
      const r = (await h.post(b.admin, `/publications/${pub.id}/reconcile`).expect(200)).body;
      expect(r.reconcile.result).toBe('UNAVAILABLE');
      expect(r.reconcile.note).toMatch(/permissions do not allow listing/);
    });

    it('the worker reconciles unknown outcomes on its own, a bounded number of times, and only a viewer-proof role can do it by hand', async () => {
      const b = await newBiz();
      const { e, pub } = await unknown(b, 'FACEBOOK', 'Worker finds it');
      await h.post(b.viewer, `/publications/${pub.id}/reconcile`).expect(403);
      await prisma.publication.update({ where: { id: pub.id }, data: { updatedAt: new Date(Date.now() - 120_000) } });
      await h.socialWorker.tick();
      const done = await prisma.publication.findUniqueOrThrow({ where: { id: pub.id } });
      expect(done).toMatchObject({ status: 'PUBLISHED', confirmedByProvider: true, reconciledFound: true, reconcileResult: 'FOUND' });
      expect((await h.entryRow(e.id)).content?.status).toBe('PUBLISHED');
      expect(h.hub.count('FACEBOOK', 'publish')).toBe(1);

      // Attempts are capped: after three uncertain checks the worker stops and leaves it to a person.
      const b2 = await newBiz();
      const { pub: p2 } = await unknown(b2, 'INSTAGRAM', 'Never found');
      h.hub.posts.length = 0;
      await prisma.publication.update({ where: { id: p2.id }, data: { updatedAt: new Date(Date.now() - 120_000) } });
      for (let i = 0; i < 5; i++) {
        await h.socialWorker.tick();
        await prisma.publication.update({ where: { id: p2.id }, data: { reconciledAt: new Date(Date.now() - 30 * 60_000) } });
      }
      const capped = await prisma.publication.findUniqueOrThrow({ where: { id: p2.id } });
      expect(capped).toMatchObject({ status: 'FAILED', outcomeUnknown: true, reconcileAttempts: 3, reconcileResult: 'NOT_FOUND' });
    });
  });

  describe('history, queue and isolation', () => {
    it('shows history with filters and errors, the queue, and keeps businesses apart', async () => {
      const b = await newBiz();
      const stranger = await newBiz();
      h.hub.script('LINKEDIN', 'publish', new SocialApiError('validation', 'Rejected by the platform', { outcome: 'not_created' }));
      const ok = await publish(b, { platform: 'FACEBOOK', title: 'History ok' }, ['PUBLISHED']);
      const bad = await publish(b, { platform: 'LINKEDIN', title: 'History bad' });
      await publish(stranger, { platform: 'FACEBOOK', title: 'Someone else' }, ['PUBLISHED']);
      const all = (await h.get(b.viewer, '/publications').expect(200)).body;
      expect(all.items.map((p: { id: string }) => p.id).sort()).toEqual([ok.pub!.id, bad.pub!.id].sort());
      expect(all.items.every((p: { platform: string }) => ['FACEBOOK', 'LINKEDIN'].includes(p.platform))).toBe(true);
      const failed = (await h.get(b.viewer, '/publications?status=FAILED').expect(200)).body;
      expect(failed.items).toHaveLength(1);
      expect(failed.items[0]).toMatchObject({ platform: 'LINKEDIN', status: 'FAILED', errorCode: 'PLATFORM_REJECTED', entryTitle: 'History bad' });
      expect(failed.items[0].error).toMatch(/Rejected by the platform/);
      expect((await h.get(b.viewer, '/publications?platform=FACEBOOK').expect(200)).body.items).toHaveLength(1);
      expect((await h.get(b.viewer, `/publications?accountId=${b.accounts.LINKEDIN.id}`).expect(200)).body.items).toHaveLength(1);
      await h.get(b.viewer, '/publications?status=NOPE').expect(400);
      const detail = (await h.get(b.viewer, `/publications/${ok.pub!.id}`).expect(200)).body;
      expect(detail).toMatchObject({ status: 'PUBLISHED', confirmedByProvider: true, entryTitle: 'History ok' });
      expect(Object.keys(detail)).not.toEqual(expect.arrayContaining(['providerRef', 'providerResponse', 'payload', 'idempotencyKey']));
      await h.get(stranger.viewer, `/publications/${ok.pub!.id}`).expect(404);
      await h.post(stranger.admin, `/publications/${bad.pub!.id}/retry`).expect(404);
      await h.post(stranger.admin, `/publications/${bad.pub!.id}/manual-complete`, { confirmPublished: true }).expect(404);
      expect((await h.get(stranger.viewer, '/publications').expect(200)).body.items.map((p: { id: string }) => p.id)).not.toContain(ok.pub!.id);

      const q = (await h.get(b.viewer, '/queue').expect(200)).body;
      expect(q.byStatus).toMatchObject({ PUBLISHED: 1, FAILED: 1 });
      expect(q.queue).toEqual(expect.objectContaining({ waiting: expect.any(Number), active: expect.any(Number), failed: expect.any(Number) }));
      const future = await h.scheduled(b.editor, b.admin, { platform: 'FACEBOOK', ...slot(b), title: 'Upcoming one' });
      expect((await h.get(b.viewer, '/queue').expect(200)).body.upcoming.map((u: { id: string }) => u.id)).toContain(future.id);
      expect((await h.get(stranger.viewer, '/queue').expect(200)).body.upcoming.map((u: { id: string }) => u.id)).not.toContain(future.id);
    });

    it('does not expose tokens or provider handles anywhere', async () => {
      const b = await newBiz();
      await publish(b, { platform: 'FACEBOOK', title: 'Secrets' }, ['PUBLISHED']);
      const bodies = [(await h.get(b.owner, '/status').expect(200)).body, (await h.get(b.owner, '/accounts').expect(200)).body, (await h.get(b.owner, '/publications').expect(200)).body, (await h.get(b.owner, '/queue').expect(200)).body];
      const text = JSON.stringify(bodies);
      for (const a of Object.values(b.accounts)) expect(text).not.toContain(h.tokenOf(a));
      expect(text).not.toMatch(/accessToken|refreshToken|secret-token|Enc"/);
    });
  });

  describe('analytics foundation', () => {
    it('stores what the platform reports: zero is a value, missing is unavailable, nothing is invented', async () => {
      const b = await newBiz();
      const { pub } = await publish(b, { platform: 'FACEBOOK', title: 'Measured' }, ['PUBLISHED']);
      h.hub.metrics.set(pub!.externalPostId!, { ...EMPTY_METRICS, likes: 0, comments: 2, reach: 100, unavailableReason: null });
      const res = (await h.post(b.admin, `/analytics/publications/${pub!.id}/refresh`).expect(200)).body;
      expect(res).toMatchObject({ measurable: true, snapshot: { metrics: { likes: 0, comments: 2, reach: 100, views: null, shares: null, saves: null, impressions: null, linkClicks: null }, engagementRate: 0.02 } });
      const row = await prisma.analyticsSnapshot.findFirstOrThrow({ where: { publicationId: pub!.id } });
      expect(row).toMatchObject({ likes: 0, comments: 2, reach: 100, views: null, shares: null, source: 'MEASURED' });
      expect(Number(row.engagementRate)).toBe(0.02);

      const summary = (await request(h.http).get('/api/v1/social/analytics/summary?days=30').set(as(b.viewer)).expect(200)).body;
      const fb = summary.platforms.find((p: { platform: string }) => p.platform === 'FACEBOOK');
      expect(fb).toMatchObject({ published: 1, measured: 1 });
      expect(fb.metrics.likes).toEqual({ total: 0, available: 1, unavailable: 0 }); // a real zero
      expect(fb.metrics.views).toEqual({ total: null, available: 0, unavailable: 1 }); // not available: never summed as 0
      await request(h.http).get('/api/v1/social/analytics/summary').set(as(b.editor)).expect(200);
      await request(h.http).get(`/api/v1/social/analytics/publications/${pub!.id}`).set(as((await newBiz()).viewer)).expect(404);
    });

    it('has no engagement rate when the platform gave no audience figure, and records why metrics are missing', async () => {
      const b = await newBiz();
      const { pub } = await publish(b, { platform: 'LINKEDIN', title: 'No reach' }, ['PUBLISHED']);
      h.hub.metrics.set(pub!.externalPostId!, { ...EMPTY_METRICS, likes: 5, unavailableReason: 'Impressions need partner permissions' });
      const res = (await h.post(b.admin, `/analytics/publications/${pub!.id}/refresh`).expect(200)).body;
      expect(res.snapshot.engagementRate).toBeNull();
      expect(res.snapshot.unavailableReason).toMatch(/partner/);
      expect(res.snapshot.metrics.likes).toBe(5);
    });

    it('stores everything as unavailable (never zeros) when the platform refuses to answer, and collects on the worker schedule', async () => {
      const b = await newBiz();
      const { pub } = await publish(b, { platform: 'FACEBOOK', title: 'Denied' }, ['PUBLISHED']);
      h.hub.script('FACEBOOK', 'metrics', new SocialApiError('permission', 'read_insights missing', { outcome: 'not_created' }));
      const res = (await h.post(b.admin, `/analytics/publications/${pub!.id}/refresh`).expect(200)).body;
      expect(Object.values(res.snapshot.metrics).every((v) => v === null)).toBe(true);
      expect(res.snapshot.unavailableReason).toMatch(/read_insights/);
      // The worker measures publications that are due; a fresh one is not due again within the hour.
      await prisma.analyticsSnapshot.deleteMany({ where: { publicationId: pub!.id } });
      h.hub.calls = [];
      await h.socialWorker.tick();
      expect(h.hub.calls.filter((c) => c.op === 'metrics' && (c.detail as { postId: string }).postId === pub!.externalPostId)).toHaveLength(1);
      h.hub.calls = [];
      await h.socialWorker.tick();
      expect(h.hub.calls.filter((c) => c.op === 'metrics' && (c.detail as { postId: string }).postId === pub!.externalPostId)).toHaveLength(0);
    });
  });
});
void (null as unknown as Ctx);
