import { Body, CanActivate, Controller, HttpCode, Injectable, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppEnv, InjectEnv } from '../config';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { BillingSimulator } from './billing-simulator.service';
import { RewindDto, SimulateConfirmDto, SimulateDueDto } from './billing.dto';
import { BillingEnabledGuard } from './billing.guard';

/** The simulator routes exist only with the mock provider (BILLING_PROVIDER=simulated, which the server refuses outside APP_ENV=test). */
@Injectable()
export class SimulatorGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}
  canActivate(): boolean {
    if (this.env.BILLING_PROVIDER !== 'simulated') throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}

@ApiTags('billing-simulator')
@ApiBearerAuth()
@UseGuards(BillingEnabledGuard, SimulatorGuard)
@Controller('billing/simulator')
export class BillingSimulatorController {
  constructor(private readonly sim: BillingSimulator) {}

  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'SIMULATION: the mock provider confirms or declines a payment session (signed notification through the real webhook path)' })
  @RequireTenantPermission('billing.manage')
  confirm(@Tenant() t: TenantContext, @Body() dto: SimulateConfirmDto) { return this.sim.confirmPayment(t, dto.paymentId, dto.outcome); }

  @Post('card-saved')
  @HttpCode(200)
  @ApiOperation({ summary: 'SIMULATION: the mock provider confirms that the hosted card page saved a card' })
  @RequireTenantPermission('billing.manage')
  cardSaved(@Tenant() t: TenantContext) { return this.sim.cardSaved(t); }

  @Post('due')
  @HttpCode(200)
  @ApiOperation({ summary: 'SIMULATION: the automatic renewal falls due; the mock provider charges or declines' })
  @RequireTenantPermission('billing.manage')
  due(@Tenant() t: TenantContext, @Body() dto: SimulateDueDto) { return this.sim.dueAutoRenewal(t, dto.outcome); }

  @Post('rewind')
  @HttpCode(200)
  @ApiOperation({ summary: 'SIMULATION: move this subscription\'s billing clock back by whole days' })
  @RequireTenantPermission('billing.manage')
  rewind(@Tenant() t: TenantContext, @Body() dto: RewindDto) { return this.sim.rewind(t, Number(dto.days)); }

  @Post('process-due')
  @HttpCode(200)
  @ApiOperation({ summary: 'SIMULATION: run the due-date processing (reminders, grace, expiry) now' })
  @RequireTenantPermission('billing.manage')
  processDue() { return this.sim.processDue(); }
}
