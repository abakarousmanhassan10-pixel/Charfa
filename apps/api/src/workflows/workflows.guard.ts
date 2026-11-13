import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the workflow endpoints do not exist (404) unless WORKFLOWS_ENABLED and ORCHESTRATOR_ENABLED are both true. */
@Injectable()
export class WorkflowsEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.WORKFLOWS_ENABLED || !this.env.ORCHESTRATOR_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
