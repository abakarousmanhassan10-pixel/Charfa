import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the autopilot endpoints do not exist (404) unless AUTOPILOT_ENABLED=true. */
@Injectable()
export class AutopilotEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.AUTOPILOT_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
