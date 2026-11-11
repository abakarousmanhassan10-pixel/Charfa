import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** Plain singleton module: the calendar worker and the API share one instance of the service. */
@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsCoreModule {}

@Module({ imports: [NotificationsCoreModule], controllers: [NotificationsController] })
export class NotificationsModule {}
