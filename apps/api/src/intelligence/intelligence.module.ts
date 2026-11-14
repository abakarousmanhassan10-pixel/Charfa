import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceEnabledGuard } from './intelligence.guard';
import { IntelligenceService } from './intelligence.service';
import { MemoryService } from './memory.service';
import { RecommendationsService } from './recommendations.service';

@Module({
  imports: [CampaignsModule, KnowledgeModule],
  controllers: [IntelligenceController],
  providers: [IntelligenceService, MemoryService, RecommendationsService, IntelligenceEnabledGuard],
  exports: [IntelligenceService, MemoryService, RecommendationsService],
})
export class IntelligenceModule {}
