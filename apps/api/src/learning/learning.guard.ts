import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the learning endpoints do not exist (404) unless LEARNING_ENABLED=true. */
@Injectable()
export class LearningEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}
  canActivate(): boolean {
    if (!this.env.LEARNING_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
