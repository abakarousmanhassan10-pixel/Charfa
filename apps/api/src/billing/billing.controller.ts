import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CardSetupDto, StartTrialDto } from './billing.dto';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';

/** Billing (N24). Off by default (404). Reading needs `billing.read`; every change needs `billing.manage` (the owner). */
@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(BillingEnabledGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('status')
  @ApiOperation({ summary: 'Entitlement (trial / active / founder lifetime), provider capabilities and subscription state. Read only.' })
  @RequireTenantPermission('billing.read')
  status(@Tenant() t: TenantContext) { return this.svc.status(t); }

  @Post('trial')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start the 72-hour free trial (once per business, no card, nothing charged)' })
  @RequireTenantPermission('billing.manage')
  trial(@Tenant() t: TenantContext, @Body() dto: StartTrialDto) { return this.svc.startTrial(t, dto.plan); }

  @Post('card-setup')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start a card capture on a provider-hosted page. Returns a URL only; card data never reaches TOUMA.' })
  @RequireTenantPermission('billing.manage')
  cardSetup(@Tenant() t: TenantContext, @CurrentUser() u: { id: string }, @Body() dto: CardSetupDto) { return this.svc.cardSetup(t, u.id, dto.returnUrl); }

  @Post('subscribe')
  @HttpCode(201)
  @ApiOperation({ summary: 'Schedule the monthly subscription (first charge when the trial ends). Active only after the provider\'s verified webhook.' })
  @RequireTenantPermission('billing.manage')
  subscribe(@Tenant() t: TenantContext) { return this.svc.subscribe(t); }

  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel at the end of the paid period' })
  @RequireTenantPermission('billing.manage')
  cancel(@Tenant() t: TenantContext) { return this.svc.cancel(t); }
}
