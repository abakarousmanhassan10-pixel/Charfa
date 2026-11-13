import { Module } from '@nestjs/common';
import { RUN_ADAPTER_REGISTRY, SimulatedRunAdapters } from './run-adapters';
import { RunsController } from './runs.controller';
import { OrchestratorEnabledGuard } from './runs.guard';
import { RunsQueueService } from './runs-queue';
import { RunsService } from './runs.service';
import { RunsWorkerService } from './runs-worker.service';

/** Everything the orchestrator needs without HTTP (also imported by the standalone worker). */
@Module({
  providers: [RunsService, RunsQueueService, RunsWorkerService, SimulatedRunAdapters, { provide: RUN_ADAPTER_REGISTRY, useExisting: SimulatedRunAdapters }],
  exports: [RunsService, RunsQueueService, RunsWorkerService, SimulatedRunAdapters, RUN_ADAPTER_REGISTRY],
})
export class RunsCoreModule {}

@Module({ imports: [RunsCoreModule], controllers: [RunsController], providers: [OrchestratorEnabledGuard] })
export class RunsModule {}
