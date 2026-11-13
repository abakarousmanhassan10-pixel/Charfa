import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type Redis from 'ioredis';
import { AI_QUEUE, AI_WORKER_HEARTBEAT_KEY, bullConnection } from '../ai/ai-queue';
import { CALENDAR_QUEUE, CALENDAR_WORKER_HEARTBEAT_KEY } from '../calendar/calendar-queue';
import { CREATIVE_QUEUE, CREATIVE_WORKER_HEARTBEAT_KEY } from '../creative/creative-queue';
import { RUNS_QUEUE, RUNS_WORKER_HEARTBEAT_KEY } from '../runs/runs-queue';
import { SOCIAL_QUEUE, SOCIAL_WORKER_HEARTBEAT_KEY } from '../social/social-queue';
import { AppEnv, InjectEnv } from '../config';
import { REDIS } from '../health/redis.provider';
import { PrismaService } from '../prisma/prisma.service';

/** The fixed, small set of queues (low cardinality: nothing tenant- or job-specific is ever a label). */
export const OPS_QUEUES = [
  { name: AI_QUEUE, heartbeat: AI_WORKER_HEARTBEAT_KEY },
  { name: SOCIAL_QUEUE, heartbeat: SOCIAL_WORKER_HEARTBEAT_KEY },
  { name: CREATIVE_QUEUE, heartbeat: CREATIVE_WORKER_HEARTBEAT_KEY },
  { name: CALENDAR_QUEUE, heartbeat: CALENDAR_WORKER_HEARTBEAT_KEY },
  { name: RUNS_QUEUE, heartbeat: RUNS_WORKER_HEARTBEAT_KEY },
] as const;
export const OPS_QUEUE_NAMES: string[] = OPS_QUEUES.map((q) => q.name);
const MAINTENANCE_HEARTBEAT = 'touma:worker:heartbeat';
const LOCK_KEY = 'touma:ops:collect-lock';
const READ_TIMEOUT_MS = 3000;

export interface QueueCounts { waiting: number; active: number; delayed: number; failed: number; completed: number }
/** "measured" = read from BullMQ just now; "unavailable" = it could not be read (never shown as zero). */
export type QueueReading = { queue: string; source: 'measured'; counts: QueueCounts } | { queue: string; source: 'unavailable'; counts: null; reason: string };

const withTimeout = <T>(p: Promise<T>, ms = READ_TIMEOUT_MS) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);

/**
 * Operational telemetry for platform administrators: real BullMQ job counts, worker heartbeats, a bounded history and one
 * configurable alert (failed jobs in a queue). Monitoring never interrupts business operations: every read is time-boxed
 * and every failure is contained here. Platform level only: no tenant data is read or returned.
 */
@Injectable()
export class OpsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Ops');
  private connection?: IORedis;
  private readonly queues = new Map<string, Queue>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  onModuleInit() {
    const s = this.env.OPS_SAMPLER_INTERVAL_SECONDS;
    if (s > 0) this.timer = setInterval(() => void this.collect().catch(() => undefined), s * 1000).unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    await this.connection?.quit().catch(() => undefined);
  }

  private queue(name: string) {
    let q = this.queues.get(name);
    if (!q) {
      this.connection ??= bullConnection(this.env);
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Reads the job counts of every tracked queue. An unreadable queue is reported as unavailable, never as zero. */
  async readCounts(): Promise<QueueReading[]> {
    return Promise.all(
      OPS_QUEUES.map(async ({ name }): Promise<QueueReading> => {
        try {
          const c = await withTimeout(this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'));
          return { queue: name, source: 'measured', counts: { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 } };
        } catch (e) {
          return { queue: name, source: 'unavailable', counts: null, reason: (e as Error).message === 'timeout' ? 'timeout' : 'unreachable' };
        }
      }),
    );
  }

  private async heartbeat(key: string | null) {
    if (!key) return { state: 'unknown' as const, lastHeartbeat: null as string | null };
    const v = await withTimeout(this.redis.get(key)).catch(() => undefined);
    if (v === undefined) return { state: 'unavailable' as const, lastHeartbeat: null };
    if (!v) return { state: 'unknown' as const, lastHeartbeat: null };
    return { state: Date.now() - Number(v) < 90_000 ? ('up' as const) : ('stale' as const), lastHeartbeat: new Date(Number(v)).toISOString() };
  }

  /** The current picture: all values are measured now or explicitly unavailable. Nothing here is simulated. */
  async snapshot() {
    const [readings, database, maintenance] = await Promise.all([
      this.readCounts(),
      this.prisma.$queryRaw`SELECT 1`.then(() => 'up' as const).catch(() => 'down' as const),
      this.heartbeat(MAINTENANCE_HEARTBEAT),
    ]);
    const queues = await Promise.all(readings.map(async (r) => ({ ...r, worker: await this.heartbeat(OPS_QUEUES.find((q) => q.name === r.queue)!.heartbeat) })));
    const redisUp = queues.some((q) => q.source === 'measured');
    return { capturedAt: new Date().toISOString(), dataSource: 'measured' as const, database: { state: database, source: 'measured' as const }, redis: { state: redisUp ? ('up' as const) : ('unavailable' as const), source: 'measured' as const }, maintenanceWorker: maintenance, queues };
  }

  // ── Sampling and alerting ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Takes one sample of every readable queue, evaluates the alert rules and prunes old data. Safe to call from several
   * instances (a short Redis lock lets one sample per interval through) and never throws.
   */
  async collect(opts: { force?: boolean } = {}): Promise<{ sampled: number; unavailable: number; alertsRaised: number; skipped?: 'locked' }> {
    try {
      if (!opts.force) {
        const ttl = Math.max(10, (this.env.OPS_SAMPLER_INTERVAL_SECONDS || 60) - 5);
        const got = await withTimeout(this.redis.set(LOCK_KEY, '1', 'EX', ttl, 'NX')).catch(() => 'OK');
        if (got !== 'OK') return { sampled: 0, unavailable: 0, alertsRaised: 0, skipped: 'locked' };
      }
      const readings = await this.readCounts();
      const measured = readings.filter((r): r is Extract<QueueReading, { source: 'measured' }> => r.source === 'measured');
      if (measured.length) await this.prisma.opsQueueSample.createMany({ data: measured.map((r) => ({ queue: r.queue, ...r.counts })) });
      const alertsRaised = await this.evaluate(measured);
      await this.prune();
      return { sampled: measured.length, unavailable: readings.length - measured.length, alertsRaised };
    } catch (e) {
      this.logger.warn(`ops collection failed: ${(e as Error).message}`);
      return { sampled: 0, unavailable: OPS_QUEUES.length, alertsRaised: 0 };
    }
  }

  private async prune() {
    const cutoff = new Date(Date.now() - this.env.OPS_RETENTION_DAYS * 86_400_000);
    await this.prisma.opsQueueSample.deleteMany({ where: { capturedAt: { lt: cutoff } } });
    await this.prisma.opsAlert.deleteMany({ where: { status: 'RESOLVED', resolvedAt: { lt: cutoff } } });
  }

  async ensureDefaultRule() {
    const exists = await this.prisma.opsAlertRule.findFirst({ where: { kind: 'QUEUE_FAILED', queue: null } });
    if (!exists) await this.prisma.opsAlertRule.create({ data: { kind: 'QUEUE_FAILED', queue: null, threshold: this.env.OPS_DEFAULT_FAILED_THRESHOLD } }).catch(() => undefined);
  }

  /** One alert per (rule, queue) while the condition lasts; it clears itself when the failed count drops below the threshold. */
  private async evaluate(measured: Array<{ queue: string; counts: QueueCounts }>): Promise<number> {
    await this.ensureDefaultRule();
    const all = await this.prisma.opsAlertRule.findMany({ where: { kind: 'QUEUE_FAILED' } });
    const rules = all.filter((x) => x.enabled);
    let raised = 0;
    for (const r of measured) {
      // A queue-specific rule replaces the global one for that queue.
      const rule = rules.find((x) => x.queue === r.queue) ?? rules.find((x) => x.queue === null);
      const key = (id: string) => `${id}:${r.queue}`;
      for (const other of all) if (other !== rule) await this.autoResolve(key(other.id)); // a replaced or disabled rule leaves no stale alert
      if (!rule) continue;
      if (r.counts.failed >= rule.threshold) {
        if (await this.raise(rule.id, r.queue, key(rule.id), r.counts.failed, rule.threshold)) raised++;
      } else await this.autoResolve(key(rule.id));
    }
    return raised;
  }

  /** Returns true only when a new alert was created (an existing one is updated, not duplicated). */
  private async raise(ruleId: string, queue: string, dedupeKey: string, observed: number, threshold: number): Promise<boolean> {
    const bump = () => this.prisma.opsAlert.updateMany({ where: { dedupeKey }, data: { lastSeenAt: new Date(), observed, threshold, occurrences: { increment: 1 } } });
    if ((await bump()).count) return false;
    try {
      const alert = await this.prisma.opsAlert.create({ data: { ruleId, queue, dedupeKey, observed, threshold } });
      await this.notifyAdmins(alert.id, queue, observed, threshold);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        await bump(); // lost a race with another instance: still one alert
        return false;
      }
      throw e;
    }
  }

  private async autoResolve(dedupeKey: string) {
    await this.prisma.opsAlert.updateMany({ where: { dedupeKey }, data: { status: 'RESOLVED', dedupeKey: null, resolvedAt: new Date(), resolution: 'CLEARED' } });
  }

  /** Uses the existing in-app notifications: one per platform administrator, delivered once per alert. */
  private async notifyAdmins(alertId: string, queue: string, observed: number, threshold: number) {
    try {
      const admins = await this.prisma.user.findMany({ where: { platformRole: { in: ['SUPER_ADMIN', 'SUPPORT'] }, deletedAt: null }, select: { id: true }, take: 100 });
      if (!admins.length) return;
      await this.prisma.notification.createMany({
        data: admins.map((u) => ({ userId: u.id, businessId: null, type: 'ops.queue_failed', title: `Queue ${queue}: ${observed} failed jobs`, body: `Threshold ${threshold}`, data: { alertId, queue, observed, threshold } as Prisma.InputJsonValue, dedupeKey: `ops-alert:${alertId}` })),
        skipDuplicates: true,
      });
    } catch (e) {
      this.logger.warn(`could not notify administrators: ${(e as Error).message}`);
    }
  }

  // ── Reads and administration ────────────────────────────────────────────────────────────────────────────────────────

  async history(opts: { queue?: string; hours: number; page: number; pageSize: number }) {
    const where: Prisma.OpsQueueSampleWhereInput = { capturedAt: { gte: new Date(Date.now() - opts.hours * 3_600_000) }, ...(opts.queue ? { queue: opts.queue } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.opsQueueSample.count({ where }),
      this.prisma.opsQueueSample.findMany({ where, orderBy: { capturedAt: 'desc' }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize }),
    ]);
    return { items: items.map((s) => ({ queue: s.queue, capturedAt: s.capturedAt.toISOString(), waiting: s.waiting, active: s.active, delayed: s.delayed, failed: s.failed, completed: s.completed })), total, page: opts.page, pageSize: opts.pageSize, pageCount: Math.max(1, Math.ceil(total / opts.pageSize)) };
  }

  async rules() {
    await this.ensureDefaultRule();
    return (await this.prisma.opsAlertRule.findMany({ orderBy: [{ queue: 'asc' }, { createdAt: 'asc' }] })).map((r) => ({ id: r.id, kind: r.kind, queue: r.queue, threshold: r.threshold, enabled: r.enabled, updatedAt: r.updatedAt.toISOString() }));
  }

  async setRule(input: { queue: string | null; threshold: number; enabled: boolean }, userId: string) {
    const existing = await this.prisma.opsAlertRule.findFirst({ where: { kind: 'QUEUE_FAILED', queue: input.queue } });
    const data = { threshold: input.threshold, enabled: input.enabled, updatedById: userId };
    const r = existing ? await this.prisma.opsAlertRule.update({ where: { id: existing.id }, data }) : await this.prisma.opsAlertRule.create({ data: { kind: 'QUEUE_FAILED', queue: input.queue, ...data } });
    return { id: r.id, kind: r.kind, queue: r.queue, threshold: r.threshold, enabled: r.enabled, updatedAt: r.updatedAt.toISOString() };
  }

  async alerts(opts: { status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; page: number; pageSize: number }) {
    const where: Prisma.OpsAlertWhereInput = opts.status ? { status: opts.status } : {};
    const [total, items] = await Promise.all([
      this.prisma.opsAlert.count({ where }),
      this.prisma.opsAlert.findMany({ where, orderBy: { lastSeenAt: 'desc' }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize }),
    ]);
    return { items: items.map(alertView), total, page: opts.page, pageSize: opts.pageSize, pageCount: Math.max(1, Math.ceil(total / opts.pageSize)) };
  }

  async acknowledge(id: string, userId: string) {
    const a = await this.prisma.opsAlert.findUnique({ where: { id } });
    if (!a) throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'Alert not found' });
    const res = await this.prisma.opsAlert.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedBy: userId } });
    if (!res.count) throw new ConflictException({ code: 'ALERT_NOT_OPEN', message: 'Only an open alert can be acknowledged' });
    return alertView((await this.prisma.opsAlert.findUniqueOrThrow({ where: { id } })));
  }

  async resolve(id: string, userId: string, note?: string) {
    const a = await this.prisma.opsAlert.findUnique({ where: { id } });
    if (!a) throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'Alert not found' });
    const res = await this.prisma.opsAlert.updateMany({ where: { id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, data: { status: 'RESOLVED', dedupeKey: null, resolvedAt: new Date(), resolvedBy: userId, resolution: note?.slice(0, 300) ?? 'MANUAL' } });
    if (!res.count) throw new ConflictException({ code: 'ALERT_ALREADY_RESOLVED', message: 'The alert is already resolved' });
    return alertView((await this.prisma.opsAlert.findUniqueOrThrow({ where: { id } })));
  }
}

const alertView = (a: { id: string; ruleId: string; queue: string; status: string; observed: number; threshold: number; occurrences: number; firstSeenAt: Date; lastSeenAt: Date; acknowledgedAt: Date | null; resolvedAt: Date | null; resolution: string | null }) => ({
  id: a.id, ruleId: a.ruleId, queue: a.queue, status: a.status, observed: a.observed, threshold: a.threshold, occurrences: a.occurrences,
  firstSeenAt: a.firstSeenAt.toISOString(), lastSeenAt: a.lastSeenAt.toISOString(), acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null, resolvedAt: a.resolvedAt?.toISOString() ?? null, resolution: a.resolution,
});
