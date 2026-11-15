import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CardSetupDto, ChangePlanDto, CreateSubscriptionDto, SetModeDto, StartTrialDto } from './billing.dto';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';

/** Billing (N24/N26). Off by default (404). Reading needs `billing.read`; every change needs `billing.manage` (the owner). */
@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(BillingEnabledGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('status')
  @ApiOperation({ summary: 'Entitlement, subscription (mode, interval, next payment), provider capabilities. Read only.' })
  @RequireTenantPermission('billing.read')
  status(@Tenant() t: TenantContext) { return this.svc.status(t); }

  @Get('history')
  @ApiOperation({ summary: 'Payments and subscription events of this business' })
  @RequireTenantPermission('billing.read')
  history(@Tenant() t: TenantContext) { return this.svc.history(t); }

  @Get('invoices')
  @ApiOperation({ summary: 'Invoices of this business (simulated ones are labelled)' })
  @RequireTenantPermission('billing.read')
  invoices(@Tenant() t: TenantContext) { return this.svc.invoices(t); }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'One invoice of this business (another business\'s invoice is 404)' })
  @RequireTenantPermission('billing.read')
  invoice(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.invoice(t, id); }

  @Post('trial')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start the 72-hour free trial (once per business, no card, nothing charged)' })
  @RequireTenantPermission('billing.manage')
  trial(@Tenant() t: TenantContext, @CurrentUser() u: AuthenticatedUser, @Body() dto: StartTrialDto) { return this.svc.createSubscription(t, u.id, { ...dto, trial: true }); }

  @Post('subscription')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create the subscription: with trial (default) or pending until a payment is confirmed by the provider' })
  @RequireTenantPermission('billing.manage')
  subscription(@Tenant() t: TenantContext, @CurrentUser() u: AuthenticatedUser, @Body() dto: CreateSubscriptionDto) { return this.svc.createSubscription(t, u.id, dto); }

  @Post('mode')
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch between automatic (AUTO, needs consent) and manual (MANUAL) renewal' })
  @RequireTenantPermission('billing.manage')
  mode(@Tenant() t: TenantContext, @CurrentUser() u: AuthenticatedUser, @Body() dto: SetModeDto) { return this.svc.setMode(t, u.id, dto); }

  @Post('plan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request another plan or interval; it takes effect at the next renewal' })
  @RequireTenantPermission('billing.manage')
  plan(@Tenant() t: TenantContext, @CurrentUser() u: AuthenticatedUser, @Body() dto: ChangePlanDto) { return this.svc.changePlan(t, u.id, dto); }

  @Post('card-setup')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start a card capture on a provider-hosted page. Returns a URL only; card data never reaches TOUMA.' })
  @RequireTenantPermission('billing.manage')
  cardSetup(@Tenant() t: TenantContext, @CurrentUser() u: AuthenticatedUser, @Body() dto: CardSetupDto) { return this.svc.cardSetup(t, u.id, dto.returnUrl); }

  @Post('subscribe')
  @HttpCode(201)
  @ApiOperation({ summary: 'AUTO only: schedule the recurring charge at the provider (needs consent and a saved card)' })
  @RequireTenantPermission('billing.manage')
  subscribe(@Tenant() t: TenantContext) { return this.svc.subscribe(t); }

  @Post('renewals')
  @HttpCode(201)
  @ApiOperation({ summary: 'Pay the next period now on the provider-hosted page (manual renewal or first payment). The subscription changes only when the provider confirms.' })
  @RequireTenantPermission('billing.manage')
  renew(@Tenant() t: TenantContext, @CurrentUser() u: AuthenticatedUser, @Body() dto: CardSetupDto) { return this.svc.renew(t, u.id, dto.returnUrl); }

  @Post('resume')
  @HttpCode(200)
  @ApiOperation({ summary: 'Undo a cancellation scheduled for the end of the period' })
  @RequireTenantPermission('billing.manage')
  resume(@Tenant() t: TenantContext) { return this.svc.resume(t); }

  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel at the end of the paid period' })
  @RequireTenantPermission('billing.manage')
  cancel(@Tenant() t: TenantContext) { return this.svc.cancel(t); }
}
