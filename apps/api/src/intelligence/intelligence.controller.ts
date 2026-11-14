import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreateExperimentDto, ForgetMemoryDto, ImprovementDto, PutMemoryDto } from './intelligence.dto';
import { IntelligenceEnabledGuard } from './intelligence.guard';
import { IntelligenceService } from './intelligence.service';
import { MemoryService } from './memory.service';
import { RecommendationsService } from './recommendations.service';

const limit = () => ({ default: { limit: Number(process.env.INTELLIGENCE_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/** Business intelligence (N21). Reads and proposes; nothing here publishes, sends a message, spends money or changes code. */
@ApiTags('intelligence')
@ApiBearerAuth()
@UseGuards(IntelligenceEnabledGuard)
@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly svc: IntelligenceService, private readonly memory: MemoryService, private readonly recs: RecommendationsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Business control center: campaigns, approvals, agents, experiments, recommendations, alerts, cost, quotas' })
  @RequireTenantPermission('content.read')
  overview(@Tenant() t: TenantContext) { return this.svc.overview(t); }

  // Memory
  @Get('memory')
  @RequireTenantPermission('content.read')
  listMemory(@Tenant() t: TenantContext, @Query('kind') kind?: string) { return this.memory.list(t, kind); }

  @Post('memory')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('content.write')
  putMemory(@Tenant() t: TenantContext, @Body() dto: PutMemoryDto) { return this.memory.put(t, dto); }

  @Post('memory/capture/:campaignId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Store minimized facts about an approved campaign (no customer data)' })
  @Throttle(limit())
  @RequireTenantPermission('content.write')
  capture(@Tenant() t: TenantContext, @Param('campaignId') id: string) { return this.svc.capture(t, id); }

  @Delete('memory')
  @ApiOperation({ summary: 'Delete memory: one entry, one kind, or everything for this business' })
  @RequireTenantPermission('business.update')
  forget(@Tenant() t: TenantContext, @Body() dto: ForgetMemoryDto) { return this.memory.forget(t, dto); }

  // Evaluations
  @Post('evaluations/run')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  runEvaluations(@Tenant() t: TenantContext) { return this.svc.runEvaluations(t); }

  @Get('evaluations')
  @RequireTenantPermission('content.read')
  evaluations(@Tenant() t: TenantContext) { return this.svc.latestEvaluations(t); }

  // Experiments
  @Get('experiments')
  @RequireTenantPermission('analytics.read')
  experiments(@Tenant() t: TenantContext) { return this.svc.listExperiments(t); }

  @Post('experiments')
  @Throttle(limit())
  @RequireTenantPermission('content.write')
  createExperiment(@Tenant() t: TenantContext, @Body() dto: CreateExperimentDto) { return this.svc.createExperiment(t, dto); }

  @Post('experiments/:id/conclude')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('analytics.read')
  conclude(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.concludeExperiment(t, id); }

  // Recommendations
  @Get('recommendations')
  @RequireTenantPermission('content.read')
  recommendations(@Tenant() t: TenantContext, @Query('status') status?: string) { return this.recs.list(t, status); }

  @Post('recommendations/generate')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  generate(@Tenant() t: TenantContext) { return this.recs.generate(t); }

  @Post('recommendations/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a recommendation (merchant decision). Follow-ups only create drafts that still need individual approval.' })
  @Throttle(limit())
  @RequireTenantPermission('content.approve')
  approve(@Tenant() t: TenantContext, @Param('id') id: string) { return this.recs.approve(t, id); }

  @Post('recommendations/:id/reject')
  @HttpCode(200)
  @RequireTenantPermission('content.approve')
  reject(@Tenant() t: TenantContext, @Param('id') id: string) { return this.recs.reject(t, id); }

  // Safe self-improvement
  @Post('improvements')
  @ApiOperation({ summary: 'Propose a bounded change to agent behavior. Nothing changes until evaluated offline and approved.' })
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  propose(@Tenant() t: TenantContext, @Body() dto: ImprovementDto) { return this.recs.proposeImprovement(t, dto); }

  @Post('improvements/suggest')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  suggest(@Tenant() t: TenantContext) { return this.recs.suggestImprovements(t); }

  @Post('improvements/:id/evaluate')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  evaluate(@Tenant() t: TenantContext, @Param('id') id: string) { return this.recs.evaluateImprovement(t, id); }

  // Alerts
  @Get('alerts')
  @RequireTenantPermission('content.read')
  alerts(@Tenant() t: TenantContext) { return this.svc.listAlerts(t); }

  @Post('alerts/scan')
  @HttpCode(200)
  @Throttle(limit())
  @RequireTenantPermission('analytics.read')
  scan(@Tenant() t: TenantContext) { return this.svc.scanAlerts(t); }
}
