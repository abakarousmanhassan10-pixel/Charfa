import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the intelligence endpoints do not exist (404) unless INTELLIGENCE_ENABLED=true. */
@Injectable()
export class IntelligenceEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.INTELLIGENCE_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
