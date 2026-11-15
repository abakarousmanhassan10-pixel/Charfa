import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
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
import { ProviderIncidentInterceptor } from './provider-incident.interceptor';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { FounderService } from './founder.service';
import { PlanFeatureInterceptor } from './plan-feature';

/** Service only (no HTTP): imported by modules that must authorize paid actions (AI, Creative Studio, Sales). */
@Module({ imports: [BillingProviderModule, NotificationsCoreModule], providers: [BillingService, BillingEngine, FounderService, EntitlementsService, { provide: APP_INTERCEPTOR, useClass: PlanFeatureInterceptor }], exports: [BillingService, EntitlementsService] })
export class BillingCoreModule {}

@Module({
  imports: [BillingCoreModule, BillingProviderModule, NotificationsCoreModule],
  controllers: [BillingController, BillingWebhooksController, BillingSimulatorController, BillingAdminController],
  providers: [BillingEnabledGuard, SimulatorGuard, ProviderIncidentInterceptor, BillingWebhookProcessor, BillingSimulator, BillingAdminService, BillingEngine, FounderService, EntitlementsService],
})
export class BillingModule {}
