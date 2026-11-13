import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { bullConnection } from '../ai/ai-queue';
import { AppEnv, InjectEnv } from '../config';
import { RUNS_QUEUE, RUNS_WORKER_HEARTBEAT_KEY, type RunJobData } from './runs-queue';
import { RunsService } from './runs.service';

/** Consumes the runs queue (bounded concurrency) and reconciles crashed or forgotten runs on a timer. Only runs when ORCHESTRATOR_ENABLED. */
@Injectable()
export class RunsWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RunsWorker');
  private worker?: Worker<RunJobData>;
  private connection?: IORedis;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly runs: RunsService, @InjectEnv() private readonly env: AppEnv) {}

  async onApplicationBootstrap() {
    if (this.env.AI_WORKER_INLINE && this.env.ORCHESTRATOR_ENABLED) await this.start();
  }

  get enabled() {
    return this.env.ORCHESTRATOR_ENABLED;
  }

  get running() {
    return Boolean(this.worker?.isRunning());
  }

  async start() {
    if (this.worker || !this.env.ORCHESTRATOR_ENABLED) return;
    this.connection = bullConnection(this.env);
    this.worker = new Worker<RunJobData>(RUNS_QUEUE, (job: Job<RunJobData>) => this.runs.advance(job.data.runId), { connection: this.connection, concurrency: this.env.ORCHESTRATOR_WORKER_CONCURRENCY });
    this.worker.on('failed', (job, err) => this.logger.error(`advance job ${job?.id} failed: ${err.name}`));
    this.worker.on('error', (err) => this.logger.error(`worker error: ${err.name}`));
    const beat = () => this.connection?.set(RUNS_WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch(() => undefined);
    await beat();
    this.timers.push(setInterval(beat, 30_000).unref());
    this.timers.push(setInterval(() => void this.runs.reconcile().catch((e) => this.logger.error(`reconcile failed: ${(e as Error).name}`)), this.env.ORCHESTRATOR_TICK_MS).unref());
    this.logger.log(`Runs worker listening on ${RUNS_QUEUE} (concurrency ${this.env.ORCHESTRATOR_WORKER_CONCURRENCY})`);
  }

  /** Stops consuming. The worker can be started again afterwards (a restart): nothing is lost, the queue and PostgreSQL hold the state. */
  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
    this.worker = undefined;
    this.connection = undefined;
  }
}
