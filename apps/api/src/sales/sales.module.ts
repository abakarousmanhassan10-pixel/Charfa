import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { RunsCoreModule } from '../runs/runs.module';
import { SalesController } from './sales.controller';
import { SalesAssistController } from './sales-assist.controller';
import { SalesAssistEnabledGuard } from './sales-assist.guard';
import { SalesAssistService } from './sales-assist.service';
import { SalesPublicController } from './sales-public.controller';
import { SalesAgentService } from './sales-agent.service';
import { SalesConversationsService } from './sales-conversations.service';
import { SalesCustomersService } from './sales-customers.service';
import { SalesInsightsService } from './sales-insights.service';
import { SalesCaptchaService } from './sales-captcha.service';
import { SalesMonitoringService } from './sales-monitoring.service';
import { SalesPublicService } from './sales-public.service';
import { SalesRetentionService } from './sales-retention.service';

/** Phase N5 pieces that need no HTTP and no model: also imported by the standalone worker so the workflow adapter exists there too. */
@Module({ imports: [RunsCoreModule], providers: [SalesAssistService], exports: [SalesAssistService] })
export class SalesAssistCoreModule {}

/** AI sales and customer service agent (Phase 7). The agent has no tools: it cannot send anything outside its conversation, place orders or take payments. */
@Module({
  imports: [AiCoreModule, KnowledgeModule, NotificationsCoreModule, SalesAssistCoreModule],
  controllers: [SalesController, SalesPublicController, SalesAssistController],
  providers: [SalesAssistEnabledGuard, SalesAgentService, SalesConversationsService, SalesCustomersService, SalesInsightsService, SalesPublicService, SalesCaptchaService, SalesRetentionService, SalesMonitoringService],
  exports: [SalesAgentService, SalesRetentionService, SalesMonitoringService],
})
export class SalesModule {}
