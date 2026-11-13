import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PageQueryDto } from '../common/pagination';
import { IDEMPOTENCY_KEY_REGEX } from '../runs/runs.dto';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateWorkflowDto, StartExecutionDto, UpdateWorkflowDto } from './workflows.dto';
import { WorkflowsEnabledGuard } from './workflows.guard';
import { WorkflowsService } from './workflows.service';

const startThrottle = () => ({ default: { limit: Number(process.env.ORCHESTRATOR_RATE_LIMIT_PER_MINUTE ?? 20), ttl: 60_000 } });

/**
 * Workflow definitions and executions (Phase N3). Defining and activating workflows needs `business.update` (admins and
 * owners: a definition decides what may run on its own); reading and starting need `ai.use`. Executions are managed with
 * /runs (status, history, approve, reject, pause, resume, cancel, retry, resolve).
 */
@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(WorkflowsEnabledGuard)
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a workflow (version 1, inactive)' })
  @RequireTenantPermission('business.update')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(tenant, dto);
  }

  @Get()
  @RequireTenantPermission('ai.use')
  list(@Tenant() tenant: TenantContext, @Query() q: PageQueryDto) {
    return this.workflows.list(tenant, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A workflow with its current definition and version list' })
  @RequireTenantPermission('ai.use')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.workflows.get(tenant, id);
  }

  @Get(':id/versions/:version')
  @RequireTenantPermission('ai.use')
  version(@Tenant() tenant: TenantContext, @Param('id') id: string, @Param('version', ParseIntPipe) version: number) {
    return this.workflows.getVersion(tenant, id, version);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Save a new version of the definition (older versions and running executions are untouched)' })
  @RequireTenantPermission('business.update')
  update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateWorkflowDto) {
    return this.workflows.update(tenant, id, dto);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activate: executions can start; schedule and event triggers run with the permissions of the person who activates' })
  @RequireTenantPermission('business.update')
  activate(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.workflows.setActive(tenant, id, true);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequireTenantPermission('business.update')
  deactivate(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.workflows.setActive(tenant, id, false);
  }

  @Post(':id/executions')
  @ApiOperation({ summary: 'Start an execution (manual trigger). 201 new, 200 same Idempotency-Key and request' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @RequireTenantPermission('ai.use')
  @Throttle(startThrottle())
  async start(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: StartExecutionDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    if (!key || !IDEMPOTENCY_KEY_REGEX.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header of 8-64 characters [A-Za-z0-9_-]' });
    const { run, replayed } = await this.workflows.start(tenant, id, dto.input, key);
    res.status(replayed ? 200 : 201);
    return run;
  }

  @Get(':id/executions')
  @ApiOperation({ summary: 'Executions of this workflow, newest first, with their steps' })
  @RequireTenantPermission('ai.use')
  executions(@Tenant() tenant: TenantContext, @Param('id') id: string, @Query() q: PageQueryDto) {
    return this.workflows.executions(tenant, id, q);
  }
}
