import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PublicationGate } from '../src/calendar/publication-gate';
import { loadEnv } from '@touma/config';
import { AuditService } from '../src/audit/audit.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { as, type Ctx } from './ai-helpers';
import { calendarHelpers, type Entry } from './calendar-helpers';
import { CalendarQueueService } from '../src/calendar/calendar-queue';
import { CalendarResultsService } from '../src/calendar/calendar-results.service';
import { CalendarWorkerService } from '../src/calendar/calendar-worker.service';
import { PUBLISHING_GATEWAY, type PublishingGateway, type PublishingOutcome, type PublishingRequest } from '../src/calendar/publishing';
import { prisma, resetDb, startApp } from './helpers';

/**
 * The calendar scheduler: hand-off of due, explicitly authorized entries to the publishing interface, with retries,
 * idempotency, duplicate prevention, failure notifications and crash recovery. Real PostgreSQL, Redis and BullMQ.
 * The publisher is the one stand-in (there is no real publisher until Phase 6): its calls are recorded and scripted.
 */
describe('Calendar scheduler (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof calendarHelpers>;
  let worker: CalendarWorkerService;
  let queue: CalendarQueueService;
  let gateway: PublishingGateway;
  let owner: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['tenant']>>;
  let admin: Ctx & { userId: string };
  let editor: Ctx & { userId: string };
  let calls: PublishingRequest[];
  let available: boolean;
  let script: Array<PublishingOutcome | Error>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = calendarHelpers(app);
    worker = app.get(CalendarWorkerService);
    queue = app.get(CalendarQueueService);
    gateway = app.get(PUBLISHING_GATEWAY);
    owner = await h.tenant('Café Awa');
    admin = await h.member(owner, 'ADMIN');
    editor = await h.member(owner, 'EDITOR');
    await h.setTimezone(owner, 'Africa/Ndjamena');
    // Authorizing binds the entry to a connected account of its platform (Phase N18); the gateway below is a stub, so the accounts are plain rows.
    for (const platform of ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN'] as const) await prisma.socialAccount.create({ data: { businessId: owner.businessId, platform, externalAccountId: `stub-${platform}`, accessTokenEnc: 'x', status: 'CONNECTED' } });
  });
  beforeEach(() => {
    calls = [];
    available = true;
    script = [];
    jest.spyOn(gateway, 'isAvailable').mockImplementation(() => available);
    jest.spyOn(gateway, 'submit').mockImplementation(async (r) => {
      calls.push(r);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next ?? { status: 'ACCEPTED', reference: `ref-${calls.length}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  let n = 0;
  /** A scheduled entry that is already due. */
  async function due(body: Record<string, unknown> = {}, by: Ctx = admin) {
    n += 1;
    const e = await h.scheduled(editor, by, { title: `Due ${n}`, localDate: h.day(2 + (n % 20), 'Africa/Ndjamena'), localTime: `${String(8 + (n % 12)).padStart(2, '0')}:00`, platform: ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE'][n % 4], ...body });
    await h.makeDue(e.id);
    return e;
  }
  const row = (id: string) => prisma.calendarEvent.findUniqueOrThrow({ where: { id }, include: { content: true } });
  const settle = async (id: string, states: string[]) => {
    await h.waitFor(async () => states.includes((await row(id)).dispatchState));
    return row(id);
  };

  it('hands a due, authorized entry to the publisher exactly once, with an idempotency key and who authorized it', async () => {
    const e = await due();
    const res = await worker.tick();
    expect(res.handed).toBe(1);
    const r = await settle(e.id, ['DISPATCHED']);
    expect(r.content?.status).toBe('PUBLISHING');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ entryId: e.id, contentId: e.content.id, contentVersion: e.content.version, businessId: owner.businessId, caption: 'Fresh bissap juice, served cold.' });
    expect(calls[0]!.authorizedById).toBe(admin.userId);
    expect(calls[0]!.idempotencyKey).toBe(`${e.id}-${e.content.version}-${(await row(e.id)).scheduledAt.getTime()}`);
    // Later ticks do not hand it over again.
    await worker.tick();
    await worker.tick();
    expect(calls).toHaveLength(1);
    expect((await prisma.auditLog.findMany({ where: { entityId: e.id, action: 'calendar.dispatched' } })).length).toBe(1);
  });

  it('is only the publisher that can mark an entry published, and doing so twice changes nothing', async () => {
    const e = await due();
    await worker.tick();
    await settle(e.id, ['DISPATCHED']);
    expect((await worker.recordPublished(e.id, { externalUrl: 'https://example.com/p/1' })).changed).toBe(true);
    expect((await worker.recordPublished(e.id, {})).changed).toBe(false);
    expect((await row(e.id)).content?.status).toBe('PUBLISHED');
    expect((await h.get(owner, e.id).expect(200)).body.status).toBe('PUBLISHED');
    await h.post(admin, e.id, 'cancel').expect(409); // published entries are final
    await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(admin)).send({ caption: 'rewrite history' }).expect(409);
    // Nothing was ever "published" by the calendar itself: the entries below stay unpublished without a publisher report.
    const x = await due();
    await worker.tick();
    expect((await row(x.id)).content?.status).not.toBe('PUBLISHED');
  });

  it('never hands the same entry over twice, even when several workers tick at once', async () => {
    const e = await due();
    const results = await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
    // (A worker already ticking skips; the others race on the same conditional update.)
    expect(results.reduce((a, r) => a + r.handed, 0)).toBeLessThanOrEqual(1);
    await settle(e.id, ['DISPATCHED']);
    expect(calls.filter((c) => c.entryId === e.id)).toHaveLength(1);
    // A second worker process: same database, same queue.
    const other = new CalendarWorkerService(app.get(PrismaService), queue, app.get(NotificationsService), app.get(AuditService), app.get(CalendarResultsService), app.get(PublicationGate), gateway, loadEnv());
    const e2 = await due();
    const more = await Promise.all([worker.tick(), other.tick(), worker.tick(), other.tick()]);
    expect(more.reduce((a, r) => a + r.handed, 0)).toBe(1);
    await settle(e2.id, ['DISPATCHED']);
    expect(calls.filter((c) => c.entryId === e2.id)).toHaveLength(1);
    expect(await queue.getJob(`${e2.id}-${e2.content.version}-${(await row(e2.id)).scheduledAt.getTime()}`)).toBeTruthy();
  });

  it('never hands over anything that was not explicitly authorized', async () => {
    const draft = await h.entry(editor, { localDate: h.day(3, 'Africa/Ndjamena'), localTime: '07:00', title: 'Draft only' });
    const inReview = await h.entry(editor, { localDate: h.day(3, 'Africa/Ndjamena'), localTime: '11:00', title: 'In review' });
    await h.post(editor, inReview.id, 'submit').expect(200);
    const approved = await h.entry(editor, { localDate: h.day(3, 'Africa/Ndjamena'), localTime: '15:00', title: 'Approved only', platform: 'FACEBOOK' });
    await h.post(editor, approved.id, 'submit').expect(200);
    await h.post(admin, approved.id, 'approve').expect(200);
    const withdrawn = await due({ title: 'Withdrawn' });
    await h.post(admin, withdrawn.id, 'unschedule').expect(200);
    const cancelled = await due({ title: 'Cancelled' });
    await h.post(admin, cancelled.id, 'cancel').expect(200);
    for (const e of [draft, inReview, approved]) await h.makeDue(e.id);
    await h.makeDue(withdrawn.id);
    await worker.tick();
    await worker.tick();
    expect(calls).toHaveLength(0);
    for (const e of [draft, inReview, approved, withdrawn, cancelled]) expect((await row(e.id)).dispatchState).toBe('NONE');
  });

  it('does not hand over an entry whose text changed after it was authorized', async () => {
    const e = await due({ title: 'Edited late' });
    await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(admin)).send({ caption: 'Changed after approval' }).expect(200);
    await worker.tick();
    expect(calls).toHaveLength(0);
    expect((await row(e.id)).content?.status).toBe('IN_REVIEW');
    // A hand-off already queued for the old version is dropped at execution time.
    const f = await due({ title: 'Edited in the queue' });
    await prisma.calendarEvent.update({ where: { id: f.id }, data: { dispatchState: 'QUEUED', dispatchKey: `${f.id}-stale` } });
    await prisma.content.update({ where: { id: f.content.id }, data: { version: { increment: 1 } } });
    await worker.handle({ data: { entryId: f.id, dispatchKey: `${f.id}-stale` }, attemptsMade: 0, opts: { attempts: 3 } } as never);
    expect(calls).toHaveLength(0);
    expect((await row(f.id)).dispatchState).toBe('NONE');
  });

  it('waits (BLOCKED) instead of failing when no publisher is connected, notifies once, and releases when one appears', async () => {
    available = false;
    const e = await due({ title: 'No publisher' });
    expect((await worker.tick()).blocked).toBeGreaterThanOrEqual(1);
    expect((await row(e.id)).dispatchState).toBe('BLOCKED');
    expect((await row(e.id)).content?.status).toBe('SCHEDULED');
    await worker.tick();
    const notes = (await h.notifications(admin.userId, 'calendar.blocked')).filter((x) => (x.data as { entryId: string }).entryId === e.id);
    expect(notes).toHaveLength(1);
    expect(calls).toHaveLength(0);
    available = true;
    await worker.tick();
    await settle(e.id, ['DISPATCHED']);
    expect(calls).toHaveLength(1);
  });

  it('retries transient publisher errors with the same idempotency key', async () => {
    script = [new Error('connection reset'), { status: 'REJECTED', code: 'RATE_LIMIT', message: 'slow down', retryable: true }];
    const e = await due({ title: 'Flaky' });
    await worker.tick();
    const r = await settle(e.id, ['DISPATCHED']);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(r.dispatchAttempts).toBe(3);
    expect(r.content?.status).toBe('PUBLISHING');
    expect(await h.notifications(admin.userId, 'calendar.failed').then((x) => x.filter((n) => (n.data as { entryId: string }).entryId === e.id))).toHaveLength(0);
  });

  it('fails permanently, tells the right people, and lets an authorized person retry', async () => {
    script = [{ status: 'REJECTED', code: 'ACCOUNT_DISCONNECTED', message: 'The Instagram account is disconnected', retryable: false }];
    const e = await due({ title: 'Will fail', platform: 'INSTAGRAM' });
    await worker.tick();
    const r = await settle(e.id, ['FAILED']);
    expect(calls).toHaveLength(1);
    expect(r.content?.status).toBe('FAILED');
    expect(r.lastError).toMatch(/ACCOUNT_DISCONNECTED/);
    expect((await h.get(owner, e.id).expect(200)).body).toMatchObject({ status: 'FAILED', dispatchState: 'FAILED' });
    const forAdmin = (await h.notifications(admin.userId, 'calendar.failed')).filter((x) => (x.data as { entryId: string }).entryId === e.id);
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]!.body).toMatch(/disconnected/);
    expect((await h.notifications(editor.userId, 'calendar.failed')).length).toBe(0);
    expect((await prisma.auditLog.findMany({ where: { entityId: e.id, action: 'calendar.dispatch_failed' } })).length).toBe(1);

    await h.post(editor, e.id, 'retry').expect(403);
    await h.post(admin, e.id, 'retry', { scheduledAt: new Date(Date.now() - 60_000).toISOString() }).expect(409); // the new time must be in the future
    const retried = (await h.post(admin, e.id, 'retry', { localDate: h.day(15, 'Africa/Ndjamena'), localTime: '09:00' }).expect(200)).body as Entry;
    expect(retried.status).toBe('SCHEDULED');
    expect(retried.dispatchState).toBe('NONE');
    const hist = (await request(h.http).get(`/api/v1/calendar/entries/${e.id}/history`).set(as(admin)).expect(200)).body.items;
    expect(hist.filter((x: { decision: string }) => x.decision === 'AUTHORIZED')).toHaveLength(2);
    await h.makeDue(e.id);
    await worker.tick();
    await settle(e.id, ['DISPATCHED']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey); // a new authorization and time is a new hand-off
  });

  it('fails after the retries are exhausted', async () => {
    script = [new Error('down'), new Error('down'), new Error('down'), new Error('down')];
    const e = await due({ title: 'Always down' });
    await worker.tick();
    const r = await settle(e.id, ['FAILED']);
    expect(calls).toHaveLength(3);
    expect(r.content?.status).toBe('FAILED');
    expect(r.lastError).toMatch(/PUBLISHER_ERROR|DISPATCH_FAILED/);
  });

  it('stops when the person who authorized is no longer allowed to schedule publications', async () => {
    const e = await due({ title: 'Demoted authorizer' });
    await prisma.membership.update({ where: { userId_businessId: { userId: admin.userId, businessId: owner.businessId } }, data: { role: 'VIEWER' } });
    try {
      await worker.tick();
      const r = await settle(e.id, ['FAILED']);
      expect(calls).toHaveLength(0);
      expect(r.lastError).toMatch(/AUTHORIZATION_REVOKED/);
    } finally {
      await prisma.membership.update({ where: { userId_businessId: { userId: admin.userId, businessId: owner.businessId } }, data: { role: 'ADMIN' } });
    }
  });

  it('recovers claims whose job or worker disappeared, and re-sends with the same key', async () => {
    const e = await due({ title: 'Crashed' });
    const key = `${e.id}-${e.content.version}-${(await row(e.id)).scheduledAt.getTime()}`;
    // The worker died after claiming (QUEUED, but no job exists and the claim has expired).
    await prisma.calendarEvent.update({ where: { id: e.id }, data: { dispatchState: 'QUEUED', dispatchKey: key, lockedUntil: new Date(Date.now() - 1000) } });
    const res = await worker.tick();
    expect(res.recovered).toBe(1);
    await settle(e.id, ['DISPATCHED']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.idempotencyKey).toBe(key);

    // The worker died during the publisher call (DISPATCHING, expired): it is re-queued, never silently dropped.
    const f = await due({ title: 'Died mid-call' });
    const keyF = `${f.id}-${f.content.version}-${(await row(f.id)).scheduledAt.getTime()}`;
    await prisma.calendarEvent.update({ where: { id: f.id }, data: { dispatchState: 'DISPATCHING', dispatchKey: keyF, lockedUntil: new Date(Date.now() - 1000) } });
    expect((await worker.tick()).recovered).toBe(1);
    await settle(f.id, ['DISPATCHED']);
    expect(calls.filter((c) => c.entryId === f.id).map((c) => c.idempotencyKey)).toEqual([keyF]);
    // A claim that is still valid is left alone.
    const g = await due({ title: 'Still working' });
    await prisma.calendarEvent.update({ where: { id: g.id }, data: { dispatchState: 'DISPATCHING', dispatchKey: `${g.id}-x`, lockedUntil: new Date(Date.now() + 60_000) } });
    expect((await worker.tick()).recovered).toBe(0);
    await prisma.calendarEvent.update({ where: { id: g.id }, data: { dispatchState: 'NONE', dispatchKey: null, lockedUntil: null, deletedAt: new Date() } });
  });

  it('sends one upcoming-publication reminder per entry and time', async () => {
    const e = await h.scheduled(editor, admin, { title: 'Coming up', localDate: h.day(1, 'Africa/Ndjamena'), localTime: '09:00', platform: 'YOUTUBE' });
    await prisma.calendarEvent.update({ where: { id: e.id }, data: { scheduledAt: new Date(Date.now() + 30 * 60_000), reminderSentAt: null } });
    const first = await worker.tick();
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    await worker.tick();
    const notes = (await h.notifications(admin.userId, 'calendar.upcoming')).filter((x) => (x.data as { entryId: string }).entryId === e.id);
    expect(notes).toHaveLength(1);
    expect(calls.filter((c) => c.entryId === e.id)).toHaveLength(0); // not due yet
    // Moving the entry re-arms the reminder for the new time.
    await h.post(admin, e.id, 'reschedule', { scheduledAt: new Date(Date.now() + 40 * 60_000).toISOString(), acknowledgeConflicts: true }).expect(200);
    expect((await row(e.id)).reminderSentAt).toBeNull();
  });

  it('keeps the queue and the publisher interface contract', async () => {
    expect(worker.running).toBe(true);
    expect(gateway.name).toBeDefined();
    const real = new (await import('../src/calendar/publishing')).UnavailablePublishingGateway();
    expect(real.isAvailable()).toBe(false);
    expect(await real.submit()).toMatchObject({ status: 'REJECTED', code: 'PUBLISHER_NOT_AVAILABLE', retryable: false });
  });
});
