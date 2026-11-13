import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the sales-assistant endpoints do not exist (404) unless SALES_ASSIST_ENABLED=true. */
@Injectable()
export class SalesAssistEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.SALES_ASSIST_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
