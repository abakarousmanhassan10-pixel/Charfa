import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiController } from './ai.controller';
import { AiHistoryService } from './ai-history.service';
import { AiProviderModule } from './ai-provider';
import { AiUsageService } from './ai-usage.service';
import { AiOrchestratorService } from './orchestrator.service';

@Module({
  imports: [AiProviderModule, KnowledgeModule],
  controllers: [AiController],
  providers: [AiOrchestratorService, AiUsageService, AiHistoryService],
})
export class AiModule {}
