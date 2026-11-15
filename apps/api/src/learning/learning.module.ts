import { Module } from '@nestjs/common';
import { AppEnv, APP_ENV } from '../config';
import { SocialCoreModule } from '../social/social.module';
import type { AnalyticsProvider } from './analytics-provider';
import { MockAnalyticsProvider } from './analytics-provider';
import { LearningController } from './learning.controller';
import { LearningEnabledGuard } from './learning.guard';
import { AuditModule } from '../audit/audit.module';
import { LearningProfileService } from './learning-profile.service';
import { ANALYTICS_PROVIDER, PerformanceService } from './performance.service';
import { PreferencesService } from './preferences.service';
import { RecommendService } from './recommend.service';

/** The official platform collector is the social adapters (stored by SocialAnalyticsService); this seam only names it. */
const platformProvider: AnalyticsProvider = { name: 'platform-adapters', simulated: false, collect: async () => { throw new Error('the platform path is handled by SocialAnalyticsService'); } };

@Module({
  imports: [SocialCoreModule, AuditModule],
  providers: [PerformanceService, LearningProfileService, PreferencesService, RecommendService, { provide: ANALYTICS_PROVIDER, inject: [APP_ENV], useFactory: (env: AppEnv) => (env.ANALYTICS_PROVIDER === 'mock' ? new MockAnalyticsProvider() : platformProvider) }],
  exports: [PerformanceService, LearningProfileService, PreferencesService, RecommendService, ANALYTICS_PROVIDER],
})
export class LearningCoreModule {}

@Module({ imports: [LearningCoreModule], controllers: [LearningController], providers: [LearningEnabledGuard] })
export class LearningModule {}
