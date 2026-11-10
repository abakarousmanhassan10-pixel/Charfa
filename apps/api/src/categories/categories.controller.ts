import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CategoryKind } from '@touma/database';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';
import { CategoriesService } from './categories.service';

function categoryController(path: string, kind: CategoryKind, tag: string) {
  @ApiTags(tag)
  @ApiBearerAuth()
  @Controller(path)
  class KindCategoriesController {
    constructor(readonly categories: CategoriesService) {}

    @Get()
    @RequireTenantPermission('catalog.read')
    list(@Tenant() tenant: TenantContext) {
      return this.categories.list(tenant, kind);
    }

    @Post()
    @RequireTenantPermission('catalog.write')
    create(@Tenant() tenant: TenantContext, @Body() dto: CreateCategoryDto) {
      return this.categories.create(tenant, kind, dto);
    }

    /** Re-creates any missing industry default categories (never duplicates or overwrites). */
    @Post('restore-defaults')
    @RequireTenantPermission('catalog.write')
    restore(@Tenant() tenant: TenantContext) {
      return this.categories.restoreDefaults(tenant, kind);
    }

    @Patch(':id')
    @RequireTenantPermission('catalog.write')
    update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
      return this.categories.update(tenant, kind, id, dto);
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireTenantPermission('catalog.write')
    remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
      return this.categories.remove(tenant, kind, id);
    }
  }
  Object.defineProperty(KindCategoriesController, 'name', { value: `${kind[0]}${kind.slice(1).toLowerCase()}CategoriesController` });
  return KindCategoriesController;
}

export const ProductCategoriesController = categoryController('product-categories', 'PRODUCT', 'product-categories');
export const ServiceCategoriesController = categoryController('service-categories', 'SERVICE', 'service-categories');
