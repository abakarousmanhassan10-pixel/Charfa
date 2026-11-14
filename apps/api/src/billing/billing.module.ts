import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { BillingProviderModule } from './billing-provider';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingController } from './billing.controller';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';

@Module({
  imports: [BillingProviderModule, NotificationsCoreModule],
  controllers: [BillingController, BillingWebhooksController],
  providers: [BillingService, BillingEnabledGuard],
  exports: [BillingService],
})
export class BillingModule {}
