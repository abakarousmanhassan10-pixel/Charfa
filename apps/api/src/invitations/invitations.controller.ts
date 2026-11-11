import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, Public, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { requestMeta } from '../common/request-meta';
import { TokenDto } from '../auth/dto/auth.dto';
import { RequirePermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateInvitationDto } from './invitations.dto';
import { InvitationsService } from './invitations.service';

const throttle = () => ({ default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 } });

@ApiTags('invitations')
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get('businesses/:businessId/invitations')
  @ApiBearerAuth()
  @RequirePermission('members.read')
  list(@Tenant() tenant: TenantContext) {
    return this.invitations.list(tenant);
  }

  @Post('businesses/:businessId/invitations')
  @ApiBearerAuth()
  @Throttle(throttle())
  @RequirePermission('members.manage')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateInvitationDto, @Req() req: Request) {
    return this.invitations.create(tenant, dto.email, dto.role, requestMeta(req));
  }

  @Post('businesses/:businessId/invitations/:id/resend')
  @ApiBearerAuth()
  @HttpCode(200)
  @Throttle(throttle())
  @RequirePermission('members.manage')
  resend(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.invitations.resend(tenant, id);
  }

  @Delete('businesses/:businessId/invitations/:id')
  @ApiBearerAuth()
  @HttpCode(204)
  @RequirePermission('members.manage')
  revoke(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.invitations.revoke(tenant, id);
  }

  @Post('invitations/lookup')
  @Public()
  @HttpCode(200)
  @Throttle(throttle())
  lookup(@Body() dto: TokenDto) {
    return this.invitations.lookup(dto.token);
  }

  @Post('invitations/accept')
  @ApiBearerAuth()
  @HttpCode(200)
  @Throttle(throttle())
  accept(@CurrentUser() user: AuthenticatedUser, @Body() dto: TokenDto, @Req() req: Request) {
    return this.invitations.accept(user.id, dto.token, requestMeta(req));
  }
}
