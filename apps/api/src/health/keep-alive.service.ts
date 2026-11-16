import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** True when `hour` (0-23, UTC) is inside "from-to" (to is exclusive; 24 means midnight). */
export function inKeepAliveWindow(range: string, hour: number): boolean {
  const [from, to] = range.split('-').map(Number) as [number, number];
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * DEMO HOSTING ONLY. A free web service is put to sleep after ~15 minutes without an inbound request and then takes about a minute to wake up.
 * When KEEP_ALIVE_URL is set, the API requests its own public health URL on a timer; the request goes through the host's edge, so it counts as traffic.
 * It only runs inside the UTC hour window (the free plan has a monthly instance-hour budget shared by all services) and never in production (env loader).
 * It sends nothing but a GET to our own health endpoint.
 */
@Injectable()
export class KeepAliveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('KeepAlive');
  private timer: NodeJS.Timeout | null = null;

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  onModuleInit() {
    if (!this.env.KEEP_ALIVE_URL) return;
    const every = this.env.KEEP_ALIVE_INTERVAL_MINUTES * 60_000;
    this.timer = setInterval(() => void this.ping(), every);
    this.timer.unref();
    this.logger.log(`Keep-alive on: ${this.env.KEEP_ALIVE_URL} every ${this.env.KEEP_ALIVE_INTERVAL_MINUTES} min, ${this.env.KEEP_ALIVE_HOURS_UTC} UTC (demo hosting only)`);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async ping(now: Date = new Date()): Promise<boolean> {
    if (!this.env.KEEP_ALIVE_URL || !inKeepAliveWindow(this.env.KEEP_ALIVE_HOURS_UTC, now.getUTCHours())) return false;
    try {
      const res = await fetch(this.env.KEEP_ALIVE_URL, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'touma-keep-alive' } });
      return res.ok;
    } catch (e) {
      this.logger.warn(`keep-alive ping failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}
