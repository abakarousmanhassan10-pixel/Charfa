import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { randomBytes } from 'crypto';
import type { SocialPlatform } from '@touma/database';
import { fakeMp4 } from '@touma/creative';
import type { FakeSocialHub } from '@touma/social-connectors';
import { OBJECT_STORAGE, type ObjectStorage } from '@touma/storage';
import { TokenCipher } from '../src/common/crypto/token-cipher';
import { CalendarWorkerService } from '../src/calendar/calendar-worker.service';
import { SOCIAL_FAKE_HUB } from '../src/social/social-providers';
import { SocialPublisherService } from '../src/social/social-publisher.service';
import { SocialWorkerService } from '../src/social/social-worker.service';
import { as, type Ctx } from './ai-helpers';
import { calendarHelpers } from './calendar-helpers';
import { prisma } from './helpers';

/** Helpers for the social suites. The platforms are the test-only simulator; everything else is real (PostgreSQL, Redis, BullMQ, storage, media URLs). */
export function socialHelpers(app: INestApplication) {
  const cal = calendarHelpers(app);
  const http = cal.http;
  const hub = app.get<FakeSocialHub>(SOCIAL_FAKE_HUB);
  const cipher = app.get(TokenCipher);
  const storage = app.get<ObjectStorage>(OBJECT_STORAGE);
  const publisher = app.get(SocialPublisherService);
  const socialWorker = app.get(SocialWorkerService);
  const calendarWorker = app.get(CalendarWorkerService);

  /** A connected account without going through the browser flow (the OAuth flow has its own tests). */
  async function connect(c: Ctx, platform: SocialPlatform, n = 1, over: Record<string, unknown> = {}) {
    const externalAccountId = `${platform.toLowerCase()}-acc-${n}-${randomBytes(3).toString('hex')}`;
    const a = await prisma.socialAccount.create({
      data: {
        businessId: c.businessId, platform, externalAccountId, displayName: `${platform} account ${n}`, accountType: 'PAGE', status: 'CONNECTED', scopes: ['all'], connectedAt: new Date(),
        accessTokenEnc: cipher.encrypt(`${platform}-secret-token-${n}-${externalAccountId}`), refreshTokenEnc: platform === 'YOUTUBE' || platform === 'TIKTOK' || platform === 'LINKEDIN' ? cipher.encrypt(`${platform}-refresh-${externalAccountId}`) : null,
        tokenExpiresAt: null, metadata: { permissionsMissing: [], criticalMissing: [] }, ...over,
      },
    });
    return a;
  }

  /** The plain access token of a stored account (to compare with what the platform received). */
  const tokenOf = (a: { accessTokenEnc: string }) => cipher.decrypt(a.accessTokenEnc);

  async function jpeg(c: Ctx, w = 800, h = 800) {
    const data = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 20 } } }).jpeg().toBuffer();
    const res = await request(http).post('/api/v1/media').set(as(c)).attach('file', data, { filename: 'post.jpg', contentType: 'image/jpeg' }).expect(201);
    return res.body as { id: string; mimeType: string };
  }
  async function png(c: Ctx) {
    const data = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#2060c0' } }).png().toBuffer();
    return (await request(http).post('/api/v1/media').set(as(c)).attach('file', data, { filename: 'post.png', contentType: 'image/png' }).expect(201)).body as { id: string };
  }
  /** A video file registered in the media library (stored bytes, READY), as an upload would leave it. */
  async function video(c: Ctx, o: { seconds?: number; width?: number; height?: number } = {}) {
    const key = `businesses/${c.businessId}/media/${randomBytes(6).toString('hex')}.mp4`;
    const bytes = fakeMp4();
    await storage.put(key, bytes, { contentType: 'video/mp4', contentLength: bytes.length });
    return prisma.mediaAsset.create({ data: { businessId: c.businessId, type: 'VIDEO', status: 'READY', storageKey: key, originalFilename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: bytes.length, width: o.width ?? 1080, height: o.height ?? 1920, durationSec: o.seconds ?? 20, scanStatus: 'CLEAN' } });
  }

  /** Waits until a publication of this entry exists and returns it. */
  const publicationOf = (entryId: string) => cal.waitFor(() => prisma.publication.findFirst({ where: { calendarEventId: entryId }, orderBy: { createdAt: 'desc' } }));
  /** Waits until the entry's publication reaches one of these statuses. */
  async function reach(entryId: string, statuses: string[], timeoutMs = 10_000) {
    return cal.waitFor(async () => {
      const p = await prisma.publication.findFirst({ where: { calendarEventId: entryId }, orderBy: { createdAt: 'desc' } });
      return p && statuses.includes(p.status) ? p : null;
    }, timeoutMs);
  }
  /** Makes an authorized entry due and lets the scheduler hand it to the publisher. */
  async function dispatch(entryId: string) {
    await cal.makeDue(entryId);
    await calendarWorker.tick();
  }
  /** Creates, approves, authorizes and dispatches an entry; resolves to its publication once the engine settled it. */
  async function publishEntry(editor: Ctx, admin: Ctx, body: Record<string, unknown>, statuses = ['PUBLISHED', 'FAILED', 'MANUAL_REQUIRED', 'AWAITING_PROVIDER', 'QUEUED']) {
    const e = await cal.scheduled(editor, admin, body);
    await dispatch(e.id);
    return { entry: e, pub: await reach(e.id, statuses) };
  }
  const entryRow = (id: string) => prisma.calendarEvent.findUniqueOrThrow({ where: { id }, include: { content: true } });
  const get = (c: Ctx, path: string) => request(http).get(`/api/v1/social${path}`).set(as(c));
  const post = (c: Ctx, path: string, body: Record<string, unknown> = {}) => request(http).post(`/api/v1/social${path}`).set(as(c)).send(body);

  /** A calendar entry action (submit, approve, authorize...). `post` and `get` below are for /social routes. */
  const act = cal.post;

  return { ...cal, act, hub, cipher, storage, publisher, socialWorker, calendarWorker, connect, tokenOf, jpeg, png, video, publicationOf, reach, dispatch, publishEntry, entryRow, get, post };
}
