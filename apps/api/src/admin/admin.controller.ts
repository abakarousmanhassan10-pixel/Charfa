import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { requestMeta } from '../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Query } from '@nestjs/common';
import { SalesMonitoringService } from '../sales/sales-monitoring.service';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';

/** Platform administration. Aggregate counts only; no tenant content is exposed here. */
@ApiTags('admin')
@ApiBearerAuth()
@RequirePlatformRole('SUPER_ADMIN', 'SUPPORT')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly salesMonitoring: SalesMonitoringService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const [users, businesses, activeSessions] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.business.count({ where: { deletedAt: null } }),
      this.prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    await this.audit.record({ action: 'admin.overview_view', actorId: user.id, ...requestMeta(req) });
    return { users, businesses, activeSessions };
  }

  /** AI agent usage per business for the last N days: counts, failures, tokens and cost only (no conversation content). */
  @Get('sales-ai')
  async salesAi(@Query('days') days: string | undefined, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const n = Math.min(365, Math.max(1, Number(days) || 7));
    const out = await this.salesMonitoring.platform(n);
    await this.audit.record({ action: 'admin.sales_ai_view', actorId: user.id, ...requestMeta(req) });
    return out;
  }
}
