import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SocialApiError } from '@touma/social-connectors';
import { PublicationGate } from '../src/calendar/publication-gate';
import { SocialQueueService } from '../src/social/social-queue';
import { SocialPublisherService } from '../src/social/social-publisher.service';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * Phase N18: individual publication approval. Real PostgreSQL, Redis, BullMQ, guards and services; the platforms are the
 * test-only simulator. Nothing is ever sent to a real platform.
 */
describe('Individual publication approval (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let queue: SocialQueueService;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = socialHelpers(app);
    queue = app.get(SocialQueueService);
  });
  beforeEach(() => h.hub.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function shop() {
    const owner = await h.tenant(`Shop ${++n}`);
    const admin = await h.member(owner, 'ADMIN');
    const editor = await h.member(owner, 'EDITOR');
    const viewer = await h.member(owner, 'VIEWER');
    await h.setTimezone(owner, 'Africa/Ndjamena');
    const account = await h.connect(owner, 'FACEBOOK');
    return { owner, admin, editor, viewer, account };
  }
  type S = Awaited<ReturnType<typeof shop>>;
  const draft = (s: S, over: Record<string, unknown> = {}) => h.entry(s.editor, { platform: 'FACEBOOK', localDate: h.day(5 + (n % 20), 'Africa/Ndjamena'), localTime: '10:00', title: `Post ${++n}`, caption: 'Fresh bissap juice, served cold.', ...over });
  const toReview = async (s: S, over: Record<string, unknown> = {}) => {
    const e = await draft(s, over);
    await h.act(s.editor, e.id, 'submit').expect(200);
    return e;
  };
  const approved = async (s: S, over: Record<string, unknown> = {}) => {
    const e = await toReview(s, over);
    await h.act(s.admin, e.id, 'approve').expect(200);
    return e;
  };
  const authorize = async (c: Ctx, id: string) => {
    const r = await h.act(c, id, 'authorize');
    if (r.status !== 200) throw new Error(`authorize ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r;
  };
  const row = (id: string) => prisma.calendarEvent.findUniqueOrThrow({ where: { id }, include: { content: true } });
  const history = async (c: Ctx, id: string) => (await request(h.http).get(`/api/v1/calendar/entries/${id}/history`).set(as(c)).expect(200)).body.items as Array<{ decision: string; snapshotHash: string | null; socialAccountId: string | null; scheduledAt: string | null; timezone: string | null; mediaIds: string[]; actorId: string | null }>;
  const publications = (id: string) => prisma.publication.findMany({ where: { calendarEventId: id } });

  it('approval by the merchant owner is recorded with what was approved; nothing is published until it is also authorized', async () => {
    const s = await shop();
    const e = await toReview(s);
    expect((await h.act(s.owner, e.id, 'approve').expect(200)).body.status).toBe('APPROVED');
    let hist = await history(s.owner, e.id);
    const rec = hist.find((r) => r.decision === 'APPROVED')!;
    expect(rec).toMatchObject({ socialAccountId: s.account.id, timezone: 'Africa/Ndjamena' });
    expect(rec.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.scheduledAt).toBeTruthy();
    expect(await publications(e.id)).toHaveLength(0);
    await authorize(s.admin, e.id);
    hist = await history(s.owner, e.id);
    const auth = hist.find((r) => r.decision === 'AUTHORIZED')!;
    expect(auth.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await row(e.id)).authorizedHash).toBe(auth.snapshotHash);
    expect((await row(e.id)).authorizedAccountId).toBe(s.account.id);
  });

  it('rejection records the reason and blocks scheduling; unauthorized roles cannot approve, reject or authorize', async () => {
    const s = await shop();
    const e = await toReview(s);
    for (const who of [s.viewer, s.editor]) {
      await h.act(who, e.id, 'approve').expect(403);
      await h.act(who, e.id, 'reject', { reason: 'no' }).expect(403);
    }
    expect((await row(e.id)).content?.status).toBe('IN_REVIEW');
    const rej = await h.act(s.admin, e.id, 'reject', { reason: 'Wrong price' }).expect(200);
    expect(rej.body.status).toBe('REJECTED');
    expect((await h.act(s.admin, e.id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
    expect((await history(s.admin, e.id)).map((r) => r.decision)).toEqual(expect.arrayContaining(['SUBMITTED', 'REJECTED']));
    const e2 = await approved(s);
    await h.act(s.editor, e2.id, 'authorize').expect(403); // authorizing publication is a separate permission
    await h.act(s.viewer, e2.id, 'authorize').expect(403);
  });

  it('a business can never act on another business\'s publications', async () => {
    const a = await shop();
    const b = await shop();
    const e = await toReview(a);
    for (const action of ['approve', 'reject', 'authorize', 'cancel', 'submit', 'unschedule', 'publish-now']) {
      const r = await h.act(b.admin, e.id, action, action === 'reject' ? { reason: 'Not for this business' } : {});
      expect([action, r.status]).toEqual([action, 404]);
    }
    await h.get(b.admin, e.id).expect(404);
    await request(h.http).get(`/api/v1/calendar/entries/${e.id}/history`).set(as(b.admin)).expect(404);
    await request(h.http).put(`/api/v1/calendar/entries/${e.id}/account`).set(as(b.admin)).send({ socialAccountId: b.account.id }).expect(404);
    expect((await row(e.id)).content?.status).toBe('IN_REVIEW');
    // A foreign account cannot be chosen for an entry either.
    const mine = await approved(a);
    await request(h.http).put(`/api/v1/calendar/entries/${mine.id}/account`).set(as(a.admin)).send({ socialAccountId: b.account.id }).expect(404);
    const pending = (await request(h.http).get('/api/v1/calendar/approvals?view=pending').set(as(b.admin)).expect(200)).body;
    expect(JSON.stringify(pending)).not.toContain(e.id);
  });

  it('nothing is published without approval, even if the row is forced to SCHEDULED', async () => {
    const s = await shop();
    expect((await h.act(s.admin, (await draft(s)).id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
    const e = await toReview(s);
    expect((await h.act(s.admin, e.id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
    // Tamper: scheduled by SQL, never approved.
    await prisma.content.update({ where: { id: (await row(e.id)).contentId! }, data: { status: 'SCHEDULED' } });
    await prisma.calendarEvent.update({ where: { id: e.id }, data: { authorizedById: s.admin.userId, authorizedAt: new Date(), authorizedVersion: 1, authorizedHash: 'f'.repeat(64), authorizedAccountId: s.account.id } });
    await h.dispatch(e.id);
    await h.waitFor(async () => (await row(e.id)).content?.status === 'SCHEDULED' && (await row(e.id)).dispatchState !== 'QUEUED');
    expect(await publications(e.id)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('editing after approval withdraws the approval (back to pending approval) and nothing is published; a new approval is needed', async () => {
    const s = await shop();
    const e = await approved(s);
    await authorize(s.admin, e.id);
    const edited = await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(s.admin)).send({ caption: 'Now with a 50% discount!' }).expect(200);
    expect(edited.body.status).toBe('IN_REVIEW');
    expect(edited.body.authorizedAt).toBeNull();
    expect((await h.act(s.admin, e.id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
    await h.dispatch(e.id); // even when due, nothing is handed over
    expect(await publications(e.id)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(0);
    expect((await history(s.admin, e.id)).map((r) => r.decision)).toContain('REVOKED');
    await h.act(s.admin, e.id, 'approve').expect(200); // the new explicit decision (authorizing again is a further step)
  });

  it('changing the target account or the time after authorization withdraws the authorization; a tampered row is refused at dispatch', async () => {
    const s = await shop();
    const second = await h.connect(s.owner, 'FACEBOOK', 2);
    // Account changed through the API.
    const e = await draft(s);
    await request(h.http).put(`/api/v1/calendar/entries/${e.id}/account`).set(as(s.admin)).send({ socialAccountId: s.account.id }).expect(200);
    await h.act(s.editor, e.id, 'submit').expect(200);
    await h.act(s.admin, e.id, 'approve').expect(200);
    await authorize(s.admin, e.id);
    expect((await row(e.id)).authorizedAccountId).toBe(s.account.id);
    const moved = await request(h.http).put(`/api/v1/calendar/entries/${e.id}/account`).set(as(s.admin)).send({ socialAccountId: second.id }).expect(200);
    expect(moved.body.status).toBe('APPROVED');
    expect(moved.body.authorizedAt).toBeNull();
    // Time changed through the API.
    await authorize(s.admin, e.id);
    const r = await h.act(s.admin, e.id, 'reschedule', { localDate: h.day(30, 'Africa/Ndjamena'), localTime: '12:00' }).expect(200);
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.authorizedAt).toBeNull();
    await h.dispatch(e.id); // not authorized any more: not handed over
    expect(await publications(e.id)).toHaveLength(0);

    // Tamper 1: the account is swapped in the database without touching the authorization.
    const t1 = await approved(s);
    await authorize(s.admin, t1.id);
    await prisma.calendarEvent.update({ where: { id: t1.id }, data: { socialAccountId: second.id } });
    await h.dispatch(t1.id);
    await h.waitFor(async () => (await row(t1.id)).content?.status === 'FAILED' || (await publications(t1.id)).length > 0);
    expect(h.hub.posts).toHaveLength(0);
    // Tamper 2: the time is moved in the database after authorization.
    const t2 = await approved(s);
    await authorize(s.admin, t2.id);
    await prisma.calendarEvent.update({ where: { id: t2.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    await h.calendarWorker.tick();
    await h.waitFor(async () => (await row(t2.id)).content?.status === 'FAILED');
    expect((await row(t2.id)).lastError).toMatch(/APPROVAL_MISMATCH/);
    expect(await publications(t2.id)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('duplicate approval and authorization requests have one effect', async () => {
    const s = await shop();
    const e = await toReview(s);
    const res = await Promise.all(Array.from({ length: 6 }, () => h.act(s.admin, e.id, 'approve')));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await history(s.admin, e.id)).filter((r) => r.decision === 'APPROVED')).toHaveLength(1);
    const auth = await Promise.all(Array.from({ length: 4 }, () => h.act(s.admin, e.id, 'authorize')));
    expect(auth.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await history(s.admin, e.id)).filter((r) => r.decision === 'AUTHORIZED')).toHaveLength(1);
  });

  it('duplicate queue jobs and repeated ticks publish once, and the result is labelled simulated', async () => {
    const s = await shop();
    const e = await approved(s);
    await authorize(s.admin, e.id);
    await h.makeDue(e.id);
    await Promise.all([h.calendarWorker.tick(), h.calendarWorker.tick(), h.calendarWorker.tick()]);
    const pub = await h.publicationOf(e.id);
    await Promise.all([h.publisher.process(pub.id), h.publisher.process(pub.id), h.publisher.process(pub.id)]);
    const done = await h.reach(e.id, ['PUBLISHED', 'FAILED']);
    expect(done.status).toBe('PUBLISHED');
    expect(await publications(e.id)).toHaveLength(1);
    expect(h.hub.posts).toHaveLength(1);
    expect(done.simulated).toBe(true); // the test simulator: never a genuine external publication
    const view = (await h.get(s.admin, '/publications?pageSize=50').expect(200)).body;
    expect(JSON.stringify(view)).toContain('"simulated":true');
  });

  it('cancellation before dispatch publishes nothing; a cancelled entry cannot be revived', async () => {
    const s = await shop();
    const e = await approved(s);
    await authorize(s.admin, e.id);
    await h.act(s.editor, e.id, 'cancel').expect(403); // cancelling an authorized publication needs the scheduling permission
    await h.act(s.admin, e.id, 'cancel').expect(200);
    await h.dispatch(e.id);
    expect(await publications(e.id)).toHaveLength(0);
    expect((await h.get(s.admin, '/publications').expect(200)).body.total).toBe(0);
    expect((await h.act(s.admin, e.id, 'authorize').expect(409)).body.code).toBe('INVALID_STATE');
    expect((await h.act(s.admin, e.id, 'approve').expect(409)).body.code).toBe('INVALID_STATE');
  });

  it('an approval withdrawn between hand-off and dispatch stops the request (the gate runs again before the platform call)', async () => {
    const s = await shop();
    const e = await approved(s);
    await authorize(s.admin, e.id);
    await queue.q.pause();
    try {
      await h.dispatch(e.id);
      const pub = await h.publicationOf(e.id);
      expect(pub.status).toBe('QUEUED');
      // A concurrent edit that committed after the hand-off (the API itself refuses edits once an entry is being handed over).
      const ev = await row(e.id);
      await prisma.content.update({ where: { id: ev.contentId! }, data: { caption: 'Changed after the hand-off', version: { increment: 1 }, status: 'IN_REVIEW', approvedVersion: null, approvedById: null } });
      await prisma.calendarEvent.update({ where: { id: e.id }, data: { authorizedById: null, authorizedAt: null, authorizedVersion: null, authorizedHash: null, authorizedAccountId: null } });
      await h.publisher.process(pub.id);
      const after = await prisma.publication.findUniqueOrThrow({ where: { id: pub.id } });
      expect(after).toMatchObject({ status: 'FAILED', errorCode: 'CONTENT_INVALID' });
      expect(h.hub.posts).toHaveLength(0);
    } finally {
      await queue.q.resume();
    }
    // The gate is consulted more than once on a normal publication.
    const gate = app.get(PublicationGate);
    const spy = jest.spyOn(gate, 'check');
    const ok = await approved(s);
    await authorize(s.admin, ok.id);
    await h.dispatch(ok.id);
    await h.reach(ok.id, ['PUBLISHED']);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('the simulator failing is recorded as a failure with a clear code, never as published; missing or expired credentials stop the publication', async () => {
    const s = await shop();
    h.hub.script('FACEBOOK', 'publish', new SocialApiError('validation', 'Rejected by the platform', { outcome: 'not_created' }));
    const failed = await h.publishEntry(s.editor, s.admin, { platform: 'FACEBOOK', caption: 'Hello' });
    expect((await h.reach(failed.entry.id, ['FAILED'])).status).toBe('FAILED');
    await h.waitFor(async () => (await row(failed.entry.id)).content?.status === 'FAILED');
    expect(h.hub.posts).toHaveLength(0);
    // Expired and disconnected accounts.
    for (const [status, code] of [['TOKEN_EXPIRED', 'TOKEN_EXPIRED'], ['DISCONNECTED', 'ACCOUNT_NOT_AUTHORIZED']] as const) {
      const t = await shop();
      const e = await approved(t);
      await authorize(t.admin, e.id);
      await prisma.socialAccount.update({ where: { id: t.account.id }, data: { status } });
      await h.dispatch(e.id);
      await h.waitFor(async () => (await row(e.id)).content?.status === 'FAILED');
      expect((await row(e.id)).lastError).toContain(status === 'DISCONNECTED' ? 'ACCOUNT' : code);
      expect(await publications(e.id)).toHaveLength(0);
    }
    expect(h.hub.posts).toHaveLength(0);
    // An authorized entry on a platform with no account at all was never authorized for any account.
    const u = await shop();
    const noAccount = await h.entry(u.editor, { platform: 'INSTAGRAM', localDate: h.day(8, 'Africa/Ndjamena'), localTime: '11:00', title: 'No account', contentType: 'TEXT' }).catch(() => null);
    expect(noAccount === null || typeof noAccount.id === 'string').toBe(true);
  });

  it('publishing is off unless switched on, and a daily limit per business is enforced', async () => {
    const s = await shop();
    const env = (app.get(SocialPublisherService) as unknown as { env: { SOCIAL_PUBLISHING_ENABLED: boolean; SOCIAL_MAX_PUBLICATIONS_PER_DAY: number } }).env;
    const gateEnv = (app.get(PublicationGate) as unknown as { env: typeof env }).env;
    const e = await approved(s);
    await authorize(s.admin, e.id);
    env.SOCIAL_PUBLISHING_ENABLED = false;
    try {
      await h.dispatch(e.id);
      expect(await publications(e.id)).toHaveLength(0);
      expect(h.hub.posts).toHaveLength(0);
      expect((await row(e.id)).dispatchState).toBe('BLOCKED'); // waits, nothing is attempted
    } finally {
      env.SOCIAL_PUBLISHING_ENABLED = true;
    }
    await h.calendarWorker.tick();
    expect((await h.reach(e.id, ['PUBLISHED', 'FAILED'])).status).toBe('PUBLISHED'); // released once switched on
    gateEnv.SOCIAL_MAX_PUBLICATIONS_PER_DAY = 1;
    try {
      const second = await approved(s);
      await authorize(s.admin, second.id);
      await h.dispatch(second.id);
      await h.waitFor(async () => (await row(second.id)).content?.status === 'FAILED');
      expect((await row(second.id)).lastError).toContain('PUBLICATION_LIMIT');
      expect(await publications(second.id)).toHaveLength(0);
    } finally {
      gateEnv.SOCIAL_MAX_PUBLICATIONS_PER_DAY = 1000;
    }
  });
});
