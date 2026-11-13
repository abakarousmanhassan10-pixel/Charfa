import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateRunDto, IDEMPOTENCY_KEY_REGEX, ListRunsQueryDto } from './runs.dto';
import { OrchestratorEnabledGuard } from './runs.guard';
import { RunsService } from './runs.service';

const createThrottle = () => ({ default: { limit: Number(process.env.ORCHESTRATOR_RATE_LIMIT_PER_MINUTE ?? 20), ttl: 60_000 } });

/**
 * AI Orchestrator MVP (Phase N2): predefined plans of simulated steps. No model is called and nothing leaves TOUMA.
 * Reading and creating need `ai.use`; approving or rejecting an outward step needs `content.approve` (admins and owners).
 */
@ApiTags('runs')
@ApiBearerAuth()
@UseGuards(OrchestratorEnabledGuard)
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an orchestrated run. 201 for a new run, 200 when the same Idempotency-Key and request were already accepted' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8-64 characters [A-Za-z0-9_-]' })
  @RequireTenantPermission('ai.use')
  @Throttle(createThrottle())
  async create(@Tenant() tenant: TenantContext, @Body() dto: CreateRunDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    if (!key || !IDEMPOTENCY_KEY_REGEX.test(key)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header of 8-64 characters [A-Za-z0-9_-]' });
    }
    const { run, replayed } = await this.runs.create(tenant, dto, key);
    res.status(replayed ? 200 : 201);
    return run;
  }

  @Get()
  @ApiOperation({ summary: 'Runs of the business, newest first' })
  @RequireTenantPermission('ai.use')
  list(@Tenant() tenant: TenantContext, @Query() q: ListRunsQueryDto) {
    return this.runs.list(tenant, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A run with its steps, statuses, attempts and errors' })
  @RequireTenantPermission('ai.use')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.runs.get(tenant, id);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Append-only history of a run (codes and counters only)' })
  @RequireTenantPermission('ai.use')
  events(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.runs.events(tenant, id);
  }

  @Post(':id/steps/:key/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a step that is WAITING_APPROVAL; it then runs' })
  @RequireTenantPermission('content.approve')
  approve(@Tenant() tenant: TenantContext, @Param('id') id: string, @Param('key') key: string) {
    return this.runs.approve(tenant, id, key);
  }

  @Post(':id/steps/:key/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a step that is WAITING_APPROVAL; the step and the run FAIL and the step never runs' })
  @RequireTenantPermission('content.approve')
  reject(@Tenant() tenant: TenantContext, @Param('id') id: string, @Param('key') key: string) {
    return this.runs.reject(tenant, id, key);
  }
}
