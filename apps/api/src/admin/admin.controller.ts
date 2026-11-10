import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { requestMeta } from '../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
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
}
