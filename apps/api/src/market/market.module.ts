import { Module } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketEnabledGuard } from './market.guard';
import { MarketService } from './market.service';

@Module({ controllers: [MarketController], providers: [MarketService, MarketEnabledGuard], exports: [MarketService] })
export class MarketModule {}
