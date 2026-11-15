import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';
import { BillingAdminService } from './billing-admin.service';
import { BillingEnabledGuard } from './billing.guard';

/** Platform administrators only (SUPER_ADMIN, SUPPORT). Read-only: nothing here changes a subscription or charges anything. */
@ApiTags('admin-billing')
@ApiBearerAuth()
@RequirePlatformRole('SUPER_ADMIN', 'SUPPORT')
@UseGuards(BillingEnabledGuard)
@Controller('admin/billing')
export class BillingAdminController {
  constructor(private readonly admin: BillingAdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Subscriptions by state, failed payments, SIMULATED revenue, upcoming renewals, events, provider readiness' })
  overview() { return this.admin.overview(); }
}
