import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { BusinessRole } from '@touma/database';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateBusinessDto, DeleteBusinessDto, UpdateBusinessDto, UpdateMemberRoleDto } from './dto/business.dto';
import { BusinessesService } from './businesses.service';

@ApiTags('businesses')
@ApiBearerAuth()
@Controller('businesses')
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBusinessDto) {
    return this.businesses.create(user.id, dto);
  }

  /** Businesses where the caller is an active member, each with the caller's role and permissions. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.businesses.listForUser(user.id);
  }

  @Get(':businessId')
  @RequirePermission('business.read')
  get(@Tenant() tenant: TenantContext) {
    return this.businesses.get(tenant);
  }

  @Patch(':businessId')
  @RequirePermission('business.update')
  update(@Tenant() tenant: TenantContext, @Body() dto: UpdateBusinessDto) {
    return this.businesses.update(tenant, dto);
  }

  @Delete(':businessId')
  @HttpCode(204)
  @RequirePermission('business.delete')
  remove(@Tenant() tenant: TenantContext, @Body() dto: DeleteBusinessDto) {
    return this.businesses.softDelete(tenant, dto.confirmName);
  }

  @Get(':businessId/dashboard')
  @RequirePermission('business.read')
  dashboard(@Tenant() tenant: TenantContext) {
    return this.businesses.dashboard(tenant);
  }

  @Get(':businessId/members')
  @RequirePermission('members.read')
  members(@Tenant() tenant: TenantContext) {
    return this.businesses.listMembers(tenant);
  }

  @Patch(':businessId/members/:membershipId')
  @RequirePermission('members.manage')
  updateMember(@Tenant() tenant: TenantContext, @Param('membershipId') membershipId: string, @Body() dto: UpdateMemberRoleDto) {
    return this.businesses.updateMemberRole(tenant, membershipId, dto.role as BusinessRole);
  }

  /** Managers remove lower-ranked members; any member may remove themselves (leave), except the last owner. */
  @Delete(':businessId/members/:membershipId')
  @HttpCode(204)
  @RequirePermission('business.read')
  removeMember(@Tenant() tenant: TenantContext, @Param('membershipId') membershipId: string) {
    return this.businesses.removeMember(tenant, membershipId);
  }
}
