import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { BillingProviderModule } from './billing-provider';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingController } from './billing.controller';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';

/** Service only (no HTTP): imported by modules that must authorize paid actions (AI, Creative Studio). */
@Module({ imports: [BillingProviderModule, NotificationsCoreModule], providers: [BillingService], exports: [BillingService] })
export class BillingCoreModule {}

@Module({ imports: [BillingCoreModule], controllers: [BillingController, BillingWebhooksController], providers: [BillingEnabledGuard] })
export class BillingModule {}
