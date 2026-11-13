import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PageQueryDto } from '../common/pagination';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { AnalyzeMarketProductDto, ImportMarketProductDto, ListMarketProductsQueryDto } from './market.dto';
import { MarketEnabledGuard } from './market.guard';
import { MarketService } from './market.service';

const writeThrottle = () => ({ default: { limit: Number(process.env.MARKET_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/**
 * Market intelligence (Phase N4, first slice). Reading needs `analytics.read` (every member); importing a researched
 * product and running an analysis need `catalog.write` (editors and above).
 */
@ApiTags('market')
@ApiBearerAuth()
@UseGuards(MarketEnabledGuard)
@Controller('market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Post('products')
  @ApiOperation({ summary: 'Import a researched product from a record you supply, with its source URL and the date the figures were observed' })
  @RequireTenantPermission('catalog.write')
  @Throttle(writeThrottle())
  import(@Tenant() tenant: TenantContext, @Body() dto: ImportMarketProductDto) {
    return this.market.importProduct(tenant, dto);
  }

  @Get('products')
  @ApiOperation({ summary: 'Researched products with their latest analysis; filters: country, category, freshness, name' })
  @RequireTenantPermission('analytics.read')
  list(@Tenant() tenant: TenantContext, @Query() q: ListMarketProductsQueryDto) {
    return this.market.list(tenant, q);
  }

  @Get('products/:id')
  @RequireTenantPermission('analytics.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.market.get(tenant, id);
  }

  @Post('products/:id/analyses')
  @ApiOperation({ summary: 'Compute profitability and the explainable opportunity score with the assumptions you give (deterministic; no AI)' })
  @RequireTenantPermission('catalog.write')
  @Throttle(writeThrottle())
  analyze(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: AnalyzeMarketProductDto) {
    return this.market.analyze(tenant, id, dto.assumptions);
  }

  @Get('products/:id/analyses')
  @ApiOperation({ summary: 'Research history of a product, newest first' })
  @RequireTenantPermission('analytics.read')
  history(@Tenant() tenant: TenantContext, @Param('id') id: string, @Query() q: PageQueryDto) {
    return this.market.history(tenant, id, q);
  }
}
