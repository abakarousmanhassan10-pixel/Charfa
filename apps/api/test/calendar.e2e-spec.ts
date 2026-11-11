import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, utcToZoned } from '@touma/shared';
import { as, type Ctx } from './ai-helpers';
import { calendarHelpers, type Entry } from './calendar-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Smart content calendar: entries, business-timezone handling, conflicts, duplicate prevention, concurrency, the
 * approval workflow and its permissions, notifications, recurring schedules, time recommendations and tenant isolation.
 * Real PostgreSQL and Redis; nothing is published (there is no publisher yet).
 */
describe('Calendar (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof calendarHelpers>;
  let owner: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['tenant']>>;
  let admin: Ctx & { userId: string };
  let editor: Ctx & { userId: string };
  let viewer: Ctx & { userId: string };
  let other: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['tenant']>>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = calendarHelpers(app);
    owner = await h.tenant('Café Awa');
    admin = await h.member(owner, 'ADMIN');
    editor = await h.member(owner, 'EDITOR');
    viewer = await h.member(owner, 'VIEWER');
    other = await h.tenant('Other Shop');
    await h.setTimezone(owner, 'Africa/Ndjamena'); // UTC+1, no daylight saving
    await h.setTimezone(other, 'America/New_York');
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('entries and timezone', () => {
    it('stores the instant in UTC and shows it in the business timezone', async () => {
      const date = h.day(10, 'Africa/Ndjamena');
      const e = await h.entry(owner, { localDate: date, localTime: '09:00' });
      expect(e.scheduledAt).toBe(`${date}T08:00:00.000Z`);
      expect(e.timezone).toBe('Africa/Ndjamena');
      expect(e.local).toEqual({ date, time: '09:00' });
      expect(e.timeSource).toBe('MANUAL');
      expect(e.status).toBe('DRAFT');
    });

    it('accepts a UTC instant and reports the local date across midnight', async () => {
      const date = h.day(11, 'UTC');
      const e = await h.entry(owner, { scheduledAt: `${date}T23:30:00Z`, platform: 'FACEBOOK' });
      expect(e.local).toEqual({ date: addDays(date, 1), time: '00:30' }); // UTC+1
    });

    it('recommends a time when none is given and labels it an estimate, never audience data', async () => {
      const date = h.day(12, 'Africa/Ndjamena');
      const e = await h.entry(owner, { platform: 'TIKTOK', localDate: date, title: 'No time given' });
      expect(e.timeSource).toBe('ESTIMATE');
      expect(e.timeNote).toMatch(/not your audience data/i);
      expect(['11:00', '19:00', '18:00', '20:00', '21:00']).toContain(e.local.time);
      expect(e.local.date).toBe(date);
    });

    it('uses the first free recommended slot when no date is given either', async () => {
      const e = await h.entry(owner, { platform: 'YOUTUBE', title: 'Auto slot' });
      expect(e.timeSource).toBe('ESTIMATE');
      expect(new Date(e.scheduledAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects the past, bad dates and incomplete time input', async () => {
      const past = await h.create(owner, { scheduledAt: new Date(Date.now() - 3600_000).toISOString() }).expect(409);
      expect(past.body.code).toBe('CALENDAR_CONFLICT');
      expect(past.body.conflicts[0].code).toBe('PAST_TIME');
      await h.create(owner, { localTime: '09:00' }).expect(400);
      await h.create(owner, { localDate: '2026-02-30', localTime: '09:00' }).expect(400);
      await h.create(owner, { platform: 'MYSPACE', localDate: h.day(3), localTime: '09:00' }).expect(400);
      await h.create(owner, { title: '' }).expect(400);
      await h.create(owner, { scheduledAt: 'not-a-date' }).expect(400);
    });

    it('lists a range in the business timezone, with filters, and limits the range size', async () => {
      const date = h.day(20, 'Africa/Ndjamena');
      const a = await h.entry(owner, { localDate: date, localTime: '23:30', title: 'Late', platform: 'FACEBOOK' });
      const res = await h.list(owner, date, date).expect(200);
      expect(res.body.timezone).toBe('Africa/Ndjamena');
      expect(res.body.items.map((i: Entry) => i.id)).toContain(a.id);
      const none = await h.list(owner, addDays(date, 1), addDays(date, 1)).expect(200);
      expect(none.body.items.map((i: Entry) => i.id)).not.toContain(a.id);
      const filtered = await h.list(owner, date, date, '&platform=INSTAGRAM').expect(200);
      expect(filtered.body.items.map((i: Entry) => i.id)).not.toContain(a.id);
      await h.list(owner, date, addDays(date, 60)).expect(400);
      await h.list(owner, addDays(date, 5), date).expect(400);
    });

    it('validates media and catalog references against the business', async () => {
      await h.create(owner, { localDate: h.day(8), localTime: '10:00', productId: other.productId }).expect(404);
      await h.create(owner, { localDate: h.day(8), localTime: '10:00', mediaIds: ['c0000000000000000000000000'] }).expect(404);
    });
  });

  describe('conflicts and duplicate prevention', () => {
    it('flags posts too close together and lets a person confirm', async () => {
      const date = h.day(30, 'Africa/Ndjamena');
      const first = await h.entry(owner, { localDate: date, localTime: '12:00', title: 'First' });
      const clash = await h.create(owner, { localDate: date, localTime: '13:00', title: 'Too close' }).expect(409);
      expect(clash.body.code).toBe('CONFLICT_CONFIRMATION_REQUIRED');
      expect(clash.body.conflicts[0]).toMatchObject({ code: 'SLOT_TOO_CLOSE', withEntryId: first.id });
      const ok = await h.create(owner, { localDate: date, localTime: '13:00', title: 'Too close', acknowledgeConflicts: true }).expect(201);
      expect(ok.body.conflicts.map((c: { code: string }) => c.code)).toContain('SLOT_TOO_CLOSE');
      // A different platform at the same time is fine.
      await h.entry(owner, { localDate: date, localTime: '12:00', platform: 'FACEBOOK', title: 'Other platform' });
    });

    it('flags more posts than the platform daily limit', async () => {
      const date = h.day(31, 'Africa/Ndjamena');
      await h.entry(owner, { localDate: date, localTime: '08:00', title: 'd1' });
      await h.entry(owner, { localDate: date, localTime: '14:00', title: 'd2' });
      const res = await h.create(owner, { localDate: date, localTime: '20:00', title: 'd3' }).expect(409);
      expect(res.body.conflicts.map((c: { code: string }) => c.code)).toContain('DAILY_LIMIT');
    });

    it('reports conflicts inside a range and notifies the people who schedule', async () => {
      const date = h.day(30, 'Africa/Ndjamena');
      const res = await request(h.http).get(`/api/v1/calendar/conflicts?from=${date}&to=${date}`).set(as(owner)).expect(200);
      expect(res.body.items.some((c: { code: string }) => c.code === 'SLOT_TOO_CLOSE')).toBe(true);
      const mine = await h.notifications(await h.userIdOf(owner), 'calendar.conflict');
      expect(mine.length).toBeGreaterThan(0);
      expect((await h.notifications(editor.userId, 'calendar.conflict')).length).toBe(0); // editors cannot schedule
    });

    it('never places the same content twice on a platform, even when conflicts are acknowledged', async () => {
      const date = h.day(40, 'Africa/Ndjamena');
      const a = await h.entry(owner, { localDate: date, localTime: '09:00', title: 'Original' });
      const b = await h.entry(owner, { localDate: h.day(41, 'Africa/Ndjamena'), localTime: '09:00', title: 'Copy' });
      const res = await h.post(owner, b.id, 'use-content', { contentId: a.content.id }).expect(409);
      expect(res.body.code).toBe('CALENDAR_CONFLICT');
      expect(res.body.conflicts[0].code).toBe('DUPLICATE_PLACEMENT');
      // On another platform the same content may be planned.
      const c = await h.entry(owner, { localDate: h.day(41, 'Africa/Ndjamena'), localTime: '10:00', title: 'Other', platform: 'FACEBOOK' });
      await h.post(owner, c.id, 'use-content', { contentId: a.content.id }).expect(200);
    });

    it('serialises concurrent requests for the same slot: exactly one wins', async () => {
      const date = h.day(50, 'Africa/Ndjamena');
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => h.create(owner, { localDate: date, localTime: '12:00', title: `Race ${i}` })));
      const codes = results.map((r) => r.status).sort();
      expect(codes.filter((s) => s === 201)).toHaveLength(1);
      expect(codes.filter((s) => s === 409)).toHaveLength(5);
      const rows = await prisma.calendarEvent.count({ where: { businessId: owner.businessId, title: { startsWith: 'Race ' } } });
      expect(rows).toBe(1);
    });
  });

  describe('approval workflow and permissions', () => {
    it('walks DRAFT → IN_REVIEW → APPROVED → SCHEDULED with an audit trail', async () => {
      const e = await h.entry(editor, { localDate: h.day(5, 'Africa/Ndjamena'), localTime: '10:00', title: 'Workflow' });
      expect(e.status).toBe('DRAFT');
      expect((await h.post(editor, e.id, 'submit').expect(200)).body.status).toBe('IN_REVIEW');
      const approved = (await h.post(admin, e.id, 'approve', { note: 'Looks good' }).expect(200)).body as Entry;
      expect(approved.status).toBe('APPROVED');
      expect(approved.content.approvedVersion).toBe(approved.content.version);
      const sched = (await h.post(admin, e.id, 'authorize').expect(200)).body as Entry;
      expect(sched.status).toBe('SCHEDULED');
      expect(sched.authorizedAt).not.toBeNull();
      const hist = await request(h.http).get(`/api/v1/calendar/entries/${e.id}/history`).set(as(viewer)).expect(200);
      expect(hist.body.items.map((r: { decision: string }) => r.decision)).toEqual(['SUBMITTED', 'APPROVED', 'AUTHORIZED']);
      expect(hist.body.items[1].note).toBe('Looks good');
      expect(hist.body.items[2].actorName).toBe('Test User');
      const audit = await prisma.auditLog.findMany({ where: { entityId: e.id }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['calendar.entry_created', 'calendar.submitted', 'calendar.approved', 'calendar.authorized']));
    });

    it('enforces who may do what', async () => {
      const e = await h.entry(editor, { localDate: h.day(6, 'Africa/Ndjamena'), localTime: '10:00', title: 'Permissions' });
      await h.create(viewer, { localDate: h.day(6), localTime: '11:00' }).expect(403);
      await h.post(viewer, e.id, 'submit').expect(403);
      await h.post(editor, e.id, 'submit').expect(200);
      await h.post(editor, e.id, 'approve').expect(403); // editors write, they do not approve
      await h.post(viewer, e.id, 'approve').expect(403);
      await h.post(admin, e.id, 'approve').expect(200);
      await h.post(editor, e.id, 'authorize').expect(403); // only people who may schedule publications authorize them
      await h.post(viewer, e.id, 'authorize').expect(403);
      await h.post(admin, e.id, 'authorize').expect(200);
      await h.get(viewer, e.id).expect(200);
      await h.post(editor, e.id, 'cancel').expect(403); // withdrawing an authorized publication needs the same permission
      await h.post(admin, e.id, 'cancel').expect(200);
    });

    it('requires approval of the current version before anything can be scheduled', async () => {
      const e = await h.entry(editor, { localDate: h.day(7, 'Africa/Ndjamena'), localTime: '10:00', title: 'Gate' });
      expect((await h.post(admin, e.id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
      await h.post(editor, e.id, 'submit').expect(200);
      expect((await h.post(admin, e.id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
      await h.post(admin, e.id, 'approve').expect(200);
      expect((await h.post(admin, e.id, 'approve').expect(409)).body.code).toBe('INVALID_STATE'); // already decided
      await h.post(admin, e.id, 'authorize').expect(200);
      expect((await h.post(admin, e.id, 'authorize').expect(409)).body.code).toBe('INVALID_STATE');
    });

    it('will not submit incomplete content', async () => {
      const empty = await h.entry(editor, { localDate: h.day(7, 'Africa/Ndjamena'), localTime: '15:00', title: 'No text', caption: undefined });
      const r1 = await h.post(editor, empty.id, 'submit').expect(422);
      expect(r1.body.code).toBe('CONTENT_INCOMPLETE');
      const img = await h.entry(editor, { localDate: h.day(7, 'Africa/Ndjamena'), localTime: '17:00', title: 'Needs picture', contentType: 'IMAGE', platform: 'FACEBOOK' });
      const r2 = await h.post(editor, img.id, 'submit').expect(422);
      expect(r2.body.missing).toEqual(['media']);
    });

    it('withdraws approval and authorization when the text changes', async () => {
      const e = await h.scheduled(editor, admin, { title: 'Edit after approval', localDate: h.day(9, 'Africa/Ndjamena') });
      await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(editor)).send({ caption: 'A different caption' }).expect(403); // editing authorized content cancels the authorization
      const res = await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(admin)).send({ caption: 'A different caption' }).expect(200);
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.authorizedAt).toBeNull();
      expect(res.body.content.approvedVersion).toBeNull();
      expect(res.body.content.version).toBe(e.content.version + 1);
      expect((await h.post(admin, e.id, 'authorize').expect(409)).body.code).toBe('APPROVAL_REQUIRED');
      const hist = await request(h.http).get(`/api/v1/calendar/entries/${e.id}/history`).set(as(admin)).expect(200);
      expect(hist.body.items.map((r: { decision: string }) => r.decision)).toContain('REVOKED');
      // Notes and the brief do not touch the approval.
      await h.post(editor, e.id, 'submit').expect(200);
      await h.post(admin, e.id, 'approve').expect(200);
      const noteOnly = await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(editor)).send({ notes: 'Remember the photo' }).expect(200);
      expect(noteOnly.body.status).toBe('APPROVED');
    });

    it('rejects with a reason and allows resubmission', async () => {
      const e = await h.entry(editor, { localDate: h.day(9, 'Africa/Ndjamena'), localTime: '16:00', title: 'Reject me' });
      await h.post(editor, e.id, 'submit').expect(200);
      await h.post(admin, e.id, 'reject', { reason: 'x' }).expect(400);
      const r = (await h.post(admin, e.id, 'reject', { reason: 'Please mention delivery hours' }).expect(200)).body as Entry & { content: { rejectionReason: string } };
      expect(r.status).toBe('REJECTED');
      expect(r.content.rejectionReason).toBe('Please mention delivery hours');
      await h.post(admin, e.id, 'authorize').expect(409);
      await h.post(editor, e.id, 'submit').expect(200);
    });

    it('re-checks AI-written text against the business data before approval', async () => {
      const e = await h.entry(editor, { localDate: h.day(19, 'Africa/Ndjamena'), localTime: '12:00', title: 'AI text', caption: 'Bissap juice for only 99 XAF today, a great price!' });
      await prisma.content.update({ where: { id: e.content.id }, data: { origin: 'AI_ASSISTED' } });
      await h.post(editor, e.id, 'submit').expect(200);
      const blocked = await h.post(admin, e.id, 'approve').expect(422);
      expect(blocked.body.code).toBe('APPROVAL_BLOCKED');
      expect(blocked.body.issues.join(' ')).toMatch(/99/);
      await request(h.http).patch(`/api/v1/calendar/entries/${e.id}`).set(as(editor)).send({ caption: 'Fresh bissap juice, served cold.' }).expect(200);
      await h.post(editor, e.id, 'submit').expect(200);
      await h.post(admin, e.id, 'approve').expect(200);
    });

    it('can unschedule, cancel and delete, and frees the slot when cancelled', async () => {
      const e = await h.scheduled(editor, admin, { title: 'Withdraw', localDate: h.day(12, 'Africa/Ndjamena'), localTime: '08:00' });
      expect((await h.post(admin, e.id, 'unschedule').expect(200)).body.status).toBe('APPROVED');
      expect((await h.post(admin, e.id, 'authorize').expect(200)).body.status).toBe('SCHEDULED');
      expect((await h.post(admin, e.id, 'cancel').expect(200)).body.status).toBe('CANCELLED');
      await h.post(admin, e.id, 'cancel').expect(409);
      // The cancelled entry no longer blocks its slot.
      await h.entry(owner, { localDate: h.day(12, 'Africa/Ndjamena'), localTime: '08:30', title: 'Takes the slot' });
      await request(h.http).delete(`/api/v1/calendar/entries/${e.id}`).set(as(editor)).expect(200);
      await h.get(owner, e.id).expect(404);
      const live = await h.entry(owner, { localDate: h.day(13, 'Africa/Ndjamena'), localTime: '08:00', title: 'Live' });
      await h.post(owner, live.id, 'submit').expect(200);
      await request(h.http).delete(`/api/v1/calendar/entries/${live.id}`).set(as(owner)).expect(409); // in review: cancel first
    });

    it('runs concurrent approve and authorize requests exactly once', async () => {
      const e = await h.entry(editor, { localDate: h.day(14, 'Africa/Ndjamena'), localTime: '10:00', title: 'Concurrent' });
      await h.post(editor, e.id, 'submit').expect(200);
      const approvals = await Promise.all([1, 2, 3, 4].map(() => h.post(admin, e.id, 'approve')));
      expect(approvals.filter((r) => r.status === 200)).toHaveLength(1);
      const auth = await Promise.all([1, 2, 3, 4].map(() => h.post(admin, e.id, 'authorize')));
      expect(auth.filter((r) => r.status === 200)).toHaveLength(1);
      const records = await prisma.approvalRecord.findMany({ where: { calendarEventId: e.id } });
      expect(records.filter((r) => r.decision === 'AUTHORIZED')).toHaveLength(1);
      expect(records.filter((r) => r.decision === 'APPROVED')).toHaveLength(1);
    });
  });

  describe('rescheduling', () => {
    it('moves a draft, keeps authorization for people who may schedule, and detects conflicts', async () => {
      const date = h.day(16, 'Africa/Ndjamena');
      const a = await h.entry(editor, { localDate: date, localTime: '09:00', title: 'Move me' });
      const moved = (await h.post(editor, a.id, 'reschedule', { localDate: date, localTime: '15:00' }).expect(200)).body as Entry;
      expect(moved.local.time).toBe('15:00');
      expect(moved.timeSource).toBe('MANUAL');
      const b = await h.entry(editor, { localDate: date, localTime: '09:00', title: 'Neighbour' });
      const clash = await h.post(editor, b.id, 'reschedule', { localDate: date, localTime: '16:00' }).expect(409);
      expect(clash.body.code).toBe('CONFLICT_CONFIRMATION_REQUIRED');
      await h.post(editor, b.id, 'reschedule', { localDate: date, localTime: '16:00', acknowledgeConflicts: true }).expect(200);
      await h.post(editor, b.id, 'reschedule', { scheduledAt: new Date(Date.now() - 60_000).toISOString() }).expect(409);

      const s = await h.scheduled(editor, admin, { title: 'Scheduled move', localDate: h.day(17, 'Africa/Ndjamena'), localTime: '08:00' });
      await h.post(editor, s.id, 'reschedule', { localDate: h.day(17, 'Africa/Ndjamena'), localTime: '12:00' }).expect(403);
      const m = (await h.post(admin, s.id, 'reschedule', { localDate: h.day(17, 'Africa/Ndjamena'), localTime: '12:00' }).expect(200)).body as Entry;
      expect(m.status).toBe('SCHEDULED');
      expect(m.local.time).toBe('12:00');
      await h.post(admin, s.id, 'reschedule', { scheduledAt: new Date(Date.now() + 30_000).toISOString() }).expect(409); // too close to now
    });
  });

  describe('notifications', () => {
    it('tells approvers about content awaiting approval, once, and keeps notifications private', async () => {
      const e = await h.entry(editor, { localDate: h.day(18, 'Africa/Ndjamena'), localTime: '10:00', title: 'Notify me' });
      await h.post(editor, e.id, 'submit').expect(200);
      const forAdmin = await h.notifications(admin.userId, 'calendar.approval_requested');
      expect(forAdmin.filter((n) => (n.data as { entryId: string }).entryId === e.id)).toHaveLength(1);
      expect((await h.notifications(editor.userId, 'calendar.approval_requested')).filter((n) => (n.data as { entryId: string }).entryId === e.id)).toHaveLength(0);
      expect((await h.notifications(viewer.userId, 'calendar.approval_requested')).length).toBe(0);
      const list = await request(h.http).get('/api/v1/notifications?unread=true').set(as(admin)).expect(200);
      expect(list.body.unread).toBeGreaterThan(0);
      const first = list.body.items[0];
      await request(h.http).post(`/api/v1/notifications/${first.id}/read`).set(as(editor)).expect(404); // not theirs
      await request(h.http).post(`/api/v1/notifications/${first.id}/read`).set(as(admin)).expect(200);
      const after = await request(h.http).get('/api/v1/notifications?unread=true').set(as(admin)).expect(200);
      expect(after.body.unread).toBe(list.body.unread - 1);
      await request(h.http).post('/api/v1/notifications/read-all').set(as(admin)).expect(200);
      expect((await request(h.http).get('/api/v1/notifications?unread=true').set(as(admin)).expect(200)).body.unread).toBe(0);
    });
  });

  describe('recurring schedules', () => {
    it('keeps the local time across a daylight-saving change', async () => {
      // The next US spring-forward after today (second Sunday of March).
      const year = new Date().getUTCFullYear();
      const secondSunday = (y: number) => {
        const first = new Date(Date.UTC(y, 2, 1)).getUTCDay();
        return 1 + ((7 - first) % 7) + 7;
      };
      let y = year;
      let sf = `${y}-03-${String(secondSunday(y)).padStart(2, '0')}`;
      if (sf <= h.day(14, 'UTC')) { y += 1; sf = `${y}-03-${String(secondSunday(y)).padStart(2, '0')}`; }
      const start = addDays(sf, -6); // Monday before
      const end = addDays(sf, 5);
      const res = await request(h.http).post('/api/v1/calendar/recurrences').set(as(other)).send({ title: 'Weekly special', platform: 'FACEBOOK', frequency: 'WEEKLY', weekdays: [1, 4], localTime: '09:00', startDate: start, endDate: end }).expect(201);
      expect(res.body.created).toBe(4);
      const items = (await h.list(other, start, end).expect(200)).body.items as Entry[];
      expect(items).toHaveLength(4);
      for (const i of items) expect(utcToZoned(new Date(i.scheduledAt), 'America/New_York').time).toBe('09:00');
      const offsets = new Set(items.map((i) => new Date(i.scheduledAt).getUTCHours()));
      expect(offsets).toEqual(new Set([14, 13])); // 09:00 EST = 14:00Z, 09:00 EDT = 13:00Z
      expect(items.every((i) => i.status === 'DRAFT')).toBe(true);
    });

    it('prevents duplicates, limits size, and stops cleanly', async () => {
      const body = { title: 'Daily tip', platform: 'TIKTOK', frequency: 'DAILY', localTime: '18:00', startDate: h.day(60, 'Africa/Ndjamena'), endDate: h.day(63, 'Africa/Ndjamena') };
      const first = await request(h.http).post('/api/v1/calendar/recurrences').set(as(owner)).send(body).expect(201);
      expect(first.body.created).toBe(4);
      const dup = await request(h.http).post('/api/v1/calendar/recurrences').set(as(owner)).send(body).expect(409);
      expect(dup.body.code).toBe('DUPLICATE_RECURRENCE');
      await request(h.http).post('/api/v1/calendar/recurrences').set(as(owner)).send({ ...body, title: 'Too long', startDate: h.day(60), endDate: h.day(130) }).expect(422);
      await request(h.http).post('/api/v1/calendar/recurrences').set(as(owner)).send({ ...body, title: 'No days', frequency: 'WEEKLY' }).expect(400);
      await request(h.http).post('/api/v1/calendar/recurrences').set(as(owner)).send({ ...body, title: 'Backwards', endDate: h.day(50) }).expect(400);
      await request(h.http).post('/api/v1/calendar/recurrences').set(as(viewer)).send({ ...body, title: 'Viewer' }).expect(403);

      // Approve one occurrence, then stop the schedule: unapproved ones are cancelled, the approved one is kept.
      const items = (await h.list(owner, body.startDate, body.endDate, '&platform=TIKTOK').expect(200)).body.items as Entry[];
      const keep = items[0]!;
      await request(h.http).patch(`/api/v1/calendar/entries/${keep.id}`).set(as(owner)).send({ caption: 'Daily tip: serve bissap cold.' }).expect(200);
      await h.setTikTok(owner, keep.id).expect(200); // TikTok entries need the creator's posting choices before review
      await h.post(owner, keep.id, 'submit').expect(200);
      await h.post(owner, keep.id, 'approve').expect(200);
      const del = await request(h.http).delete(`/api/v1/calendar/recurrences/${first.body.id}`).set(as(owner)).expect(200);
      expect(del.body).toEqual({ cancelled: 3, kept: 1 });
      expect((await h.get(owner, keep.id).expect(200)).body.status).toBe('APPROVED');
      await request(h.http).delete(`/api/v1/calendar/recurrences/${first.body.id}`).set(as(owner)).expect(404);
    });
  });

  describe('time recommendations', () => {
    async function seedPublished(c: Ctx & { businessId: string }, hours: number[], platform: 'INSTAGRAM' | 'FACEBOOK' = 'INSTAGRAM') {
      const account = await prisma.socialAccount.upsert({ where: { businessId_platform_externalAccountId: { businessId: c.businessId, platform, externalAccountId: 'acc1' } }, create: { businessId: c.businessId, platform, externalAccountId: 'acc1', accessTokenEnc: 'x', status: 'CONNECTED' }, update: {} });
      const u = await prisma.user.findFirstOrThrow({ where: { memberships: { some: { businessId: c.businessId } } } });
      for (const [i, hour] of hours.entries()) {
        const content = await prisma.content.create({ data: { businessId: c.businessId, type: 'TEXT', caption: 'x', status: 'PUBLISHED', origin: 'HUMAN', createdById: u.id, targetPlatforms: [platform] } });
        const at = new Date(Date.UTC(2026, 5, 1 + i, hour - 1, 0)); // local = UTC+1
        const pub = await prisma.publication.create({ data: { businessId: c.businessId, contentId: content.id, socialAccountId: account.id, platform, status: 'PUBLISHED', scheduledAt: at, publishedAt: at, timezone: 'Africa/Ndjamena', idempotencyKey: `seed-${c.businessId}-${platform}-${i}-${Math.random()}` } });
        await prisma.analyticsSnapshot.create({ data: { businessId: c.businessId, socialAccountId: account.id, publicationId: pub.id, platform, period: 'LIFETIME', periodStart: at, periodEnd: at, source: 'MEASURED', engagementRate: hour === 15 ? 0.09 : 0.02 } });
      }
    }

    it('labels estimates when there is no audience data, and uses analytics only when there is enough', async () => {
      const date = h.day(70, 'Africa/Ndjamena');
      const est = (await request(h.http).get(`/api/v1/calendar/recommendations?platform=FACEBOOK&date=${date}`).set(as(owner)).expect(200)).body;
      expect(est).toMatchObject({ source: 'ESTIMATE', sampleSize: 0, timezone: 'Africa/Ndjamena' });
      expect(est.note).toMatch(/not your audience data/i);
      expect(est.slots.length).toBeGreaterThan(0);

      await seedPublished(owner, [15, 15, 15, 9, 9], 'FACEBOOK'); // 5 posts: below the minimum
      const few = (await request(h.http).get(`/api/v1/calendar/recommendations?platform=FACEBOOK&date=${date}`).set(as(owner)).expect(200)).body;
      expect(few.source).toBe('ESTIMATE');
      expect(few.note).toMatch(/only 5 published/);

      await seedPublished(owner, [15, 15, 15, 9, 9, 20, 20, 15, 12, 12]); // 10 measured Instagram posts
      const real = (await request(h.http).get(`/api/v1/calendar/recommendations?platform=INSTAGRAM&date=${date}`).set(as(owner)).expect(200)).body;
      expect(real.source).toBe('ANALYTICS');
      expect(real.sampleSize).toBe(10);
      expect(real.slots[0].time).toBe('15:00');
      expect(real.slots[0].reason).toMatch(/Average engagement 9\.0%/);
      // Another business's data is never used.
      const theirs = (await request(h.http).get(`/api/v1/calendar/recommendations?platform=INSTAGRAM&date=${date}`).set(as(other)).expect(200)).body;
      expect(theirs.source).toBe('ESTIMATE');
      expect(theirs.sampleSize).toBe(0);
      await request(h.http).get('/api/v1/calendar/recommendations?platform=INSTAGRAM&date=2026-13-01').set(as(owner)).expect(400);
    });

    it('records the source on entries that took a recommended time', async () => {
      const date = h.day(71, 'Africa/Ndjamena');
      const e = await h.entry(owner, { platform: 'INSTAGRAM', localDate: date, title: 'Data driven' });
      expect(e.timeSource).toBe('ANALYTICS');
      expect(e.local.time).toBe('15:00');
      expect(e.timeNote).toMatch(/Based on 10 of your published posts/);
    });
  });

  describe('tenant isolation', () => {
    it('hides every entry of another business', async () => {
      const mine = await h.entry(owner, { localDate: h.day(80, 'Africa/Ndjamena'), localTime: '10:00', title: 'Private' });
      await h.get(other, mine.id).expect(404);
      await h.get(other, `${mine.id}`).expect(404);
      for (const action of ['submit', 'approve', 'authorize', 'unschedule', 'cancel', 'retry']) await h.post(other, mine.id, action).expect(404);
      await h.post(other, mine.id, 'reject', { reason: 'abc' }).expect(404);
      await h.post(other, mine.id, 'reschedule', { localDate: h.day(81), localTime: '10:00' }).expect(404);
      await request(h.http).patch(`/api/v1/calendar/entries/${mine.id}`).set(as(other)).send({ title: 'Hijack' }).expect(404);
      await request(h.http).delete(`/api/v1/calendar/entries/${mine.id}`).set(as(other)).expect(404);
      await request(h.http).get(`/api/v1/calendar/entries/${mine.id}/history`).set(as(other)).expect(404);
      const theirs = await h.list(other, h.day(80), h.day(82)).expect(200);
      expect(theirs.body.items.map((i: Entry) => i.id)).not.toContain(mine.id);
      // Using another tenant's content is not possible either.
      const o = await h.entry(other, { localDate: h.day(80, 'America/New_York'), localTime: '10:00', title: 'Theirs' });
      await h.post(owner, mine.id, 'use-content', { contentId: o.content.id }).expect(404);
    });

    it('does not let a member of one business act in another by spoofing the tenant header', async () => {
      const mine = await h.entry(owner, { localDate: h.day(82, 'Africa/Ndjamena'), localTime: '10:00', title: 'Spoof target' });
      const spoof = { Authorization: `Bearer ${other.token}`, 'X-Business-Id': owner.businessId };
      for (const status of [await request(h.http).get(`/api/v1/calendar/entries/${mine.id}`).set(spoof), await request(h.http).post(`/api/v1/calendar/entries/${mine.id}/approve`).set(spoof), await request(h.http).get('/api/v1/calendar/overview').set(spoof)]) {
        expect([403, 404]).toContain(status.status); // not a member: the business is not revealed
        expect(JSON.stringify(status.body)).not.toContain('Spoof target');
      }
    });

    it('summarises the next 30 days', async () => {
      const res = await request(h.http).get('/api/v1/calendar/overview').set(as(owner)).expect(200);
      expect(res.body.timezone).toBe('Africa/Ndjamena');
      expect(res.body.counts.total).toBeGreaterThan(0);
      expect(res.body.publishing).toEqual({ available: true }); // the platform simulator is configured in tests
      expect(res.body.pendingApprovals).toBeGreaterThanOrEqual(1);
      const approvals = await request(h.http).get('/api/v1/calendar/approvals').set(as(admin)).expect(200);
      expect(approvals.body.items.every((i: Entry) => i.status === 'IN_REVIEW')).toBe(true);
      expect(approvals.body.total).toBe(res.body.pendingApprovals);
      const decided = await request(h.http).get('/api/v1/calendar/approvals?view=decided').set(as(admin)).expect(200);
      expect(decided.body.items.length).toBeGreaterThan(0);
    });
  });
});
