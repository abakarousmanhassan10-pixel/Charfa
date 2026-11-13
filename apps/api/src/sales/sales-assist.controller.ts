import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { SalesAssistEnabledGuard } from './sales-assist.guard';
import { SalesAssistService, followUpView } from './sales-assist.service';

class ResolveHandoffDto {
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class HandoffQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['REQUESTED', 'ACCEPTED', 'RESOLVED', 'CANCELLED'] }) @IsOptional() @IsIn(['REQUESTED', 'ACCEPTED', 'RESOLVED', 'CANCELLED']) status?: 'REQUESTED' | 'ACCEPTED' | 'RESOLVED' | 'CANCELLED';
}
class FollowUpQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['SUGGESTED', 'APPROVED', 'REJECTED', 'BLOCKED'] }) @IsOptional() @IsIn(['SUGGESTED', 'APPROVED', 'REJECTED', 'BLOCKED']) status?: 'SUGGESTED' | 'APPROVED' | 'REJECTED' | 'BLOCKED';
}
const throttle = () => ({ default: { limit: Number(process.env.SALES_PUBLIC_RATE_LIMIT_PER_MINUTE ?? 20) * 3, ttl: 60_000 } });

/**
 * Sales assistant 2.0 (Phase N5). Reading needs `inbox.read`; acting (handoffs, follow-up drafts) needs `inbox.reply`.
 * No endpoint sends anything: an approved follow-up is an authorization record.
 */
@ApiTags('sales')
@ApiBearerAuth()
@UseGuards(SalesAssistEnabledGuard)
@Controller('sales')
export class SalesAssistController {
  constructor(private readonly assist: SalesAssistService) {}

  @Get('conversations/:id/assist')
  @ApiOperation({ summary: 'Qualification (score, reasons, signals), handoff records, follow-up drafts and consent of a conversation' })
  @RequireTenantPermission('inbox.read')
  view(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.assist.assistView(tenant, id);
  }

  @Post('conversations/:id/handoffs')
  @ApiOperation({ summary: 'Open a handoff record for a conversation (staff-initiated). Idempotent while one is open' })
  @RequireTenantPermission('inbox.reply')
  @Throttle(throttle())
  open(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.assist.staffRequestHandoff(tenant, id);
  }

  @Get('handoffs')
  @RequireTenantPermission('inbox.read')
  handoffs(@Tenant() tenant: TenantContext, @Query() q: HandoffQueryDto) {
    return this.assist.listHandoffs(tenant, q);
  }

  @Post('handoffs/:id/accept')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  accept(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.assist.acceptHandoff(tenant, id);
  }

  @Post('handoffs/:id/resolve')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  resolve(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: ResolveHandoffDto) {
    return this.assist.resolveHandoff(tenant, id, dto.note);
  }

  @Post('conversations/:id/follow-up-drafts')
  @ApiOperation({ summary: 'Prepare a follow-up draft for a warm or hot lead. Blocked without the customer\'s consent; never sent' })
  @RequireTenantPermission('inbox.reply')
  @Throttle(throttle())
  async suggest(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return followUpView(await this.assist.suggestFollowUp({ businessId: tenant.businessId, userId: tenant.userId }, id, 'STAFF'));
  }

  @Get('follow-up-drafts')
  @RequireTenantPermission('inbox.read')
  drafts(@Tenant() tenant: TenantContext, @Query() q: FollowUpQueryDto) {
    return this.assist.listFollowUps(tenant, q);
  }

  @Post('follow-up-drafts/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authorize a draft. Consent is re-checked; nothing is sent (there is no outbound channel)' })
  @RequireTenantPermission('inbox.reply')
  approve(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.assist.approveFollowUp(tenant, id);
  }

  @Post('follow-up-drafts/:id/reject')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  reject(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.assist.rejectFollowUp(tenant, id);
  }
}
