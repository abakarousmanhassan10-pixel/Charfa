import { PublicationGate } from './publication-gate';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { roleHasPermission } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { bullConnection } from '../ai/ai-queue';
import { AppEnv, InjectEnv } from '../config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarResultsService } from './calendar-results.service';
import { CALENDAR_QUEUE, CALENDAR_WORKER_HEARTBEAT_KEY, CalendarQueueService, type CalendarJobData } from './calendar-queue';
import { PUBLISHING_GATEWAY, type PublishingGateway } from './publishing';

/**
 * The calendar's scheduler. It never publishes: when an authorized entry is due it hands it to the publishing
 * interface (PUBLISHING_GATEWAY, implemented in Phase 6).
 *
 * Every tick (CALENDAR_TICK_MS) the worker, with the database as the single source of truth:
 *   1. hands due SCHEDULED entries to the queue. The claim is one conditional UPDATE, and the job id is the dispatch key
 *      `<entry>-<approved version>-<time>`, so the same hand-off can neither be claimed nor queued twice;
 *   2. if no publisher is available, marks them BLOCKED once (and notifies) instead of failing them, and releases them
 *      when one appears;
 *   3. sends "upcoming publication" reminders once per entry and time;
 *   4. recovers from crashes: claims whose worker died are released and re-queued (the publisher is idempotent on the key).
 * The job re-checks everything (still scheduled, still the approved version, authorizer still allowed) before it submits.
 */
@Injectable()
export class CalendarWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CalendarWorker');
  private worker?: Worker<CalendarJobData>;
  private connection?: IORedis;
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: CalendarQueueService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly results: CalendarResultsService,
    private readonly gate: PublicationGate,
    @Inject(PUBLISHING_GATEWAY) private readonly gateway: PublishingGateway,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async onApplicationBootstrap() {
    if (this.env.AI_WORKER_INLINE) await this.start();
  }

  get running() {
    return Boolean(this.worker?.isRunning());
  }

  async start() {
    if (this.worker) return;
    this.connection = bullConnection(this.env);
    this.worker = new Worker<CalendarJobData>(CALENDAR_QUEUE, (job) => this.handle(job), { connection: this.connection, concurrency: 4 });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.logger.error(`worker error: ${err.message}`));
    const beat = () => this.connection?.set(CALENDAR_WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch(() => undefined);
    await beat();
    this.timers.push(setInterval(beat, 30_000).unref());
    this.timers.push(setInterval(() => void this.tick().catch((e) => this.logger.error(`tick failed: ${(e as Error).message}`)), this.env.CALENDAR_TICK_MS).unref());
    this.logger.log(`Calendar worker listening on ${CALENDAR_QUEUE} (tick ${this.env.CALENDAR_TICK_MS} ms, publisher: ${this.gateway.name})`);
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }

  static dispatchKey(e: { id: string; authorizedVersion: number | null; scheduledAt: Date }) {
    return `${e.id}-${e.authorizedVersion ?? 0}-${e.scheduledAt.getTime()}`;
  }

  // ─── Tick ───────────────────────────────────────────────────────────────────

  async tick(now = new Date()) {
    if (this.ticking) return { handed: 0, blocked: 0, reminded: 0, recovered: 0 };
    this.ticking = true;
    try {
      const recovered = await this.recover(now);
      const reminded = await this.remind(now);
      const { handed, blocked } = await this.dispatchDue(now);
      return { handed, blocked, reminded, recovered };
    } finally {
      this.ticking = false;
    }
  }

  private async dispatchDue(now: Date) {
    const available = await this.gateway.isAvailable();
    const due = await this.prisma.calendarEvent.findMany({
      where: { deletedAt: null, status: { not: 'CANCELLED' }, scheduledAt: { lte: now }, dispatchState: { in: available ? ['NONE', 'BLOCKED'] : ['NONE'] }, content: { status: 'SCHEDULED', deletedAt: null } },
      select: { id: true, businessId: true, title: true, authorizedVersion: true, authorizedById: true, scheduledAt: true, platform: true },
      orderBy: { scheduledAt: 'asc' },
      take: 100,
    });
    let handed = 0;
    let blocked = 0;
    for (const e of due) {
      if (!available) {
        const res = await this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchState: 'NONE' }, data: { dispatchState: 'BLOCKED', lastError: 'Publishing is not connected yet' } });
        if (res.count) {
          blocked++;
          await this.notifications.notify({ businessId: e.businessId, permission: 'publication.schedule', type: 'calendar.blocked', title: `Due but not published: ${e.title}`, body: 'Publishing is not connected, so this entry was not published.', data: { entryId: e.id, entryTitle: e.title, platform: e.platform }, dedupeKey: `blocked:${e.id}:${e.scheduledAt.getTime()}` });
        }
        continue;
      }
      const key = CalendarWorkerService.dispatchKey(e);
      const claim = await this.prisma.calendarEvent.updateMany({
        where: { id: e.id, dispatchState: { in: ['NONE', 'BLOCKED'] }, content: { status: 'SCHEDULED' } },
        data: { dispatchState: 'QUEUED', dispatchKey: key, lockedUntil: new Date(now.getTime() + 2 * this.env.CALENDAR_LOCK_SECONDS * 1000), lastError: null },
      });
      if (!claim.count) continue;
      try {
        await this.queue.enqueue({ entryId: e.id, dispatchKey: key });
        handed++;
      } catch {
        await this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchState: 'QUEUED', dispatchKey: key }, data: { dispatchState: 'NONE', dispatchKey: null, lockedUntil: null } });
      }
    }
    return { handed, blocked };
  }

  private async remind(now: Date) {
    const until = new Date(now.getTime() + this.env.CALENDAR_REMINDER_MINUTES * 60_000);
    const soon = await this.prisma.calendarEvent.findMany({
      where: { deletedAt: null, status: { not: 'CANCELLED' }, scheduledAt: { gt: now, lte: until }, reminderSentAt: null, content: { status: 'SCHEDULED', deletedAt: null } },
      select: { id: true, businessId: true, title: true, platform: true, scheduledAt: true, authorizedById: true },
      take: 200,
    });
    let n = 0;
    for (const e of soon) {
      const claim = await this.prisma.calendarEvent.updateMany({ where: { id: e.id, reminderSentAt: null }, data: { reminderSentAt: now } });
      if (!claim.count) continue;
      n++;
      await this.notifications.notify({
        businessId: e.businessId, permission: 'publication.schedule', userIds: e.authorizedById ? [e.authorizedById] : [], type: 'calendar.upcoming', title: `Upcoming publication: ${e.title}`,
        data: { entryId: e.id, entryTitle: e.title, platform: e.platform, scheduledAt: e.scheduledAt.toISOString() }, dedupeKey: `upcoming:${e.id}:${e.scheduledAt.getTime()}`,
      });
    }
    return n;
  }

  /** Releases claims whose worker or job is gone. DISPATCHING claims are re-queued with the SAME key (the publisher dedupes on it). */
  private async recover(now: Date) {
    const stale = await this.prisma.calendarEvent.findMany({ where: { dispatchState: { in: ['QUEUED', 'DISPATCHING'] }, lockedUntil: { lt: now }, deletedAt: null }, select: { id: true, dispatchKey: true, dispatchState: true }, take: 100 });
    let n = 0;
    for (const e of stale) {
      const job = e.dispatchKey ? await this.queue.getJob(e.dispatchKey) : undefined;
      const state = job ? await job.getState() : 'missing';
      if (e.dispatchState === 'QUEUED' && (state === 'waiting' || state === 'active' || state === 'delayed')) continue;
      if (state === 'active' || state === 'delayed') continue;
      const res = await this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchState: e.dispatchState, lockedUntil: { lt: now } }, data: { dispatchState: 'NONE', dispatchKey: null, lockedUntil: null } });
      if (res.count) {
        n++;
        if (job && (state === 'failed' || state === 'completed')) await job.remove().catch(() => undefined);
        this.logger.warn(`released stale dispatch of entry ${e.id} (${e.dispatchState}, job ${state})`);
      }
    }
    return n;
  }

  // ─── Job ────────────────────────────────────────────────────────────────────

  async handle(job: Job<CalendarJobData>) {
    const attempt = job.attemptsMade + 1;
    const max = job.opts.attempts ?? 1;
    const e = await this.prisma.calendarEvent.findFirst({ where: { id: job.data.entryId, deletedAt: null }, include: { content: { include: { media: { select: { mediaId: true }, orderBy: { position: 'asc' } } } } } });
    if (!e || e.dispatchKey !== job.data.dispatchKey || e.dispatchState !== 'QUEUED') return; // duplicate or stale delivery
    const c = e.content;
    // The single publication gate: tenant, approved version and snapshot, approved account, schedule, cancellation, switch, limits.
    const gate = await this.gate.check({ businessId: e.businessId, entryId: e.id });
    if (!gate.ok) {
      if (gate.code === 'CONTENT_INVALID' || gate.blocked) {
        await this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchKey: e.dispatchKey }, data: { dispatchState: 'NONE', dispatchKey: null, lockedUntil: null, ...(gate.blocked ? { lastError: `${gate.code}: ${gate.message}`.slice(0, 500) } : {}) } });
        return;
      }
      const code = gate.revoked ? 'AUTHORIZATION_REVOKED' : gate.code;
      await this.fail(e.id, code, gate.message);
      throw new UnrecoverableError(code);
    }
    const claim = await this.prisma.calendarEvent.updateMany({
      where: { id: e.id, dispatchKey: job.data.dispatchKey, dispatchState: 'QUEUED' },
      data: { dispatchState: 'DISPATCHING', dispatchAttempts: { increment: 1 }, lockedUntil: new Date(Date.now() + this.env.CALENDAR_LOCK_SECONDS * 1000) },
    });
    if (!claim.count) return;
    if (!c || !e.platform || !e.authorizedById) return;

    let outcome;
    try {
      outcome = await this.gateway.submit({
        idempotencyKey: job.data.dispatchKey, businessId: e.businessId, entryId: e.id, contentId: c.id, contentVersion: c.version, platform: e.platform, scheduledAt: e.scheduledAt, timezone: e.timezone,
        caption: c.caption, hashtags: c.hashtags, callToAction: c.callToAction, mediaIds: c.media.map((x) => x.mediaId), authorizedById: e.authorizedById, authorizedAt: e.authorizedAt ?? new Date(),
      });
    } catch (err) {
      outcome = { status: 'REJECTED' as const, code: 'PUBLISHER_ERROR', message: (err as Error).message.slice(0, 300), retryable: true };
    }
    if (outcome.status === 'ACCEPTED') {
      // Conditional: the publisher may already have finished (published or failed) before this runs. Never overwrite its result.
      await this.prisma.$transaction([
        this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchKey: job.data.dispatchKey, dispatchState: 'DISPATCHING' }, data: { dispatchState: 'DISPATCHED', dispatchedAt: new Date(), lockedUntil: null, lastError: null } }),
        this.prisma.content.updateMany({ where: { id: c.id, status: 'SCHEDULED' }, data: { status: 'PUBLISHING' } }),
      ]);
      await this.audit.record({ action: 'calendar.dispatched', actorId: null, businessId: e.businessId, entityType: 'CalendarEvent', entityId: e.id, metadata: { dispatchKey: job.data.dispatchKey, publisher: this.gateway.name, reference: outcome.reference } });
      return;
    }
    if (outcome.retryable && attempt < max) {
      await this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchKey: job.data.dispatchKey }, data: { dispatchState: 'QUEUED', lastError: `${outcome.code}: ${outcome.message}`.slice(0, 500), lockedUntil: new Date(Date.now() + 2 * this.env.CALENDAR_LOCK_SECONDS * 1000) } });
      this.logger.warn(`entry ${e.id}: ${outcome.code}, retrying (attempt ${attempt}/${max})`);
      throw new Error(`${outcome.code}: ${outcome.message}`);
    }
    await this.fail(e.id, outcome.code, outcome.message);
    throw new UnrecoverableError(`${outcome.code}: ${outcome.message}`);
  }

  private async onFailed(job: Job<CalendarJobData> | undefined, err: Error) {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1) && !(err instanceof UnrecoverableError)) return;
    try {
      const e = await this.prisma.calendarEvent.findFirst({ where: { id: job.data.entryId }, select: { id: true, dispatchState: true, dispatchKey: true } });
      if (e && e.dispatchKey === job.data.dispatchKey && (e.dispatchState === 'QUEUED' || e.dispatchState === 'DISPATCHING')) await this.fail(e.id, 'DISPATCH_FAILED', 'The scheduled job stopped unexpectedly');
    } catch (e) {
      this.logger.error(`could not finalize job ${job.id}: ${(e as Error).message}`);
    }
  }

  /** Final failure: the entry becomes FAILED and the people who can reschedule it are told. */
  private async fail(entryId: string, code: string, message: string) {
    await this.results.recordFailed(entryId, { code, message });
  }

  // ─── Results reported by the publisher ─────────────────────────────────────

  recordPublished(entryId: string, r: { publishedAt?: Date; externalUrl?: string | null; publicationId?: string; manual?: boolean }) {
    return this.results.recordPublished(entryId, r);
  }

  recordFailed(entryId: string, f: { code: string; message: string }) {
    return this.results.recordFailed(entryId, f);
  }
}
