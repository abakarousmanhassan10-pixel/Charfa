import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@touma/database';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';

const CODES = ['STARTER', 'PRO', 'BUSINESS'] as const;
const int = (max: number) => z.number().int().min(0).max(max);
/** Daily image and video creations (separate quotas), the monthly creative budget (micro-USD) and the monthly units a plan allows. */
const body = z.object({ creativeImagesPerDay: int(1000).optional(), creativeVideosPerDay: int(1000).optional(), creativeBudgetMicrosPerMonth: int(1_000_000_000_000).optional(), aiImagesPerMonth: int(100_000).optional(), aiVideoSecondsPerMonth: int(1_000_000).optional() }).strict();

/** Platform administrators change what a plan allows. Existing subscriptions see the new limits at once (limits are read from the plan on every request). */
@ApiTags('admin-creative')
@ApiBearerAuth()
@RequirePlatformRole('SUPER_ADMIN')
@Controller('admin/creative')
export class CreativeAdminController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('plan-limits/:code')
  async get(@Param('code') code: string) {
    const plan = await this.plan(code);
    const l = (plan.limits ?? {}) as Record<string, unknown>;
    return { code: plan.code, limits: Object.fromEntries(Object.keys(body.shape).map((k) => [k, typeof l[k] === 'number' ? l[k] : null])) };
  }

  @Put('plan-limits/:code')
  async set(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string, @Body() raw: unknown) {
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
    if (!Object.keys(parsed.data).length) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Nothing to change' });
    const plan = await this.plan(code);
    const next = { ...((plan.limits ?? {}) as Record<string, unknown>), ...parsed.data };
    await this.prisma.plan.update({ where: { id: plan.id }, data: { limits: next as Prisma.InputJsonObject } });
    await this.audit.record({ action: 'creative.plan_limits_changed', actorId: user.id, entityType: 'Plan', entityId: plan.id, metadata: { code: plan.code, changed: parsed.data } });
    return this.get(code);
  }

  private async plan(code: string) {
    if (!(CODES as readonly string[]).includes(code)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Plan not found' });
    const plan = await this.prisma.plan.findUnique({ where: { code: code as (typeof CODES)[number] } });
    if (!plan) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Plan not found' });
    return plan;
  }
}
