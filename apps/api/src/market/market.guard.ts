import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

/** Feature flag: the market-intelligence endpoints do not exist (404) unless MARKET_INTELLIGENCE_ENABLED=true. */
@Injectable()
export class MarketEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.MARKET_INTELLIGENCE_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return true;
  }
}
