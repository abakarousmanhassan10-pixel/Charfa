import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';
import { BillingEngine } from './billing-engine.service';
import { BillingProviderModule } from './billing-provider';
import { BillingSimulator } from './billing-simulator.service';
import { BillingSimulatorController, SimulatorGuard } from './billing-simulator.controller';
import { BillingWebhookProcessor } from './billing-webhook.processor';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingController } from './billing.controller';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';
import { FounderService } from './founder.service';

/** Service only (no HTTP): imported by modules that must authorize paid actions (AI, Creative Studio, Sales). */
@Module({ imports: [BillingProviderModule, NotificationsCoreModule], providers: [BillingService, BillingEngine, FounderService], exports: [BillingService] })
export class BillingCoreModule {}

@Module({
  imports: [BillingCoreModule, BillingProviderModule, NotificationsCoreModule],
  controllers: [BillingController, BillingWebhooksController, BillingSimulatorController, BillingAdminController],
  providers: [BillingEnabledGuard, SimulatorGuard, BillingWebhookProcessor, BillingSimulator, BillingAdminService, BillingEngine, FounderService],
})
export class BillingModule {}
