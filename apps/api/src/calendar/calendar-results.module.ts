import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { CalendarResultsService } from './calendar-results.service';

/** Where publication outcomes are written back to the calendar (used by the publisher; no other dependencies). */
@Module({ imports: [NotificationsCoreModule], providers: [CalendarResultsService], exports: [CalendarResultsService] })
export class CalendarResultsModule {}
