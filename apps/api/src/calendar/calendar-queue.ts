import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { bullConnection } from '../ai/ai-queue';
import { AppEnv, InjectEnv } from '../config';

export const CALENDAR_QUEUE = 'touma.calendar';
export const CALENDAR_WORKER_HEARTBEAT_KEY = 'touma:calendar-worker:heartbeat';

/** Job payload: ids only. Everything else is read from the database when the job runs. */
export interface CalendarJobData {
  entryId: string;
  dispatchKey: string;
}

/** Producer side of the calendar queue (hand-off of due entries). */
@Injectable()
export class CalendarQueueService implements OnModuleDestroy {
  private connection?: IORedis;
  private queue?: Queue<CalendarJobData>;

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  private get q() {
    if (!this.queue) {
      this.connection = bullConnection(this.env);
      this.queue = new Queue<CalendarJobData>(CALENDAR_QUEUE, { connection: this.connection });
    }
    return this.queue;
  }

  /** The dispatch key is the job id, so the same hand-off can never be queued twice. */
  async enqueue(data: CalendarJobData) {
    const add = this.q.add('dispatch', data, {
      jobId: data.dispatchKey,
      attempts: this.env.CALENDAR_DISPATCH_ATTEMPTS,
      backoff: { type: 'exponential', delay: this.env.CALENDAR_DISPATCH_BACKOFF_MS },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queue timeout')), 5000).unref());
    try {
      await Promise.race([add, timeout]);
    } catch {
      throw new ServiceUnavailableException({ code: 'CALENDAR_QUEUE_UNAVAILABLE', message: 'The scheduling queue is unavailable' });
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
