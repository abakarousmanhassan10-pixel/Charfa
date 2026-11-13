import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { bullConnection } from '../ai/ai-queue';
import { AppEnv, InjectEnv } from '../config';

export const RUNS_QUEUE = 'touma.runs';
export const RUNS_WORKER_HEARTBEAT_KEY = 'touma:runs-worker:heartbeat';

/** Job payload: the run id only. The worker reads everything else from PostgreSQL, the single source of truth. */
export interface RunJobData {
  runId: string;
}

@Injectable()
export class RunsQueueService implements OnModuleDestroy {
  private readonly logger = new Logger('RunsQueue');
  private connection?: IORedis;
  private queue?: Queue<RunJobData>;

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  private get q() {
    if (!this.queue) {
      this.connection = bullConnection(this.env);
      this.queue = new Queue<RunJobData>(RUNS_QUEUE, { connection: this.connection });
    }
    return this.queue;
  }

  /**
   * Wakes the executor for a run. Waking is idempotent (every step is claimed with one conditional UPDATE), so jobs
   * carry no deduplication key and a duplicate is harmless. Never throws: if Redis is down the reconciler wakes the run later.
   */
  async wake(runId: string, delayMs = 0): Promise<boolean> {
    try {
      const add = this.q.add('advance', { runId }, { delay: delayMs, attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } });
      await Promise.race([add, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queue timeout')), 5000).unref())]);
      return true;
    } catch {
      this.logger.warn(`Could not queue run ${runId}; the reconciler will wake it`);
      return false;
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }
}
