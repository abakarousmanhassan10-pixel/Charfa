import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { integrationStatus } from '@aima/config';
import { Public } from '../common/decorators/current-user.decorator';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from './redis.provider';

@ApiTags('health')
@SkipThrottle()
@Public()
@Controller('health')
export class HealthController {
  constructor(
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
    const body = { status: ok ? 'ok' : 'degraded', checks, integrations: integrationStatus(this.env) };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
