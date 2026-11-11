import { Module } from '@nestjs/common';
import { CalendarResultsModule } from '../calendar/calendar-results.module';
import { MediaModule } from '../media/media.module';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { SocialController } from './social.controller';
import { SocialAccountsService } from './social-accounts.service';
import { SocialAnalyticsService } from './social-analytics.service';
import { SocialPublishingGateway } from './social-gateway';
import { SocialProviderModule } from './social-providers';
import { SocialPublisherService } from './social-publisher.service';
import { SocialQueueService } from './social-queue';
import { SocialWebhooksController } from './social-webhooks.controller';
import { SocialWorkerService } from './social-worker.service';

/** Everything the social module needs without HTTP (a singleton module shared by the API and the worker process). */
@Module({
  imports: [SocialProviderModule, MediaModule, NotificationsCoreModule, CalendarResultsModule],
  providers: [SocialAccountsService, SocialPublisherService, SocialAnalyticsService, SocialQueueService, SocialWorkerService, SocialPublishingGateway],
  exports: [SocialAccountsService, SocialPublisherService, SocialAnalyticsService, SocialQueueService, SocialWorkerService, SocialPublishingGateway],
})
export class SocialCoreModule {}

@Module({ imports: [SocialCoreModule], controllers: [SocialController, SocialWebhooksController] })
export class SocialModule {}
