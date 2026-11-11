import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { SalesController } from './sales.controller';
import { SalesPublicController } from './sales-public.controller';
import { SalesAgentService } from './sales-agent.service';
import { SalesConversationsService } from './sales-conversations.service';
import { SalesCustomersService } from './sales-customers.service';
import { SalesInsightsService } from './sales-insights.service';
import { SalesCaptchaService } from './sales-captcha.service';
import { SalesMonitoringService } from './sales-monitoring.service';
import { SalesPublicService } from './sales-public.service';
import { SalesRetentionService } from './sales-retention.service';

/** AI sales and customer service agent (Phase 7). The agent has no tools: it cannot send anything outside its conversation, place orders or take payments. */
@Module({
  imports: [AiCoreModule, KnowledgeModule, NotificationsCoreModule],
  controllers: [SalesController, SalesPublicController],
  providers: [SalesAgentService, SalesConversationsService, SalesCustomersService, SalesInsightsService, SalesPublicService, SalesCaptchaService, SalesRetentionService, SalesMonitoringService],
  exports: [SalesAgentService, SalesRetentionService, SalesMonitoringService],
})
export class SalesModule {}
