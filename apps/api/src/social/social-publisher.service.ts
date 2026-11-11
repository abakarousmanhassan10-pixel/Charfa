import { ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type Publication, type SocialAccount } from '@touma/database';
import { PLATFORM_CAPABILITIES, roleHasPermission, type TikTokPostSettings, type ContentKind, type SocialPlatformId, type VideoSurface } from '@touma/shared';
import { composeText, probeMedia, SocialApiError, type MediaItem, type PlatformAdapter, type PublishableContent, type PublishOutcome as AdapterOutcome } from '@touma/social-connectors';
import { AuditService } from '../audit/audit.service';
import type { PublishingOutcome, PublishingRequest } from '../calendar/publishing';
import { CalendarResultsService } from '../calendar/calendar-results.service';
import { AppEnv, InjectEnv } from '../config';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { SocialAccountsService, SocialAuthError } from './social-accounts.service';
import { SOCIAL_ADAPTERS, type SocialAdapters } from './social-providers';
import { SocialQueueService } from './social-queue';

const TERMINAL = ['PUBLISHED', 'FAILED', 'CANCELLED', 'MANUAL_REQUIRED'] as const;
/** After these stages the platform can be asked what happened, so a retry cannot create a second post. */
const RESUMABLE_AFTER_SUBMIT = new Set(['SESSION', 'PUBLISH_INIT']);

interface Payload {
  kind: ContentKind;
  surface: VideoSurface;
  title: string | null;
  caption: string;
  hashtags: string[];
  callToAction: string | null;
  mediaIds: string[];
  contentVersion: number;
  tiktok?: TikTokPostSettings | null;
}

class RetryLater extends Error {
  constructor(readonly delayMs: number, readonly code: string, message: string) {
    super(message);
  }
}
class Final extends Error {
  constructor(readonly code: string, message: string, readonly unknown = false) {
    super(message);
  }
}

/**
 * The central publishing engine. Provider independent: platform specifics live in the adapters.
 *
 * One Publication per hand-off (the calendar's dispatch key is its idempotency key). The engine:
 *  - validates the content and its media against the platform's rules before anything is sent, and falls back to MANUAL
 *    publishing where the official API cannot publish the format;
 *  - checks the account is connected, authorized and not expired, refreshing the token when needed;
 *  - re-checks that the calendar entry is still approved and explicitly authorized at the moment of publishing;
 *  - never publishes twice: the provider step that creates the post is marked before it is sent, steps that open provider-side
 *    state are checkpointed, and when it cannot be known whether a post was created the publication is NOT retried automatically;
 *  - records the platform's post id and URL, and reports success only from a platform response.
 */
@Injectable()
export class SocialPublisherService {
  private readonly logger = new Logger('SocialPublisher');

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
    private readonly media: MediaService,
    private readonly queue: SocialQueueService,
    private readonly results: CalendarResultsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(SOCIAL_ADAPTERS) private readonly adapters: SocialAdapters,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /** True when at least one platform can publish. */
  available() {
    return Object.values(this.adapters).some((a) => a.isConfigured());
  }

  // ─── Hand-off from the calendar ─────────────────────────────────────────────

  async accept(req: PublishingRequest): Promise<PublishingOutcome> {
    const entry = await this.prisma.calendarEvent.findFirst({ where: { id: req.entryId, businessId: req.businessId, deletedAt: null }, include: { content: { include: { media: { orderBy: { position: 'asc' } } } } } });
    if (!entry?.content) return { status: 'REJECTED', code: 'CONTENT_INVALID', message: 'The calendar entry or its content no longer exists', retryable: false };
    const platform = req.platform as SocialPlatformId;
    if (!this.adapters[platform].isConfigured()) return { status: 'REJECTED', code: 'NOT_CONFIGURED', message: `${PLATFORM_CAPABILITIES[platform].label} publishing is not configured on this server`, retryable: false };
    const candidates = entry.socialAccountId
      ? await this.prisma.socialAccount.findMany({ where: { id: entry.socialAccountId, businessId: req.businessId, platform: req.platform, deletedAt: null } })
      : await this.prisma.socialAccount.findMany({ where: { businessId: req.businessId, platform: req.platform, status: 'CONNECTED', deletedAt: null } });
    if (!candidates.length) return { status: 'REJECTED', code: 'ACCOUNT_NOT_CONNECTED', message: `No connected ${PLATFORM_CAPABILITIES[platform].label} account. Connect one, then retry.`, retryable: false };
    if (candidates.length > 1) return { status: 'REJECTED', code: 'ACCOUNT_SELECTION_REQUIRED', message: 'Several accounts are connected for this platform. Choose which one this entry publishes to, then retry.', retryable: false };
    const account = candidates[0]!;
    const c = entry.content;
    const kind: ContentKind | null = c.type === 'TEXT' || c.type === 'IMAGE' || c.type === 'VIDEO' || c.type === 'CAROUSEL' ? c.type : null;
    if (!kind) return { status: 'REJECTED', code: 'CONTENT_INVALID', message: 'This content type cannot be published directly', retryable: false };
    const payload: Payload = { kind, surface: 'FEED', title: c.title, caption: c.caption ?? '', hashtags: c.hashtags, callToAction: c.callToAction, mediaIds: c.media.map((m) => m.mediaId), contentVersion: req.contentVersion, tiktok: ((c.platformOptions ?? null) as { tiktok?: TikTokPostSettings } | null)?.tiktok ?? null };
    try {
      const pub = await this.prisma.publication.create({
        data: {
          businessId: req.businessId, contentId: req.contentId, socialAccountId: account.id, calendarEventId: req.entryId, platform: req.platform, mode: 'API', status: 'QUEUED', scheduledAt: req.scheduledAt, timezone: req.timezone,
          idempotencyKey: req.idempotencyKey, payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
      await this.queue.enqueue(pub.id);
      return { status: 'ACCEPTED', reference: pub.id };
    } catch (err) {
      // The same hand-off arrived again (retry, worker restart): it is already known, nothing new is created.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.publication.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
        if (existing) {
          if (existing.status === 'QUEUED') await this.queue.enqueue(existing.id).catch(() => undefined);
          return { status: 'ACCEPTED', reference: existing.id };
        }
      }
      throw err;
    }
  }

  // ─── Processing ─────────────────────────────────────────────────────────────

  private surfaceFor(platform: SocialPlatformId, kind: ContentKind, m?: { width?: number | null; height?: number | null; durationSeconds?: number | null }): VideoSurface {
    if (kind !== 'VIDEO') return 'FEED';
    if (platform === 'INSTAGRAM') return 'REEL';
    if (platform === 'YOUTUBE' && m && (m.durationSeconds ?? Infinity) <= (PLATFORM_CAPABILITIES.YOUTUBE.shortVideoMaxSeconds ?? 60) && (m.height ?? 0) >= (m.width ?? 0) && m.height) return 'SHORT';
    return 'FEED';
  }

  private isPublicUrl(base: string) {
    try {
      const u = new URL(base);
      return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(u.hostname);
    } catch {
      return false;
    }
  }

  private async claim(id: string, from: Array<Publication['status']>) {
    const lock = new Date(Date.now() + 5 * 60_000);
    const res = await this.prisma.publication.updateMany({
      where: { id, status: { in: from }, outcomeUnknown: false, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      data: { status: 'PUBLISHING', lockedUntil: lock, attempts: { increment: 1 } },
    });
    return res.count > 0;
  }

  /** One processing pass of a queued publication. Never throws for publication-level problems: they are recorded. */
  async process(publicationId: string) {
    const pub = await this.prisma.publication.findUnique({ where: { id: publicationId } });
    if (!pub || (TERMINAL as readonly string[]).includes(pub.status) || pub.outcomeUnknown) return;
    if (pub.status === 'AWAITING_PROVIDER') return this.poll(publicationId);
    if (!(await this.claim(publicationId, ['QUEUED', 'PUBLISHING']))) return; // another worker has it, or it is waiting for a retry time
    await this.run(publicationId);
  }

  private async run(id: string, resumeOverride?: { stage: string; ref: string }) {
    let pub = await this.prisma.publication.findUniqueOrThrow({ where: { id }, include: { socialAccount: true, content: true, calendarEvent: true } });
    const platform = pub.platform as SocialPlatformId;
    const adapter = this.adapters[platform];
    const payload = pub.payload as unknown as Payload;
    try {
      // 0. A previous attempt may have sent the request that creates the post and died before recording the answer.
      if (pub.submitStartedAt && !pub.externalPostId && !(pub.providerStage && RESUMABLE_AFTER_SUBMIT.has(pub.providerStage))) {
        throw new Final('OUTCOME_UNKNOWN', 'An earlier attempt may have published this post before the worker stopped. Check the platform before trying again.', true);
      }
      if (pub.externalPostId) return await this.finish(pub, { status: 'PUBLISHED', externalPostId: pub.externalPostId, url: pub.externalUrl });

      // 1. The calendar entry must still be approved and explicitly authorized, for exactly this version.
      await this.assertAuthorized(pub);

      // 2. The account must be connected and its token valid (refreshed when needed).
      const { account, auth } = await this.accounts.authorized(pub.businessId, pub.socialAccountId).catch((e) => {
        if (e instanceof SocialAuthError) throw new Final(e.code, e.message);
        throw e;
      });
      if (account.businessId !== pub.businessId) throw new Final('ACCOUNT_NOT_AUTHORIZED', 'The account does not belong to this business');
      // A connection type that is disabled (LinkedIn organization publishing before LinkedIn's approval) is never used, even for an account stored earlier.
      const variant = (adapter.variants?.() ?? []).find((v) => v.accountType === account.accountType);
      if (variant && !variant.enabled) throw new Final('CONNECTION_TYPE_DISABLED', variant.reason ?? 'This kind of account cannot be published to at the moment');

      // 3. Content and media against the platform's rules.
      const media = await this.mediaItems(pub, platform, payload.mediaIds);
      const surface = this.surfaceFor(platform, payload.kind, media[0]);
      const content: PublishableContent = { kind: payload.kind, surface, title: payload.title, caption: payload.caption, hashtags: payload.hashtags, callToAction: payload.callToAction, media, tiktok: payload.tiktok ?? null };
      const issues = adapter.validate(content);
      if (issues.length) {
        if (issues.some((i) => i.manual)) return await this.toManual(pub, issues.filter((i) => i.manual).map((i) => i.message).join(' '));
        throw new Final(issues[0]!.code, issues.map((i) => i.message).join(' '));
      }
      if (PLATFORM_CAPABILITIES[platform].mediaByUrl && media.length && this.env.SOCIAL_PROVIDER_MODE === 'live' && !this.isPublicUrl(this.accounts.apiBase)) {
        throw new Final('MEDIA_URL_NOT_PUBLIC', `${PLATFORM_CAPABILITIES[platform].label} downloads media from a public https address. Set PUBLIC_API_URL to the public address of this API.`);
      }

      // 4. Publish.
      const resume = resumeOverride ?? (pub.providerStage && pub.providerRef ? { stage: pub.providerStage, ref: pub.providerRef } : null);
      let refreshedOnce = false;
      for (;;) {
        try {
          const out = await adapter.publish(auth, content, {
            idempotencyKey: pub.idempotencyKey, resume,
            checkpoint: async (stage, ref) => {
              await this.prisma.publication.update({ where: { id }, data: { providerStage: stage, providerRef: ref } });
            },
            beforeCreate: async () => {
              await this.prisma.publication.update({ where: { id }, data: { submitStartedAt: new Date() } });
            },
          });
          pub = await this.prisma.publication.findUniqueOrThrow({ where: { id }, include: { socialAccount: true, content: true, calendarEvent: true } });
          return await this.finish(pub, out);
        } catch (err) {
          if (err instanceof SocialApiError && err.kind === 'auth' && !refreshedOnce && adapter.supportsRefresh) {
            refreshedOnce = true;
            try {
              const fresh = await this.accounts.refresh(account);
              auth.tokens = this.accounts.tokens(fresh);
              continue; // not_created: the platform refused before creating anything
            } catch {
              throw new Final('TOKEN_EXPIRED', 'The authorization expired and could not be renewed. Reconnect the account.');
            }
          }
          throw err;
        }
      }
    } catch (err) {
      await this.handleError(id, err);
    }
  }

  private async assertAuthorized(pub: Publication & { content: { status: string; version: number; approvedVersion: number | null } | null; calendarEvent: { authorizedById: string | null; authorizedVersion: number | null; status: string; deletedAt: Date | null } | null }) {
    const payload = pub.payload as unknown as Payload;
    const c = pub.content;
    const e = pub.calendarEvent;
    if (!e || e.deletedAt || e.status === 'CANCELLED' || !c) throw new Final('ACCOUNT_NOT_AUTHORIZED', 'The calendar entry was cancelled or deleted');
    if (!['SCHEDULED', 'PUBLISHING'].includes(c.status) || c.version !== payload.contentVersion || c.approvedVersion !== c.version || e.authorizedVersion !== c.version || !e.authorizedById) {
      throw new Final('CONTENT_INVALID', 'The content changed or its approval or authorization was withdrawn after it was scheduled. It was not published.');
    }
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: e.authorizedById, businessId: pub.businessId } } });
    if (!m || m.status !== 'ACTIVE' || !roleHasPermission(m.role, 'publication.schedule')) throw new Final('ACCOUNT_NOT_AUTHORIZED', 'The person who authorized this publication is no longer allowed to schedule publications');
  }

  private async mediaItems(pub: Publication, platform: SocialPlatformId, ids: string[]): Promise<MediaItem[]> {
    if (!ids.length) return [];
    const rows = await this.media.publishable(pub.businessId, ids).catch(() => {
      throw new Final('MEDIA_INVALID', 'A media file of this post was deleted or is not ready');
    });
    const limits = PLATFORM_CAPABILITIES[platform];
    const items: MediaItem[] = [];
    for (const m of rows) {
      const item: MediaItem = { id: m.id, url: `${this.accounts.apiBase}${m.relativeUrl}`, mimeType: m.mimeType, sizeBytes: m.sizeBytes, width: m.width, height: m.height, durationSeconds: m.durationSeconds, altText: m.altText, read: m.read };
      // Facts are read from the file's own bytes, not from its name or the declared type. Files already over the platform's size
      // limit are not read: validation rejects them by size without loading up to a gigabyte into memory.
      const isVideo = m.mimeType.startsWith('video/');
      const limit = isVideo ? limits.videoMaxBytes : limits.imageMaxBytes;
      if (m.sizeBytes <= limit) {
        const facts = probeMedia(await m.read());
        const expected = isVideo ? ['mp4', 'mov'] : ['jpeg', 'png'];
        if (!expected.includes(facts.container)) throw new Final('MEDIA_INVALID', `The file's content is not a valid ${isVideo ? 'MP4/MOV video' : 'JPEG/PNG image'}, whatever its name says. Export it again and upload the new file.`);
        if (facts.width && facts.height) { item.width = facts.width; item.height = facts.height; }
        if (facts.durationSeconds !== undefined) item.durationSeconds = facts.durationSeconds;
        item.videoCodec = facts.videoCodec ?? null;
        item.audioCodec = facts.audioCodec ?? null;
        if (isVideo && !facts.videoCodec) throw new Final('MEDIA_INVALID', 'The video track of this file could not be read. Export it again as MP4 (H.264 video, AAC audio).');
      }
      items.push(item);
    }
    return items;
  }

  // ─── Outcomes ───────────────────────────────────────────────────────────────

  private async finish(pub: Publication & { socialAccount?: SocialAccount }, out: AdapterOutcome) {
    if (out.status === 'PUBLISHED') {
      const res = await this.prisma.publication.updateMany({
        where: { id: pub.id, status: { notIn: ['PUBLISHED', 'CANCELLED'] } },
        data: { status: 'PUBLISHED', externalPostId: out.externalPostId, externalUrl: out.url ?? null, publishedAt: new Date(), confirmedByProvider: true, visibilityNote: out.notice ?? null, lockedUntil: null, lastError: null, errorCode: null, submitStartedAt: null, nextCheckAt: null, providerResponse: (out.raw ?? undefined) as Prisma.InputJsonValue | undefined },
      });
      if (res.count && pub.calendarEventId) {
        await this.audit.record({ action: 'social.published', actorId: null, businessId: pub.businessId, entityType: 'Publication', entityId: pub.id, metadata: { platform: pub.platform, externalPostId: out.externalPostId, url: out.url ?? null } });
        await this.results.recordPublished(pub.calendarEventId, { publishedAt: new Date(), externalUrl: out.url ?? null, publicationId: pub.id });
      }
      return;
    }
    // Accepted, still processing on the platform: follow it.
    await this.prisma.publication.update({
      where: { id: pub.id },
      data: { status: 'AWAITING_PROVIDER', providerRef: out.ref, providerStage: out.stage, lockedUntil: null, nextCheckAt: new Date(Date.now() + (out.retryAfterMs ?? 10_000)) },
    });
  }

  private async toManual(pub: Publication, message: string) {
    await this.prisma.publication.update({ where: { id: pub.id }, data: { status: 'MANUAL_REQUIRED', mode: 'MANUAL', errorCode: 'FORMAT_UNSUPPORTED', lastError: message.slice(0, 500), lockedUntil: null } });
    await this.audit.record({ action: 'social.manual_required', actorId: null, businessId: pub.businessId, entityType: 'Publication', entityId: pub.id, metadata: { platform: pub.platform, reason: message.slice(0, 300) } });
    const e = pub.calendarEventId ? await this.prisma.calendarEvent.findUnique({ where: { id: pub.calendarEventId }, select: { title: true, authorizedById: true } }) : null;
    await this.notifications.notify({
      businessId: pub.businessId, permission: 'publication.schedule', userIds: e?.authorizedById ? [e.authorizedById] : [], type: 'social.manual_required', title: `Publish manually: ${e?.title ?? pub.platform}`, body: message.slice(0, 300),
      data: { publicationId: pub.id, entryTitle: e?.title ?? '', platform: pub.platform }, dedupeKey: `manual:${pub.id}`,
    });
  }

  private async handleError(id: string, err: unknown) {
    const pub = await this.prisma.publication.findUniqueOrThrow({ where: { id } });
    const backoff = this.env.SOCIAL_PUBLISH_BACKOFF_MS * 2 ** Math.max(0, pub.attempts - 1);
    const started = Boolean(pub.submitStartedAt);
    if (err instanceof Final) return this.fail(pub, err.code, err.message, err.unknown);
    if (err instanceof RetryLater) return this.retryOrFail(pub, err.delayMs, err.code, err.message);
    if (err instanceof SocialApiError) {
      const notCreated = err.outcome === 'not_created';
      if (notCreated && started) await this.prisma.publication.update({ where: { id }, data: { submitStartedAt: null } }); // refused: nothing was created
      switch (err.kind) {
        case 'auth': {
          const acc = await this.prisma.socialAccount.findUnique({ where: { id: pub.socialAccountId } });
          if (acc) await this.accounts.needsReconnect(acc, 'The platform rejected the access token. Reconnect the account.');
          return this.fail(pub, 'TOKEN_EXPIRED', 'The platform rejected the access token. Reconnect the account and retry.');
        }
        case 'permission': {
          await this.prisma.socialAccount.update({ where: { id: pub.socialAccountId }, data: { status: 'PERMISSION_MISSING', lastError: err.message.slice(0, 500) } });
          return this.fail(pub, 'PERMISSION_MISSING', err.message);
        }
        case 'rate_limit':
          return this.retryOrFail(pub, err.opts.retryAfterMs ?? backoff, 'RATE_LIMITED', err.message);
        case 'validation':
          // The platform refused, but said the content already exists (LinkedIn DUPLICATE_POST): it may be ours, so reconcile instead of calling it a plain failure.
          if (err.outcome === 'unknown') return this.fail(pub, 'OUTCOME_UNKNOWN', `${err.message} It may be this very post: check the platform before trying again.`, true);
          return this.fail(pub, 'PLATFORM_REJECTED', err.message);
        case 'transient':
        case 'timeout':
          if (started && !notCreated) return this.fail(pub, 'OUTCOME_UNKNOWN', 'The platform did not answer clearly, so the post may have been published. Check the platform before trying again.', true);
          return this.retryOrFail(pub, backoff, 'PLATFORM_ERROR', err.message);
        default:
          return this.fail(pub, 'PLATFORM_ERROR', err.message);
      }
    }
    this.logger.error(`publication ${id}: unexpected error: ${(err as Error).message}`);
    if (started) return this.fail(pub, 'OUTCOME_UNKNOWN', 'An unexpected error happened while publishing, so the post may have been published. Check the platform before trying again.', true);
    return this.retryOrFail(pub, backoff, 'PLATFORM_ERROR', (err as Error).message.slice(0, 300));
  }

  /** A temporary problem: try again later (a stored time, picked up by the worker), or give up after the allowed attempts. */
  private async retryOrFail(pub: Publication, delayMs: number, code: string, message: string) {
    if (pub.attempts >= this.env.SOCIAL_PUBLISH_ATTEMPTS) return this.fail(pub, code, `${message} (gave up after ${pub.attempts} attempts)`);
    await this.prisma.publication.update({ where: { id: pub.id }, data: { status: 'QUEUED', lockedUntil: null, lastError: message.slice(0, 500), errorCode: code, nextCheckAt: new Date(Date.now() + Math.min(delayMs, 3_600_000)) } });
  }

  private async fail(pub: Publication, code: string, message: string, unknown = false) {
    const res = await this.prisma.publication.updateMany({
      where: { id: pub.id, status: { notIn: ['PUBLISHED', 'CANCELLED'] } },
      data: { status: 'FAILED', errorCode: unknown ? 'OUTCOME_UNKNOWN' : code, lastError: message.slice(0, 500), outcomeUnknown: unknown, lockedUntil: null, nextCheckAt: null },
    });
    if (!res.count) return;
    await this.audit.record({ action: unknown ? 'social.outcome_unknown' : 'social.publish_failed', actorId: null, businessId: pub.businessId, entityType: 'Publication', entityId: pub.id, metadata: { platform: pub.platform, code, message: message.slice(0, 300) } });
    if (pub.calendarEventId) await this.results.recordFailed(pub.calendarEventId, { code: unknown ? 'OUTCOME_UNKNOWN' : code, message });
  }

  // ─── Following in-flight publications ───────────────────────────────────────

  async poll(publicationId: string) {
    const lock = new Date(Date.now() + 2 * 60_000);
    const claimed = await this.prisma.publication.updateMany({ where: { id: publicationId, status: 'AWAITING_PROVIDER', OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, data: { lockedUntil: lock } });
    if (!claimed.count) return;
    const pub = await this.prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
    const adapter = this.adapters[pub.platform as SocialPlatformId];
    try {
      if (Date.now() - pub.createdAt.getTime() > this.env.SOCIAL_PROCESSING_TIMEOUT_MINUTES * 60_000) {
        return await this.fail(pub, 'PROCESSING_TIMEOUT', 'The platform did not finish processing this post in time. It may still appear on the platform: check before trying again.', true);
      }
      const { auth } = await this.accounts.authorized(pub.businessId, pub.socialAccountId).catch((e) => {
        if (e instanceof SocialAuthError) throw new Final(e.code, e.message);
        throw e;
      });
      const st = await adapter.status(auth, pub.providerRef ?? '', pub.providerStage ?? '');
      if (st.status === 'PUBLISHED') return await this.finish(pub, st);
      if (st.status === 'FAILED') return await this.fail(pub, st.code, st.message);
      if (st.retryAfterMs === 0) {
        // The platform finished preparing the media: continue with the step that creates the post.
        await this.prisma.publication.update({ where: { id: pub.id }, data: { status: 'PUBLISHING', lockedUntil: new Date(Date.now() + 5 * 60_000), providerStage: st.stage, providerRef: st.ref } });
        return await this.run(pub.id, { stage: st.stage, ref: st.ref });
      }
      await this.prisma.publication.update({ where: { id: pub.id }, data: { lockedUntil: null, nextCheckAt: new Date(Date.now() + (st.retryAfterMs ?? 10_000)) } });
    } catch (err) {
      if (err instanceof Final) return this.fail(pub, err.code, err.message, err.unknown);
      if (err instanceof SocialApiError && (err.kind === 'transient' || err.kind === 'timeout' || err.kind === 'rate_limit')) {
        await this.prisma.publication.update({ where: { id: pub.id }, data: { lockedUntil: null, nextCheckAt: new Date(Date.now() + 30_000), lastError: err.message.slice(0, 500) } });
        return;
      }
      return this.fail(pub, 'PLATFORM_ERROR', (err as Error).message.slice(0, 300));
    }
  }

  // ─── People acting on publications ──────────────────────────────────────────

  async retry(tenant: TenantContext, id: string, confirmNotPublished: boolean) {
    const pub = await this.prisma.publication.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!pub) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' });
    if (pub.status !== 'FAILED') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a failed publication can be retried' });
    if (pub.outcomeUnknown && !confirmNotPublished) {
      throw new UnprocessableEntityException({ code: 'OUTCOME_UNKNOWN', message: 'This post may already be on the platform. Check the platform; if it is not there, confirm and retry. If it is there, mark it as published instead.' });
    }
    const e = pub.calendarEventId ? await this.prisma.calendarEvent.findUnique({ where: { id: pub.calendarEventId }, include: { content: true } }) : null;
    const payload = pub.payload as unknown as Payload;
    if (!e?.content || e.content.version !== payload.contentVersion || e.content.approvedVersion !== e.content.version || !e.authorizedById) {
      throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'The content changed or its authorization was withdrawn. Approve and schedule it again from the calendar.' });
    }
    const res = await this.prisma.publication.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'QUEUED', attempts: 0, lastError: null, errorCode: null, outcomeUnknown: false, reconcileResult: null, reconcileNote: null, submitStartedAt: null, nextCheckAt: null, lockedUntil: null, providerRef: pub.providerStage && RESUMABLE_AFTER_SUBMIT.has(pub.providerStage) ? pub.providerRef : null, providerStage: pub.providerStage && RESUMABLE_AFTER_SUBMIT.has(pub.providerStage) ? pub.providerStage : null },
    });
    if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This publication changed' });
    await this.audit.record({ action: 'social.publish_retried', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Publication', entityId: id, metadata: { platform: pub.platform, confirmedNotPublished: confirmNotPublished } });
    if (pub.calendarEventId) await this.results.reopen(pub.calendarEventId);
    await this.queue.forget(id);
    await this.queue.enqueue(id);
    return this.get(tenant, id);
  }

  // ─── Reconciliation of unknown outcomes ─────────────────────────────────────

  /**
   * An unknown outcome is never retried blindly. The platform is asked what exists:
   *  - FOUND: exactly one post with our text since the attempt began. It is recorded as published, confirmed by the platform;
   *  - NOT_FOUND / AMBIGUOUS / UNAVAILABLE: nothing changes except the note. A person still decides (retry only after they confirm
   *    the post is not there, or mark it published). A listing that does not show the post is not proof that it was not created.
   * Read-only on the platform: this never creates anything.
   */
  async reconcile(publicationId: string, by: { userId: string | null; businessId?: string } = { userId: null }) {
    const pub = await this.prisma.publication.findFirst({ where: { id: publicationId, ...(by.businessId ? { businessId: by.businessId } : {}) }, include: { content: true } });
    if (!pub) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' });
    if (pub.status !== 'FAILED' || !pub.outcomeUnknown) throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a publication with an unknown outcome can be reconciled' });
    const claimed = await this.prisma.publication.updateMany({ where: { id: pub.id, status: 'FAILED', outcomeUnknown: true, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, data: { lockedUntil: new Date(Date.now() + 2 * 60_000), reconcileAttempts: { increment: 1 } } });
    if (!claimed.count) throw new ConflictException({ code: 'RECONCILE_IN_PROGRESS', message: 'This publication is being checked right now' });
    const adapter = this.adapters[pub.platform as SocialPlatformId];
    const payload = (pub.payload ?? {}) as Partial<Payload>;
    let outcome: Awaited<ReturnType<PlatformAdapter['reconcile']>>;
    try {
      const { auth } = await this.accounts.authorized(pub.businessId, pub.socialAccountId);
      const text = composeText({ kind: payload.kind ?? 'TEXT', surface: payload.surface ?? 'FEED', title: payload.title, caption: payload.caption ?? '', hashtags: payload.hashtags ?? [], callToAction: payload.callToAction, media: [] });
      outcome = await adapter.reconcile(auth, { text, title: payload.title, since: pub.submitStartedAt ?? pub.createdAt, ref: pub.providerRef, stage: pub.providerStage });
    } catch (e) {
      outcome = { result: 'UNAVAILABLE', reason: e instanceof SocialAuthError ? e.message : 'The platform could not be asked.' };
    }
    const base = { lockedUntil: null, reconciledAt: new Date(), reconcileResult: outcome.result };
    if (outcome.result === 'FOUND') {
      const res = await this.prisma.publication.updateMany({
        where: { id: pub.id, status: 'FAILED', outcomeUnknown: true },
        data: { ...base, status: 'PUBLISHED', externalPostId: outcome.externalPostId, externalUrl: outcome.url ?? null, publishedAt: new Date(), confirmedByProvider: true, reconciledFound: true, outcomeUnknown: false, lastError: null, errorCode: null, submitStartedAt: null, nextCheckAt: null, reconcileNote: 'The platform lists this post.', providerResponse: (outcome.raw ?? undefined) as Prisma.InputJsonValue | undefined },
      });
      if (res.count) {
        await this.audit.record({ action: 'social.reconciled_found', actorId: by.userId, businessId: pub.businessId, entityType: 'Publication', entityId: pub.id, metadata: { platform: pub.platform, externalPostId: outcome.externalPostId } });
        if (pub.calendarEventId) await this.results.recordPublished(pub.calendarEventId, { publishedAt: new Date(), externalUrl: outcome.url ?? null, publicationId: pub.id });
      }
    } else {
      const note =
        outcome.result === 'NOT_FOUND' ? `Checked ${outcome.checked} recent post(s) on the platform and none matches. A platform listing can lag: look at the platform yourself, then retry or mark it published.`
        : outcome.result === 'AMBIGUOUS' ? `${outcome.candidates.length} posts on the platform match this text (${outcome.candidates.map((c) => c.url ?? c.id).join(', ')}). Open them and decide.`
        : outcome.reason;
      await this.prisma.publication.update({ where: { id: pub.id }, data: { ...base, reconcileNote: note.slice(0, 500) } });
      // After the last automatic check the decision is a person's: tell the people who can act, once.
      if (claimed.count && pub.reconcileAttempts + 1 >= 3 && !by.userId) {
        const ev = pub.calendarEventId ? await this.prisma.calendarEvent.findUnique({ where: { id: pub.calendarEventId }, select: { title: true, authorizedById: true } }) : null;
        await this.notifications.notify({
          businessId: pub.businessId, permission: 'publication.schedule', userIds: ev?.authorizedById ? [ev.authorizedById] : [], type: 'social.reconcile_needs_decision', title: `Check on ${pub.platform}: ${ev?.title ?? 'a post'}`,
          body: 'TOUMA could not tell whether this post was published. Open it on the platform, then mark it published or retry it.', data: { publicationId: pub.id, entryTitle: ev?.title ?? '', platform: pub.platform, result: outcome.result }, dedupeKey: `reconcile-decision:${pub.id}`,
        });
      }
      await this.audit.record({ action: 'social.reconciled_uncertain', actorId: by.userId, businessId: pub.businessId, entityType: 'Publication', entityId: pub.id, metadata: { platform: pub.platform, result: outcome.result } });
    }
    return this.prisma.publication.findUniqueOrThrow({ where: { id: pub.id }, include: { socialAccount: { select: { displayName: true, username: true, platform: true } }, calendarEvent: { select: { title: true } } } }).then((p) => this.dto(p, true));
  }

  /** Unknown outcomes the worker should look into on its own: a few attempts, spaced out. After that a person decides. */
  reconcilable(now = new Date()) {
    return this.prisma.publication.findMany({
      where: { status: 'FAILED', outcomeUnknown: true, reconcileAttempts: { lt: 3 }, OR: [{ reconciledAt: null, updatedAt: { lt: new Date(now.getTime() - 60_000) } }, { reconciledAt: { lt: new Date(now.getTime() - 15 * 60_000) }, reconcileResult: { in: ['NOT_FOUND', 'UNAVAILABLE'] } }], AND: [{ OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }] },
      select: { id: true }, take: 25,
    });
  }

  /** The person published it themselves (manual fallback, or after an unknown outcome). Recorded as manual, never as provider-confirmed. */
  async manualComplete(tenant: TenantContext, id: string, externalUrl?: string) {
    const pub = await this.prisma.publication.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!pub) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' });
    if (pub.status !== 'MANUAL_REQUIRED' && !(pub.status === 'FAILED' && pub.outcomeUnknown)) throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a publication waiting for manual publishing, or one with an unknown outcome, can be marked as published' });
    const res = await this.prisma.publication.updateMany({ where: { id, status: pub.status }, data: { status: 'PUBLISHED', mode: 'MANUAL', confirmedByProvider: false, manualCompletedById: tenant.userId, externalUrl: externalUrl ?? null, publishedAt: new Date(), outcomeUnknown: false, lastError: null, errorCode: null } });
    if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This publication changed' });
    await this.audit.record({ action: 'social.manual_published', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Publication', entityId: id, metadata: { platform: pub.platform, externalUrl: externalUrl ?? null } });
    if (pub.calendarEventId) await this.results.recordPublished(pub.calendarEventId, { publishedAt: new Date(), externalUrl: externalUrl ?? null, publicationId: id, manual: true });
    return this.get(tenant, id);
  }

  async cancelForEntry(entryId: string) {
    await this.prisma.publication.updateMany({ where: { calendarEventId: entryId, status: { in: ['QUEUED', 'PENDING'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  async dto(p: Publication & { socialAccount?: { displayName: string | null; username: string | null; platform: string } | null; calendarEvent?: { title: string } | null }, detail = false) {
    const payload = (p.payload ?? {}) as Partial<Payload>;
    const out = {
      id: p.id, platform: p.platform, status: p.status, mode: p.mode, scheduledAt: p.scheduledAt.toISOString(), timezone: p.timezone, attempts: p.attempts, entryId: p.calendarEventId, entryTitle: p.calendarEvent?.title ?? null,
      accountId: p.socialAccountId, accountName: p.socialAccount?.displayName ?? p.socialAccount?.username ?? null, kind: payload.kind ?? null, errorCode: p.errorCode, error: p.lastError, outcomeUnknown: p.outcomeUnknown,
      confirmedByProvider: p.confirmedByProvider, visibilityNote: p.visibilityNote, reconcile: p.reconcileResult ? { result: p.reconcileResult, note: p.reconcileNote, attempts: p.reconcileAttempts, at: p.reconciledAt?.toISOString() ?? null, foundOnPlatform: p.reconciledFound } : null, externalPostId: p.externalPostId, externalUrl: p.externalUrl, publishedAt: p.publishedAt?.toISOString() ?? null, nextCheckAt: p.nextCheckAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(),
    };
    if (!detail || p.status !== 'MANUAL_REQUIRED') return out;
    const ids = payload.mediaIds ?? [];
    const rows = ids.length ? await this.prisma.mediaAsset.findMany({ where: { id: { in: ids }, businessId: p.businessId, deletedAt: null } }) : [];
    return {
      ...out,
      manualPackage: {
        text: [payload.caption, payload.callToAction, (payload.hashtags ?? []).map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n'),
        media: rows.map((m) => ({ id: m.id, filename: m.originalFilename, mimeType: m.mimeType, downloadUrl: `${this.media.urlFor(m.id)}&download=1` })),
      },
    };
  }

  async get(tenant: TenantContext, id: string) {
    const p = await this.prisma.publication.findFirst({ where: { id, businessId: tenant.businessId }, include: { socialAccount: { select: { displayName: true, username: true, platform: true } }, calendarEvent: { select: { title: true } } } });
    if (!p) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' });
    return this.dto(p, true);
  }

  async list(tenant: TenantContext, q: { platform?: string; status?: string; accountId?: string; page: number; pageSize: number; scope?: 'history' | 'queue' }) {
    const where: Prisma.PublicationWhereInput = {
      businessId: tenant.businessId,
      ...(q.platform ? { platform: q.platform as never } : {}),
      ...(q.status ? { status: q.status as never } : q.scope === 'queue' ? { status: { in: ['QUEUED', 'PENDING', 'PUBLISHING', 'AWAITING_PROVIDER', 'MANUAL_REQUIRED'] } } : {}),
      ...(q.accountId ? { socialAccountId: q.accountId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.publication.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { socialAccount: { select: { displayName: true, username: true, platform: true } }, calendarEvent: { select: { title: true } } } }),
      this.prisma.publication.count({ where }),
    ]);
    return { items: await Promise.all(rows.map((r) => this.dto(r))), total, page: q.page, pageSize: q.pageSize, pageCount: Math.max(1, Math.ceil(total / q.pageSize)) };
  }

  async queueOverview(tenant: TenantContext) {
    const [counts, byStatus, upcoming, heartbeat] = await Promise.all([
      this.queue.counts().catch(() => null),
      this.prisma.publication.groupBy({ by: ['status'], where: { businessId: tenant.businessId }, _count: true }),
      this.prisma.calendarEvent.findMany({ where: { businessId: tenant.businessId, deletedAt: null, status: { not: 'CANCELLED' }, scheduledAt: { gte: new Date() }, content: { status: 'SCHEDULED' } }, orderBy: { scheduledAt: 'asc' }, take: 20, select: { id: true, title: true, platform: true, scheduledAt: true, timezone: true, socialAccountId: true } }),
      this.prisma.publication.count({ where: { businessId: tenant.businessId, status: { in: ['QUEUED', 'PUBLISHING', 'AWAITING_PROVIDER'] } } }),
    ]);
    return {
      queue: counts, inFlight: heartbeat, byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      upcoming: upcoming.map((e) => ({ id: e.id, title: e.title, platform: e.platform, scheduledAt: e.scheduledAt.toISOString(), timezone: e.timezone, accountId: e.socialAccountId })),
    };
  }

  /** Account ids named by a hand-off, used by the worker to decide what to re-queue. */
  stuckQueued(now = new Date()) {
    return this.prisma.publication.findMany({ where: { status: 'QUEUED', OR: [{ nextCheckAt: { lte: now } }, { nextCheckAt: null, createdAt: { lt: new Date(now.getTime() - 60_000) } }] }, select: { id: true, nextCheckAt: true }, take: 100 });
  }

  adapterFor(platform: string): PlatformAdapter {
    return this.adapters[platform as SocialPlatformId];
  }
}
