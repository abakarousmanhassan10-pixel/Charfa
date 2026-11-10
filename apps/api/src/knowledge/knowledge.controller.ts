import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateKnowledgeDto, KnowledgeQueryDto, UpdateKnowledgeDto } from './knowledge.dto';
import { KnowledgeService } from './knowledge.service';

@ApiTags('business-knowledge')
@ApiBearerAuth()
@Controller('business-knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @RequireTenantPermission('knowledge.read')
  list(@Tenant() tenant: TenantContext, @Query() q: KnowledgeQueryDto) {
    return this.knowledge.list(tenant, q);
  }

  @Get('summary')
  @RequireTenantPermission('knowledge.read')
  summary(@Tenant() tenant: TenantContext) {
    return this.knowledge.summary(tenant);
  }

  @Get('context')
  @ApiOperation({ summary: 'Exactly what TOUMA AI agents will see for this business (verified facts only)' })
  @RequireTenantPermission('knowledge.read')
  context(@Tenant() tenant: TenantContext) {
    return this.knowledge.buildAgentContext(tenant);
  }

  @Post()
  @RequireTenantPermission('knowledge.write')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateKnowledgeDto) {
    return this.knowledge.create(tenant, dto);
  }

  @Get(':id')
  @RequireTenantPermission('knowledge.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.knowledge.get(tenant, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit an entry (resets verification)' })
  @RequireTenantPermission('knowledge.write')
  update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateKnowledgeDto) {
    return this.knowledge.update(tenant, id, dto);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @RequireTenantPermission('knowledge.verify')
  verify(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.knowledge.setVerified(tenant, id, true);
  }

  @Post(':id/unverify')
  @HttpCode(200)
  @RequireTenantPermission('knowledge.verify')
  unverify(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.knowledge.setVerified(tenant, id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireTenantPermission('knowledge.write')
  remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.knowledge.remove(tenant, id);
  }
}
