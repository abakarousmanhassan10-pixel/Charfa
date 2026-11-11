import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDays, todayIn } from '@touma/shared';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma } from './helpers';

/** Helpers for the calendar suites (real PostgreSQL, Redis and BullMQ; the publisher is the only stand-in). */
export function calendarHelpers(app: INestApplication) {
  const ai = aiHelpers(app);
  const http = ai.http;

  /** A date n days from today in the given timezone. */
  const day = (n: number, tz = 'UTC') => addDays(todayIn(tz), n);

  const setTimezone = async (c: Ctx, timezone: string) => {
    await request(http).patch(`/api/v1/businesses/${c.businessId}`).set(as(c)).send({ timezone }).expect(200);
  };

  const create = (c: Ctx, body: Record<string, unknown> = {}) =>
    request(http).post('/api/v1/calendar/entries').set(as(c)).send({ title: 'Bissap promo post', platform: 'INSTAGRAM', caption: 'Fresh bissap juice, served cold.', ...body });
  const entry = async (c: Ctx, body: Record<string, unknown> = {}) => (await create(c, body).expect(201)).body as Entry;
  const get = (c: Ctx, id: string) => request(http).get(`/api/v1/calendar/entries/${id}`).set(as(c));
  const post = (c: Ctx, id: string, action: string, body: Record<string, unknown> = {}) => request(http).post(`/api/v1/calendar/entries/${id}/${action}`).set(as(c)).send(body);
  const list = (c: Ctx, from: string, to: string, extra = '') => request(http).get(`/api/v1/calendar/entries?from=${from}&to=${to}${extra}`).set(as(c));

  /** Creates an entry and takes it all the way to SCHEDULED (editor writes, admin approves and authorizes). */
  /** The choices a person makes on TikTok's posting screen (all required by TikTok's guidelines). */
  const tiktokSettings = (o: Record<string, unknown> = {}) => ({ privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, commercial: { enabled: false, yourBrand: false, brandedContent: false }, consent: true, ...o });
  const setTikTok = (c: Ctx, id: string, o: Record<string, unknown> = {}) => request(http).put(`/api/v1/calendar/entries/${id}/tiktok-settings`).set(as(c)).send(tiktokSettings(o));

  async function scheduled(editor: Ctx, admin: Ctx, body: Record<string, unknown> = {}) {
    const { withoutTikTokSettings, ...rest } = body as Record<string, unknown> & { withoutTikTokSettings?: boolean };
    const e = await entry(editor, { localDate: day(5), localTime: '10:00', ...rest });
    if (rest.platform === 'TIKTOK' && !withoutTikTokSettings) await setTikTok(editor, e.id).expect(200);
    await post(editor, e.id, 'submit').expect(200);
    await post(admin, e.id, 'approve').expect(200);
    return (await post(admin, e.id, 'authorize').expect(200)).body as Entry;
  }

  /** Makes an entry due by moving its time into the past (what waiting would do). */
  const makeDue = (id: string, minutesAgo = 1) => prisma.calendarEvent.update({ where: { id }, data: { scheduledAt: new Date(Date.now() - minutesAgo * 60_000), reminderSentAt: new Date() } });

  const notifications = (userId: string, type?: string) => prisma.notification.findMany({ where: { userId, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
  const userIdOf = async (c: Ctx) => {
    const me = await request(http).get('/api/v1/users/me').set('Authorization', `Bearer ${c.token}`).expect(200);
    return me.body.id as string;
  };

  return { ...ai, day, setTimezone, create, entry, get, post, list, scheduled, tiktokSettings, setTikTok, makeDue, notifications, userIdOf };
}

export interface Entry {
  id: string;
  title: string;
  platform: string;
  status: string;
  scheduledAt: string;
  timezone: string;
  local: { date: string; time: string };
  timeSource: string;
  timeNote: string | null;
  authorizedAt: string | null;
  dispatchState: string;
  conflicts: Array<{ code: string; severity: string }>;
  content: { id: string; version: number; approvedVersion: number | null; caption: string | null; origin: string };
}
