import { Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingCoreModule } from '../billing/billing.module';
import { CalendarCoreModule } from '../calendar/calendar.module';
import { AppEnv, InjectEnv } from '../config';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { PublishingAutomationService } from './automation.service';
import { PublishingPlannerService } from './planner.service';
import { PublishingPolicyService } from './policy.service';
import { PublishingController } from './publishing.controller';
import { AutopublishEnabledGuard } from './publishing.guard';

/** Background pass (queued decisions, expired reviews, crash recovery). Idempotent, so the API process and the worker process may both run it. Tests drive tick() themselves. */
@Injectable()
export class PublishingWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private readonly logger = new Logger('PublishingWorker');
  constructor(private readonly automation: PublishingAutomationService, @InjectEnv() private readonly env: AppEnv) {}
  onApplicationBootstrap() {
    if (!this.env.AUTOPUBLISH_ENABLED || this.env.APP_ENV === 'test') return;
    this.timer = setInterval(() => void this.automation.tick().catch((e) => this.logger.error(`tick failed: ${(e as Error).message}`)), this.env.AUTOPUBLISH_TICK_MS);
    this.timer.unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
}

@Module({
  imports: [AuditModule, BillingCoreModule, CalendarCoreModule, KnowledgeModule, NotificationsCoreModule],
  providers: [PublishingPolicyService, PublishingAutomationService, PublishingPlannerService, PublishingWorkerService],
  exports: [PublishingPolicyService, PublishingAutomationService, PublishingPlannerService],
})
export class PublishingCoreModule {}

@Module({ imports: [PublishingCoreModule], controllers: [PublishingController], providers: [AutopublishEnabledGuard] })
export class PublishingModule {}
