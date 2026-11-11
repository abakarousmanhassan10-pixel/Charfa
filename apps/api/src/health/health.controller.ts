import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { StorageHealthService } from '../storage/storage.module';
import { EmailService } from '../email/email.service';
import { MALWARE_SCANNER, type MalwareScanner } from '../media/malware-scanner';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { integrationStatus } from '@touma/config';
import { Public } from '../common/decorators/current-user.decorator';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from './redis.provider';

@ApiTags('health')
@SkipThrottle()
@Public()
@Controller('health')
export class HealthController {
  private smtpCache?: { ok: boolean; at: number };

  constructor(
    private readonly storageHealth: StorageHealthService,
    private readonly email: EmailService,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: checks hard dependencies. Reports (without secrets) which optional integrations are configured. */
  @Get('ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      checks.redis = (await this.redis.ping()) === 'PONG' ? 'up' : 'down';
    } catch {
      checks.redis = 'down';
    }
    const ok = Object.values(checks).every((v) => v === 'up');
    const dependencies = await this.dependencies(checks.redis === 'up');
    const integrations = { ...integrationStatus(this.env), storage: dependencies.storage.state === 'verified' || dependencies.storage.state === 'test_only' };
    const body = { status: ok ? 'ok' : 'degraded', checks, integrations, dependencies };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }

  /**
   * Optional dependencies, reported without failing readiness (a storage or SMTP outage must not
   * take every API instance out of the load balancer). Storage is "verified" only after a real
   * upload/download/delete round trip.
   */
  private async dependencies(redisUp: boolean) {
    const storage = await this.storageHealth.status().catch((e) => ({ state: 'failing' as const, error: (e as Error).message }));
    let smtp: 'verified' | 'failing' | 'not_configured' | 'log_only' = this.email.transport === 'log' ? 'log_only' : 'not_configured';
    if (this.email.transport === 'smtp') {
      if (!this.smtpCache || Date.now() - this.smtpCache.at > 5 * 60_000) this.smtpCache = { ok: await this.email.verify(), at: Date.now() };
      smtp = this.smtpCache.ok ? 'verified' : 'failing';
    }
    const scanner = this.scanner.enabled ? ((await this.scanner.ping()) ? 'up' : 'down') : 'disabled';
    let worker: { state: 'up' | 'stale' | 'unknown'; lastHeartbeat: string | null } = { state: 'unknown', lastHeartbeat: null };
    if (redisUp) {
      const beat = await this.redis.get('touma:worker:heartbeat').catch(() => null);
      if (beat) worker = { state: Date.now() - Number(beat) < 90_000 ? 'up' : 'stale', lastHeartbeat: new Date(Number(beat)).toISOString() };
    }
    return { storage, email: smtp, malwareScanner: scanner, worker };
  }
}
