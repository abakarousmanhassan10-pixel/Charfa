import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { PLATFORM_ANALYTICS } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { seedHistory } from './demo-history';
import { LearningEnabledGuard } from './learning.guard';
import { PerformanceService } from './performance.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const perfQuery = z.object({ platform: z.enum(['INSTAGRAM', 'TIKTOK', 'YOUTUBE']).optional(), days: z.coerce.number().int().min(1).max(365).optional(), weeks: z.coerce.number().int().min(1).max(52).optional() });
export const rl = () => ({ default: { limit: Number(process.env.LEARNING_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/** Adaptive learning (N22). Off by default (404). Reading needs `learning.read`; collecting, consent, settings and applying changes need `learning.manage`. */
@ApiTags('learning')
@ApiBearerAuth()
@UseGuards(LearningEnabledGuard)
@Controller('learning')
export class LearningController {
  constructor(private readonly perf: PerformanceService, private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv) {}

  @Get('analytics-capabilities') @RequireTenantPermission('learning.read')
  capabilities() { return { platforms: PLATFORM_ANALYTICS, provider: this.env.ANALYTICS_PROVIDER, simulated: this.env.ANALYTICS_PROVIDER === 'mock', maturityHours: this.env.ANALYTICS_MATURITY_HOURS, note: 'Statements about the platforms come from official documentation read by TOUMA; none was tested against a real account. A metric a platform does not give stays null.' }; }

  @Get('performance') @RequireTenantPermission('learning.read')
  report(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { const p = parse(perfQuery, q); return this.perf.report(t.businessId, p); }
  @Get('performance/posts') @RequireTenantPermission('learning.read')
  posts(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { const p = parse(perfQuery, q); return this.perf.posts(t.businessId, p); }
  @Get('performance/series') @RequireTenantPermission('learning.read')
  series(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { const p = parse(perfQuery, q); return this.perf.series(t.businessId, p); }

  @Post('performance/collect') @HttpCode(200) @Throttle(rl()) @RequireTenantPermission('learning.manage')
  collect(@Tenant() t: TenantContext) { return this.perf.collect(t.businessId); }

  /** Fictitious history (30 simulated posts) for the demo. Only available with the simulated analytics provider, which exists in tests only. */
  @Post('demo/history') @HttpCode(201) @RequireTenantPermission('learning.manage')
  async demo(@Tenant() t: TenantContext) {
    if (this.env.ANALYTICS_PROVIDER !== 'mock') throw new ForbiddenException({ code: 'DEMO_DISABLED', message: 'Demo data is available only with the simulated analytics provider' });
    const account = await this.prisma.socialAccount.findFirst({ where: { businessId: t.businessId, platform: 'INSTAGRAM', status: 'CONNECTED', deletedAt: null } });
    if (!account) throw new BadRequestException({ code: 'NO_ACCOUNT', message: 'Connect an Instagram account first' });
    const ids = await seedHistory(this.prisma, { businessId: t.businessId, socialAccountId: account.id, platform: 'INSTAGRAM' });
    return { created: ids.length, simulated: true };
  }
}
