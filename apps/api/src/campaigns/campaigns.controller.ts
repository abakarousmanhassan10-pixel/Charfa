import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CampaignsEnabledGuard } from './campaigns.guard';
import { CampaignsQueryDto, CreateCampaignDto, EvaluateCampaignDto, PlanCampaignDto } from './campaigns.dto';
import { CampaignsService } from './campaigns.service';

const limit = () => ({ default: { limit: Number(process.env.CAMPAIGN_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/**
 * AI Marketing Director (N20). Drafts only: nothing here approves, authorizes, schedules or publishes a post. Those stay on the
 * calendar approval endpoints (N18), one post at a time.
 */
@ApiTags('campaigns')
@ApiBearerAuth()
@UseGuards(CampaignsEnabledGuard)
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequireTenantPermission('content.read')
  list(@Tenant() t: TenantContext, @Query() q: CampaignsQueryDto) {
    return this.campaigns.list(t, q);
  }

  @Post()
  @ApiOperation({ summary: 'Create a campaign draft from verified products' })
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  create(@Tenant() t: TenantContext, @Body() dto: CreateCampaignDto, @Headers('idempotency-key') key?: string) {
    return this.campaigns.create(t, { ...dto, idempotencyKey: key?.slice(0, 120) || randomUUID() });
  }

  @Post('triage/comments/:commentId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer-service decision for a comment (reply draft or escalation). Sends nothing.' })
  @Throttle(limit())
  @RequireTenantPermission('inbox.read')
  triage(@Tenant() t: TenantContext, @Param('commentId') id: string) {
    return this.campaigns.triageComment(t, id);
  }

  @Get(':id')
  @RequireTenantPermission('content.read')
  get(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.view(t, id);
  }

  @Post(':id/plan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the planning agents (mock) and store the plan' })
  @Throttle(limit())
  @RequireTenantPermission('ai.use')
  plan(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: PlanCampaignDto) {
    return this.campaigns.plan(t, id, dto);
  }

  @Post(':id/content')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create fact-checked DRAFT calendar entries from the plan' })
  @Throttle(limit())
  @RequireTenantPermission('content.write')
  content(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.generateContent(t, id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send every draft to individual approval (N18). Approving stays a human decision.' })
  @Throttle(limit())
  @RequireTenantPermission('content.write')
  submit(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.submit(t, id);
  }

  @Post(':id/metrics')
  @HttpCode(200)
  @ApiOperation({ summary: 'Evaluate performance from authorized metrics (real, simulated, unavailable are kept apart)' })
  @Throttle(limit())
  @RequireTenantPermission('analytics.read')
  metrics(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: EvaluateCampaignDto) {
    return this.campaigns.evaluate(t, id, dto.refresh === true);
  }

  @Post(':id/follow-ups')
  @HttpCode(200)
  @ApiOperation({ summary: 'Draft follow-up posts recommended by the evaluation (each needs its own approval)' })
  @Throttle(limit())
  @RequireTenantPermission('content.write')
  followUps(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.followUps(t, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @ApiOperation({ summary: 'Kill switch: no agent runs and nothing new is drafted' })
  @RequireTenantPermission('content.approve')
  pause(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.setPaused(t, id, true);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequireTenantPermission('content.approve')
  resume(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.setPaused(t, id, false);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel the campaign and withdraw every unpublished post' })
  @RequireTenantPermission('content.approve')
  cancel(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.campaigns.cancel(t, id);
  }
}
