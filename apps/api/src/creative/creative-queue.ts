import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { AppEnv, InjectEnv } from '../config';
import { bullConnection } from '../ai/ai-queue';

export const CREATIVE_QUEUE = 'touma.creative';
export const CREATIVE_WORKER_HEARTBEAT_KEY = 'touma:creative-worker:heartbeat';

/** Job payload: the generation id only. Everything else is read from the database by the worker. */
export interface CreativeJobData {
  generationId: string;
}

/** Producer side of the creative queue (images and videos). */
@Injectable()
export class CreativeQueueService implements OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue<CreativeJobData>;

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  private get q() {
    if (!this.queue) {
      this.connection = bullConnection(this.env);
      this.queue = new Queue<CreativeJobData>(CREATIVE_QUEUE, { connection: this.connection });
    }
    return this.queue;
  }

  /** The generation id is the job id, so enqueueing twice is a no-op. */
  async enqueue(generationId: string) {
    const add = this.q.add('generate', { generationId }, {
      jobId: generationId,
      attempts: this.env.CREATIVE_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: this.env.CREATIVE_JOB_BACKOFF_MS },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queue timeout')), 5000).unref());
    try {
      await Promise.race([add, timeout]);
    } catch {
      throw new ServiceUnavailableException({ code: 'CREATIVE_QUEUE_UNAVAILABLE', message: 'The creative job queue is unavailable. Nothing was used; try again shortly.' });
    }
  }

  getJob(id: string) {
    return this.q.getJob(id);
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }
}
