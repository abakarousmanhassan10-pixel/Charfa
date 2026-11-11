import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { roleHasPermission } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { AI_QUEUE, AI_WORKER_HEARTBEAT_KEY, AiQueueService, bullConnection, type AiJobData } from './ai-queue';
import { AiUsageService } from './ai-usage.service';
import { AiJobError, AiOrchestratorService } from './orchestrator.service';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'BLOCKED'] as const;

/**
 * Consumer side of the AI generation queue.
 *
 * Job lifecycle (one BullMQ job per generation, job id = generation id):
 *   QUEUED → RUNNING → SUCCEEDED
 *                    → QUEUED   (transient provider failure, retried with exponential backoff)
 *                    → FAILED   (permanent failure, or retries exhausted)
 * The quota reservation taken at submission is settled exactly once when the job reaches a final
 * state: tokens actually consumed are committed, everything else is released.
 *
 * Runs inside the API process when AI_WORKER_INLINE=true (development, tests) or as its own process
 * (`node dist/ai-worker.js`, production).
 */
@Injectable()
export class AiWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AiWorker');
  private worker?: Worker<AiJobData>;
  private connection?: IORedis;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly usage: AiUsageService,
    private readonly queue: AiQueueService,
    @InjectEnv() private readonly env: AppEnv,
    @Inject('AI_WORKER_FORCE') private readonly force: boolean,
  ) {}

  async onApplicationBootstrap() {
    if (this.env.AI_WORKER_INLINE || this.force) await this.start();
  }

  get running() {
    return Boolean(this.worker?.isRunning());
  }

  async start() {
    if (this.worker) return;
    this.connection = bullConnection(this.env);
    this.worker = new Worker<AiJobData>(AI_QUEUE, (job) => this.handle(job), { connection: this.connection, concurrency: this.env.AI_WORKER_CONCURRENCY });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.logger.error(`worker error: ${err.message}`));
    const beat = () => this.connection?.set(AI_WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch(() => undefined);
    await beat();
    this.timers.push(setInterval(beat, 30_000).unref());
    this.timers.push(setInterval(() => void this.reconcile().catch((e) => this.logger.error(`reconcile failed: ${(e as Error).message}`)), 60_000).unref());
    this.logger.log(`AI worker listening on ${AI_QUEUE} (concurrency ${this.env.AI_WORKER_CONCURRENCY})`);
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }

  /** The user must still be an active member allowed to use AI when the job runs, not just when it was submitted. */
  private async tenantFor(gen: { businessId: string; userId: string | null }): Promise<TenantContext> {
    if (!gen.userId) throw new AiJobError('AI_FORBIDDEN', 403, 'The requesting user no longer exists');
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: gen.userId, businessId: gen.businessId } } });
    if (!m || m.status !== 'ACTIVE' || !roleHasPermission(m.role, 'ai.use')) throw new AiJobError('AI_FORBIDDEN', 403, 'The requesting user is no longer allowed to use TOUMA AI for this business');
    return { businessId: gen.businessId, userId: gen.userId, membershipId: m.id, role: m.role };
  }

  /** Processes one attempt of a job. Throwing re-queues the job (transient) or ends it (UnrecoverableError). */
  async handle(job: Job<AiJobData>) {
    const attempt = job.attemptsMade + 1;
    const max = job.opts.attempts ?? 1;
    const gen = await this.prisma.aIGeneration.findUnique({ where: { id: job.data.generationId } });
    // Missing or already final: a duplicate delivery or a stale job. Nothing to do, and nothing to charge.
    if (!gen || (TERMINAL as readonly string[]).includes(gen.status)) return;
    await this.prisma.aIGeneration.update({ where: { id: gen.id }, data: { status: 'RUNNING', startedAt: gen.startedAt ?? new Date(), jobAttempts: attempt } });

    try {
      const tenant = await this.tenantFor(gen);
      await this.orchestrator.runPipeline({ ...gen, status: 'RUNNING' }, tenant);
      await this.usage.settle(gen.id, 'succeeded');
    } catch (err) {
      const e = this.orchestrator.mapError(err as Error);
      if (e.retryable && attempt < max) {
        // Keep the reservation: the retry will use it. The row shows the last error while it waits for its next attempt.
        await this.prisma.aIGeneration.update({ where: { id: gen.id }, data: { status: 'QUEUED', errorCode: e.code, errorMessage: e.message.slice(0, 500) } });
        this.logger.warn(`generation ${gen.id}: ${e.code}, retrying (attempt ${attempt}/${max})`);
        throw err;
      }
      await this.fail(gen.id, e.code, e.message);
      throw new UnrecoverableError(`${e.code}: ${e.message}`);
    }
  }

  /** Final failure: record it on the generation and settle the reservation (consumed tokens are kept, the rest is released). */
  private async fail(generationId: string, code: string, message: string) {
    const totals = await this.usage.totalsFor(generationId);
    await this.prisma.aIGeneration.updateMany({
      where: { id: generationId, status: { notIn: [...TERMINAL] } },
      data: { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), completedAt: new Date(), attempts: totals.calls, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens },
    });
    await this.usage.settle(generationId, 'failed');
  }

  /** Jobs that die outside handle() (crash, stalled more than allowed) must not leave a reservation behind. */
  private async onFailed(job: Job<AiJobData> | undefined, err: Error) {
    if (!job) return;
    this.logger.warn(`job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${err.message.slice(0, 200)}`);
    if (job.attemptsMade < (job.opts.attempts ?? 1) && !(err instanceof UnrecoverableError)) return;
    try {
      const gen = await this.prisma.aIGeneration.findUnique({ where: { id: job.data.generationId }, select: { status: true } });
      if (gen && !(TERMINAL as readonly string[]).includes(gen.status)) await this.fail(job.data.generationId, 'AI_JOB_FAILED', 'The generation job stopped unexpectedly');
    } catch (e) {
      this.logger.error(`could not finalize job ${job.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Self-healing for accounting: settles reservations of finished jobs, fails jobs that vanished from the
   * queue, and re-enqueues accepted generations whose job was never created (API crashed after commit).
   */
  async reconcile() {
    const settled = await this.usage.reconcileFinished();
    const staleBefore = new Date(Date.now() - this.env.AI_RESERVATION_STALE_MINUTES * 60_000);
    const stale = await this.prisma.aIReservation.findMany({ where: { status: 'RESERVED', createdAt: { lt: staleBefore }, generation: { status: { in: ['QUEUED', 'RUNNING'] } } }, select: { generationId: true }, take: 100 });
    let failed = 0;
    for (const r of stale) {
      const job = await this.queue.getJob(r.generationId);
      const state = job ? await job.getState() : 'missing';
      if (state === 'missing' || state === 'failed' || state === 'completed') {
        await this.fail(r.generationId, 'AI_JOB_STALLED', 'The generation job did not finish and was cancelled');
        failed++;
      }
    }
    const orphans = await this.prisma.aIGeneration.findMany({ where: { status: 'QUEUED', queuedAt: { lt: new Date(Date.now() - 60_000) }, rootId: { not: null } }, select: { id: true, rootId: true }, take: 100 });
    let requeued = 0;
    for (const o of orphans.filter((x) => x.id === x.rootId)) {
      if (!(await this.queue.getJob(o.id))) {
        await this.queue.enqueue(o.id);
        requeued++;
      }
    }
    if (settled || failed || requeued) this.logger.warn(`reconcile: settled ${settled}, stalled ${failed}, re-enqueued ${requeued}`);
    return { settled, failed, requeued };
  }
}
