import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateServiceDto, ServiceQueryDto, UpdateServiceDto } from './services.dto';
import { ServicesService } from './services.service';

@ApiTags("services")
@ApiBearerAuth()
@Controller("services")
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  @RequireTenantPermission('catalog.read')
  list(@Tenant() tenant: TenantContext, @Query() q: ServiceQueryDto) {
    return this.services.list(tenant, q);
  }

  @Post()
  @RequireTenantPermission('catalog.write')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateServiceDto) {
    return this.services.create(tenant, dto);
  }

  @Get(':id')
  @RequireTenantPermission('catalog.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.services.get(tenant, id);
  }

  @Patch(':id')
  @RequireTenantPermission('catalog.write')
  update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateServiceDto) {
    return this.services.update(tenant, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireTenantPermission('catalog.write')
  remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.services.remove(tenant, id);
  }

}
