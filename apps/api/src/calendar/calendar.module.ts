import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { CalendarController } from './calendar.controller';
import { CalendarQueueService } from './calendar-queue';
import { CalendarService } from './calendar.service';
import { CalendarWorkerService } from './calendar-worker.service';
import { PlanService } from './plan.service';
import { PUBLISHING_GATEWAY, UnavailablePublishingGateway } from './publishing';
import { RecurrenceService } from './recurrence.service';
import { SchedulingService } from './scheduling.service';

/**
 * Everything the calendar needs without HTTP (a singleton module, like AiCoreModule). Phase 6 provides the real
 * publisher by replacing the PUBLISHING_GATEWAY provider.
 */
@Module({
  imports: [AiCoreModule, KnowledgeModule, NotificationsCoreModule],
  providers: [
    CalendarService, SchedulingService, PlanService, RecurrenceService, CalendarQueueService, CalendarWorkerService,
    { provide: PUBLISHING_GATEWAY, useClass: UnavailablePublishingGateway },
  ],
  exports: [CalendarService, SchedulingService, PlanService, RecurrenceService, CalendarQueueService, CalendarWorkerService, PUBLISHING_GATEWAY],
})
export class CalendarCoreModule {}

@Module({ imports: [CalendarCoreModule, AiCoreModule], controllers: [CalendarController] })
export class CalendarModule {}
