import { DynamicModule, Module } from '@nestjs/common';
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
 * Everything a generation needs, without HTTP: orchestrator, usage accounting, queue producer and the
 * queue worker. The API imports it with the worker off (it runs in its own process in production, or
 * inline when AI_WORKER_INLINE=true); the standalone worker imports it with the worker forced on.
 */
@Module({})
export class AiCoreModule {
  static register(opts: { startWorker: boolean }): DynamicModule {
    const providers = [AiOrchestratorService, AiUsageService, AiHistoryService, AiApprovalService, AiQueueService, AiWorkerService];
    return {
      module: AiCoreModule,
      imports: [AiProviderModule, KnowledgeModule],
      providers: [...providers, { provide: 'AI_WORKER_FORCE', useValue: opts.startWorker }],
      exports: providers,
    };
  }
}

@Module({ imports: [AiCoreModule.register({ startWorker: false })], controllers: [AiController] })
export class AiModule {}
