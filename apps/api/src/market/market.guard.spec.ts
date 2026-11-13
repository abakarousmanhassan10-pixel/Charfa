import { NotFoundException } from '@nestjs/common';
import type { AppEnv } from '../config';
import { MarketEnabledGuard } from './market.guard';

describe('MarketEnabledGuard (feature flag)', () => {
  it('hides the endpoints unless MARKET_INTELLIGENCE_ENABLED', () => {
    expect(() => new MarketEnabledGuard({ MARKET_INTELLIGENCE_ENABLED: false } as AppEnv).canActivate()).toThrow(NotFoundException);
    expect(new MarketEnabledGuard({ MARKET_INTELLIGENCE_ENABLED: true } as AppEnv).canActivate()).toBe(true);
  });
});
