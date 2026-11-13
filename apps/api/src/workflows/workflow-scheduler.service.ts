import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';
import { WorkflowsService } from './workflows.service';

/** Starts due scheduled workflows on a timer (the worker process). Off unless WORKFLOWS_ENABLED and ORCHESTRATOR_ENABLED. */
@Injectable()
export class WorkflowSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('WorkflowScheduler');
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly workflows: WorkflowsService, @InjectEnv() private readonly env: AppEnv) {}

  get enabled() {
    return this.env.WORKFLOWS_ENABLED && this.env.ORCHESTRATOR_ENABLED;
  }

  get running() {
    return Boolean(this.timer);
  }

  async onApplicationBootstrap() {
    if (this.env.AI_WORKER_INLINE) this.start();
  }

  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error(`tick failed: ${(e as Error).name}`)), this.env.WORKFLOWS_TICK_MS);
    this.timer.unref();
    this.logger.log(`Workflow scheduler running (tick ${this.env.WORKFLOWS_TICK_MS} ms)`);
  }

  async tick(now = new Date()) {
    if (this.ticking || !this.enabled) return { started: 0, skipped: 0 };
    this.ticking = true;
    try {
      return await this.workflows.runDueSchedules(now);
    } finally {
      this.ticking = false;
    }
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
