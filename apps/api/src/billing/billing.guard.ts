import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the billing endpoints do not exist (404) unless BILLING_ENABLED=true. */
@Injectable()
export class BillingEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}
  canActivate(): boolean {
    if (!this.env.BILLING_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
