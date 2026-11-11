import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiController } from './ai.controller';
import { AiApprovalService } from './ai-approval.service';
import { AiHistoryService } from './ai-history.service';
import { AiProviderModule } from './ai-provider';
import { AiQueueService } from './ai-queue';
import { AiUsageService } from './ai-usage.service';
import { AiWorkerService } from './ai-worker.service';
import { AiOrchestratorService } from './orchestrator.service';

/**
 * Everything a generation needs, without HTTP: orchestrator, usage accounting, queue producer and the queue worker.
 * A plain singleton module (imported by the AI API, the Creative Studio and the standalone worker), so there is exactly
 * one instance of each service per process. The worker starts on boot only when AI_WORKER_INLINE=true; the standalone
 * worker process (node dist/ai-worker.js) starts it explicitly.
 */
@Module({
  imports: [AiProviderModule, KnowledgeModule],
  providers: [AiOrchestratorService, AiUsageService, AiHistoryService, AiApprovalService, AiQueueService, AiWorkerService],
  exports: [AiOrchestratorService, AiUsageService, AiHistoryService, AiApprovalService, AiQueueService, AiWorkerService],
})
export class AiCoreModule {}

@Module({ imports: [AiCoreModule], controllers: [AiController] })
export class AiModule {}
