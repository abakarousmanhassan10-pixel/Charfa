import { Module } from '@nestjs/common';
import { RunsCoreModule } from '../runs/runs.module';
import { WorkflowSchedulerService } from './workflow-scheduler.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsEnabledGuard } from './workflows.guard';
import { WorkflowsService } from './workflows.service';

/** Everything the workflow engine needs without HTTP (also imported by the standalone worker). */
@Module({ imports: [RunsCoreModule], providers: [WorkflowsService, WorkflowSchedulerService], exports: [WorkflowsService, WorkflowSchedulerService] })
export class WorkflowsCoreModule {}

@Module({ imports: [WorkflowsCoreModule], controllers: [WorkflowsController], providers: [WorkflowsEnabledGuard] })
export class WorkflowsModule {}
