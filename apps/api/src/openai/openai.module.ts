import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai.module';
import { SalesModule } from '../sales/sales.module';
import { OpenAIProviderService } from './openai-provider.service';

@Module({ imports: [AiCoreModule, SalesModule], providers: [OpenAIProviderService], exports: [OpenAIProviderService] })
export class OpenAIModule {}
