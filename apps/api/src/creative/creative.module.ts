import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MediaModule } from '../media/media.module';
import { BrandKitService } from './brand-kit.service';
import { CreativeController } from './creative.controller';
import { CreativeProviderModule } from './creative-providers';
import { CreativeQueueService } from './creative-queue';
import { CreativeService } from './creative.service';
import { CreativeUsageService } from './creative-usage.service';
import { CreativeWorkerService } from './creative-worker.service';

/** Everything the Creative Studio needs without HTTP (a singleton module, like AiCoreModule). */
@Module({
  imports: [CreativeProviderModule, MediaModule, KnowledgeModule, AiCoreModule],
  providers: [CreativeService, CreativeUsageService, CreativeQueueService, CreativeWorkerService, BrandKitService],
  exports: [CreativeService, CreativeUsageService, CreativeQueueService, CreativeWorkerService, BrandKitService],
})
export class CreativeCoreModule {}

@Module({ imports: [CreativeCoreModule, AiCoreModule], controllers: [CreativeController] })
export class CreativeModule {}
