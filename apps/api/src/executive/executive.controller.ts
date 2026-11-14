import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { EconomicsDto, ExpenseDto, ScenariosDto, SettingsDto } from './executive.dto';
import { AutopilotEnabledGuard } from './executive.guard';
import { ExecutiveService } from './executive.service';

const limit = () => ({ default: { limit: Number(process.env.EXECUTIVE_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/**
 * Business autopilot (N22): decision support. Finance data is sensitive, so reading it needs `billing.read` (administrators and
 * the owner) and entering it needs `business.update`. Nothing here changes a price, issues a refund, charges a payment, spends on
 * advertising, publishes a post or messages a customer.
 */
@ApiTags('executive')
@ApiBearerAuth()
@UseGuards(AutopilotEnabledGuard)
@Controller('executive')
export class ExecutiveController {
  constructor(private readonly svc: ExecutiveService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Merchant command center: health, profitability, decisions, campaigns, approvals, risks, agents' })
  @RequireTenantPermission('billing.read')
  overview(@Tenant() t: TenantContext) { return this.svc.overview(t); }

  @Get('settings')
  @RequireTenantPermission('billing.read')
  settings(@Tenant() t: TenantContext) { return this.svc.settings(t); }

  @Put('settings')
  @ApiOperation({ summary: 'Emergency stop and daily run limit' })
  @RequireTenantPermission('content.approve')
  updateSettings(@Tenant() t: TenantContext, @Body() dto: SettingsDto) { return this.svc.updateSettings(t, dto); }

  @Get('finance')
  @RequireTenantPermission('billing.read')
  finance(@Tenant() t: TenantContext) { return this.svc.financeReport(t); }

  @Put('economics/:productId')
  @ApiOperation({ summary: 'Enter the costs of a product. A field you leave empty stays "not supplied".' })
  @RequireTenantPermission('business.update')
  economics(@Tenant() t: TenantContext, @Param('productId') id: string, @Body() dto: EconomicsDto) { return this.svc.putEconomics(t, id, dto); }

  @Get('expenses')
  @RequireTenantPermission('billing.read')
  expenses(@Tenant() t: TenantContext) { return this.svc.listExpenses(t); }

  @Post('expenses')
  @Throttle(limit())
  @RequireTenantPermission('business.update')
  addExpense(@Tenant() t: TenantContext, @Body() dto: ExpenseDto) { return this.svc.addExpense(t, dto); }

  @Delete('expenses/:id')
  @RequireTenantPermission('business.update')
  deleteExpense(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.deleteExpense(t, id); }

  @Post('scenarios')
  @HttpCode(200)
  @ApiOperation({ summary: 'Compare scenarios (price, shipping, ad budget, conversion). A simulation with explicit assumptions.' })
  @Throttle(limit())
  @RequireTenantPermission('billing.read')
  scenarios(@Tenant() t: TenantContext, @Body() dto: ScenariosDto) { return this.svc.scenarios(t, dto.productId, dto.scenarios); }

  @Get('diagnosis')
  @RequireTenantPermission('billing.read')
  diagnosis(@Tenant() t: TenantContext) { return this.svc.diagnosis(t); }

  @Get('customer-intelligence')
  @ApiOperation({ summary: 'Aggregate customer-question themes. No text, names or identifiers.' })
  @RequireTenantPermission('inbox.read')
  customers(@Tenant() t: TenantContext) { return this.svc.customerIntelligence(t); }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the executive orchestrator (bounded agents, fixed order). Proposes decisions; changes nothing.' })
  @Throttle(limit())
  @RequireTenantPermission('billing.read')
  run(@Tenant() t: TenantContext, @Headers('idempotency-key') key?: string) { return this.svc.run(t, key); }

  @Get('runs')
  @RequireTenantPermission('billing.read')
  runs(@Tenant() t: TenantContext) { return this.svc.runs(t); }

  @Get('decisions')
  @RequireTenantPermission('billing.read')
  decisions(@Tenant() t: TenantContext, @Query('status') status?: string) { return this.svc.decisions(t, status); }

  @Post('decisions/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a decision (merchant). Only a campaign proposal does anything: it creates a draft.' })
  @Throttle(limit())
  @RequireTenantPermission('content.approve')
  approve(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.approve(t, id); }

  @Post('decisions/:id/reject')
  @HttpCode(200)
  @RequireTenantPermission('content.approve')
  reject(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.reject(t, id); }
}
