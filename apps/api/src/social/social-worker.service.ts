import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { bullConnection } from '../ai/ai-queue';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { SocialAccountsService } from './social-accounts.service';
import { SocialAnalyticsService } from './social-analytics.service';
import { SocialPublisherService } from './social-publisher.service';
import { SOCIAL_QUEUE, SOCIAL_WORKER_HEARTBEAT_KEY, SocialQueueService, type SocialJobData } from './social-queue';

/**
 * Consumer of the publishing queue plus the periodic maintenance of the social module:
 * token refresh and expiration monitoring, retrying publications that are waiting for a retry time, re-queueing publications whose
 * job was lost, following posts the platform is still processing, and collecting analytics.
 * Run it with `node dist/ai-worker.js` (all workers share that process) or inline with AI_WORKER_INLINE=true.
 */
@Injectable()
export class SocialWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SocialWorker');
  private worker?: Worker<SocialJobData>;
  private connection?: IORedis;
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: SocialPublisherService,
    private readonly accounts: SocialAccountsService,
    private readonly analytics: SocialAnalyticsService,
    private readonly queue: SocialQueueService,
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
    this.worker = new Worker<SocialJobData>(SOCIAL_QUEUE, (job: Job<SocialJobData>) => this.publisher.process(job.data.publicationId), { connection: this.connection, concurrency: this.env.SOCIAL_WORKER_CONCURRENCY });
    this.worker.on('error', (err) => this.logger.error(`worker error: ${err.message}`));
    this.worker.on('failed', (job, err) => this.logger.warn(`job ${job?.id} failed: ${err.message.slice(0, 200)}`));
    const beat = () => this.connection?.set(SOCIAL_WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch(() => undefined);
    await beat();
    this.timers.push(setInterval(beat, 30_000).unref());
    this.timers.push(setInterval(() => void this.tick().catch((e) => this.logger.error(`tick failed: ${(e as Error).message}`)), this.env.SOCIAL_TICK_MS).unref());
    this.logger.log(`Social worker listening on ${SOCIAL_QUEUE} (tick ${this.env.SOCIAL_TICK_MS} ms)`);
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }

  async tick(now = new Date()) {
    if (this.ticking) return { monitored: null, requeued: 0, polled: 0, measured: 0 };
    this.ticking = true;
    try {
      const monitored = await this.accounts.monitor(now);

      // Publications waiting for a retry time, or whose job disappeared (the API died between saving and queueing).
      let requeued = 0;
      for (const p of await this.publisher.stuckQueued(now)) {
        const job = await this.queue.getJob(p.id);
        const state = job ? await job.getState() : 'missing';
        if (state === 'waiting' || state === 'active' || state === 'delayed') continue;
        await this.queue.forget(p.id);
        await this.queue.enqueue(p.id);
        requeued++;
      }
      // A worker died while publishing: the lock expired, the engine decides whether the post may already exist.
      for (const p of await this.prisma.publication.findMany({ where: { status: 'PUBLISHING', lockedUntil: { lt: now } }, select: { id: true }, take: 50 })) {
        await this.queue.forget(p.id);
        await this.queue.enqueue(p.id);
        requeued++;
      }
      // Posts the platform is still processing.
      let polled = 0;
      for (const p of await this.prisma.publication.findMany({ where: { status: 'AWAITING_PROVIDER', nextCheckAt: { lte: now } }, select: { id: true }, take: 50 })) {
        await this.publisher.poll(p.id);
        polled++;
      }
      let measured = 0;
      for (const id of await this.analytics.due(now)) {
        try {
          await this.analytics.collect(id);
          measured++;
        } catch (e) {
          this.logger.warn(`metrics for ${id} failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
      return { monitored, requeued, polled, measured };
    } finally {
      this.ticking = false;
    }
  }
}
