import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bullConnection } from '../ai/ai-queue';
import { AppEnv, InjectEnv } from '../config';

export const SOCIAL_QUEUE = 'touma.social';
export const SOCIAL_WORKER_HEARTBEAT_KEY = 'touma:social-worker:heartbeat';

export interface SocialJobData {
  publicationId: string;
}

/** Producer side of the publishing queue. The publication id is the job id: a publication is queued at most once. */
@Injectable()
export class SocialQueueService implements OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue<SocialJobData>;

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  get q() {
    if (!this.queue) {
      this.connection = bullConnection(this.env);
      this.queue = new Queue<SocialJobData>(SOCIAL_QUEUE, { connection: this.connection });
    }
    return this.queue;
  }

  async enqueue(publicationId: string, delayMs = 0) {
    const add = this.q.add('publish', { publicationId }, {
      jobId: publicationId, delay: delayMs, attempts: this.env.SOCIAL_PUBLISH_ATTEMPTS, backoff: { type: 'exponential', delay: this.env.SOCIAL_PUBLISH_BACKOFF_MS },
      removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 },
    });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queue timeout')), 5000).unref());
    try {
      await Promise.race([add, timeout]);
    } catch {
      throw new ServiceUnavailableException({ code: 'SOCIAL_QUEUE_UNAVAILABLE', message: 'The publishing queue is unavailable' });
    }
  }

  async getJob(id: string) {
    return this.q.getJob(id);
  }

  /** Removes a finished job so the same publication can be queued again (retry). */
  async forget(id: string) {
    const job = await this.q.getJob(id);
    if (job) await job.remove().catch(() => undefined);
  }

  counts() {
    return this.q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }
}
