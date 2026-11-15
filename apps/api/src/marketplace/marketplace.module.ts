import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MarketplaceAdminController, MarketplaceController, MarketplaceEnabledGuard } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

@Module({ imports: [AuditModule], controllers: [MarketplaceController, MarketplaceAdminController], providers: [MarketplaceService, MarketplaceEnabledGuard], exports: [MarketplaceService] })
export class MarketplaceModule {}
