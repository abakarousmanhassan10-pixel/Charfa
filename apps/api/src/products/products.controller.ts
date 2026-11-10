import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateProductDto, ProductQueryDto, SetProductMediaDto, UpdateProductDto } from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequireTenantPermission('catalog.read')
  list(@Tenant() tenant: TenantContext, @Query() q: ProductQueryDto) {
    return this.products.list(tenant, q);
  }

  @Post()
  @RequireTenantPermission('catalog.write')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateProductDto) {
    return this.products.create(tenant, dto);
  }

  @Get(':id')
  @RequireTenantPermission('catalog.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.products.get(tenant, id);
  }

  @Patch(':id')
  @RequireTenantPermission('catalog.write')
  update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(tenant, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireTenantPermission('catalog.write')
  remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.products.remove(tenant, id);
  }

  /** Replaces the ordered list of product images/videos. */
  @Put(':id/media')
  @RequireTenantPermission('catalog.write')
  setMedia(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: SetProductMediaDto) {
    return this.products.setMedia(tenant, id, dto.mediaIds);
  }
}
