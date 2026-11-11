import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { AppEnv, InjectEnv } from '../config';

export const AI_QUEUE = 'touma.ai';
export const AI_WORKER_HEARTBEAT_KEY = 'touma:ai-worker:heartbeat';

/** Job payload: ids only. Everything else (request, tenant, limits) is read from the database by the worker. */
export interface AiJobData {
  generationId: string;
}

/** Fresh Redis connection for BullMQ (blocking commands need maxRetriesPerRequest: null). */
export function bullConnection(env: AppEnv) {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 5000 });
}

/** Producer side of the AI generation queue. The API only enqueues; workers consume. */
@Injectable()
export class AiQueueService implements OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue<AiJobData>;

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  private get q() {
    if (!this.queue) {
      this.connection = bullConnection(this.env);
      this.queue = new Queue<AiJobData>(AI_QUEUE, { connection: this.connection });
    }
    return this.queue;
  }

  /** The generation id is the BullMQ job id, so enqueueing the same generation twice is a no-op. */
  async enqueue(generationId: string) {
    const add = this.q.add(
      'generate',
      { generationId },
      {
        jobId: generationId,
        attempts: this.env.AI_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.env.AI_JOB_BACKOFF_MS },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queue timeout')), 5000).unref());
    try {
      await Promise.race([add, timeout]);
    } catch {
      throw new ServiceUnavailableException({ code: 'AI_QUEUE_UNAVAILABLE', message: 'The AI job queue is unavailable. Nothing was charged; try again shortly.' });
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
