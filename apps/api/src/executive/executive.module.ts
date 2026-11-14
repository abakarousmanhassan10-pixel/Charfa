import { Module } from '@nestjs/common';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { ExecutiveController } from './executive.controller';
import { AutopilotEnabledGuard } from './executive.guard';
import { ExecutiveService } from './executive.service';

@Module({
  imports: [IntelligenceModule],
  controllers: [ExecutiveController],
  providers: [ExecutiveService, AutopilotEnabledGuard],
  exports: [ExecutiveService],
})
export class ExecutiveModule {}
