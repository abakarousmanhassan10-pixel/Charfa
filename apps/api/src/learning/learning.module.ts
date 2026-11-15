import { Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing.module';
import { CalendarCoreModule } from '../calendar/calendar.module';
import { PublishingCoreModule } from '../publishing/publishing.module';
import { AppEnv, APP_ENV, InjectEnv } from '../config';
import { SocialCoreModule } from '../social/social.module';
import type { AnalyticsProvider } from './analytics-provider';
import { MockAnalyticsProvider } from './analytics-provider';
import { LearningController } from './learning.controller';
import { LearningEnabledGuard } from './learning.guard';
import { AuditModule } from '../audit/audit.module';
import { ExperimentsService } from './experiments.service';
import { LearningService } from './learning.service';
import { LearningProfileService } from './learning-profile.service';
import { ANALYTICS_PROVIDER, PerformanceService } from './performance.service';
import { PreferencesService } from './preferences.service';
import { RecommendService } from './recommend.service';

/** The official platform collector is the social adapters (stored by SocialAnalyticsService); this seam only names it. */
const platformProvider: AnalyticsProvider = { name: 'platform-adapters', simulated: false, collect: async () => { throw new Error('the platform path is handled by SocialAnalyticsService'); } };

/** Scheduled pass of the learning loop. Idempotent and quota-bound, so the API and the worker process may both run it. Tests drive tick() themselves. */
@Injectable()
export class LearningWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  constructor(private readonly loop: LearningService, @InjectEnv() private readonly env: AppEnv) {}
  onApplicationBootstrap() {
    if (!this.env.LEARNING_ENABLED || this.env.APP_ENV === 'test') return;
    this.timer = setInterval(() => void this.loop.tick().catch(() => undefined), this.env.LEARNING_TICK_MS);
    this.timer.unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
}

@Module({
  imports: [SocialCoreModule, AuditModule, BillingCoreModule, CalendarCoreModule, PublishingCoreModule],
  providers: [PerformanceService, LearningProfileService, PreferencesService, RecommendService, LearningService, ExperimentsService, LearningWorkerService, { provide: ANALYTICS_PROVIDER, inject: [APP_ENV], useFactory: (env: AppEnv) => (env.ANALYTICS_PROVIDER === 'mock' ? new MockAnalyticsProvider() : platformProvider) }],
  exports: [PerformanceService, LearningProfileService, PreferencesService, RecommendService, LearningService, ExperimentsService, ANALYTICS_PROVIDER],
})
export class LearningCoreModule {}

@Module({ imports: [LearningCoreModule], controllers: [LearningController], providers: [LearningEnabledGuard] })
export class LearningModule {}
