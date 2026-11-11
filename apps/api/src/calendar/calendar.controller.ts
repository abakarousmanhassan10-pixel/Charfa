import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { SocialPlatform } from '@touma/database';
import { GenerationQueryDto } from '../ai/ai.dto';
import { generationDto } from '../ai/ai-history.service';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { PageQueryDto } from '../common/pagination';
import {
  ApplyPlanDto, ApprovalsQueryDto, AuthorizeDto, CreateEntryDto, CreatePlanDto, CreateRecurrenceDto, DecisionDto, RangeQueryDto, RecommendQueryDto, RejectDto, RescheduleDto, UpdateEntryDto, UseContentDto,
} from './calendar.dto';
import { CalendarService } from './calendar.service';
import { CalendarWorkerService } from './calendar-worker.service';
import { SetEntryAccountDto } from '../social/social.dto';
import { PlanService } from './plan.service';
import { RecurrenceService } from './recurrence.service';

/** Plan generation costs AI usage: limit it per client. */
const planThrottle = () => ({ default: { limit: Number(process.env.CALENDAR_RATE_LIMIT_PER_MINUTE ?? 60), ttl: 60_000 } });

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly plans: PlanService,
    private readonly recurrences: RecurrenceService,
    private readonly worker: CalendarWorkerService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Next 30 days at a glance: counts by status and pillar, pending approvals, conflicts, upcoming entries' })
  @RequireTenantPermission('content.read')
  overview(@Tenant() tenant: TenantContext) {
    return this.calendar.overview(tenant);
  }

  // ─── Entries ────────────────────────────────────────────────────────────────

  @Get('entries')
  @ApiOperation({ summary: 'Entries in a date range (business timezone), with the conflicts inside it' })
  @RequireTenantPermission('content.read')
  list(@Tenant() tenant: TenantContext, @Query() q: RangeQueryDto) {
    return this.calendar.list(tenant, q);
  }

  @Post('entries')
  @ApiOperation({ summary: 'Plan a post. Without a time, the recommended time is used (labelled analytics or estimate)' })
  @RequireTenantPermission('content.write')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateEntryDto) {
    return this.calendar.create(tenant, dto);
  }

  @Get('entries/:id')
  @RequireTenantPermission('content.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.calendar.get(tenant, id);
  }

  @Get('entries/:id/history')
  @ApiOperation({ summary: 'Approval records of an entry: who submitted, approved, rejected, authorized or withdrew, and when' })
  @RequireTenantPermission('content.read')
  history(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.calendar.history(tenant, id);
  }

  @Patch('entries/:id')
  @ApiOperation({ summary: 'Edit an entry. Changing the text withdraws any approval and authorization' })
  @RequireTenantPermission('content.write')
  update(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UpdateEntryDto) {
    return this.calendar.update(tenant, id, dto);
  }

  @Post('entries/:id/reschedule')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move an entry (drag and drop). 409 CONFLICT_CONFIRMATION_REQUIRED lists soft conflicts to confirm' })
  @RequireTenantPermission('content.write')
  reschedule(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: RescheduleDto) {
    return this.calendar.reschedule(tenant, id, dto);
  }

  @Post('entries/:id/use-content')
  @HttpCode(200)
  @ApiOperation({ summary: 'Use an existing content (for example a saved AI draft) for this entry' })
  @RequireTenantPermission('content.write')
  useContent(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: UseContentDto) {
    return this.calendar.useContent(tenant, id, dto.contentId);
  }

  @Post('entries/:id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit for approval (DRAFT or REJECTED → IN_REVIEW)' })
  @RequireTenantPermission('content.write')
  submit(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.calendar.submit(tenant, id);
  }

  @Post('entries/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve the exact text in review (IN_REVIEW → APPROVED). AI text is re-checked against the business data' })
  @RequireTenantPermission('content.approve')
  approve(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.calendar.approve(tenant, id, dto.note);
  }

  @Post('entries/:id/reject')
  @HttpCode(200)
  @RequireTenantPermission('content.approve')
  reject(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.calendar.reject(tenant, id, dto.reason);
  }

  @Post('entries/:id/authorize')
  @HttpCode(200)
  @ApiOperation({ summary: 'Explicit business authorization to publish the approved version at the planned time (APPROVED → SCHEDULED)' })
  @RequireTenantPermission('publication.schedule')
  authorize(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: AuthorizeDto) {
    return this.calendar.authorize(tenant, id, dto.acknowledgeConflicts);
  }

  @Post('entries/:id/publish-now')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish immediately: explicit authorization of the approved version, handed to the publisher straight away' })
  @RequireTenantPermission('publication.schedule')
  async publishNow(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    const entry = await this.calendar.publishNow(tenant, id);
    void this.worker.tick().catch(() => undefined);
    return entry;
  }

  @Put('entries/:id/account')
  @ApiOperation({ summary: 'Choose the connected account this entry publishes to' })
  @RequireTenantPermission('content.write')
  setAccount(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: SetEntryAccountDto) {
    return this.calendar.setAccount(tenant, id, dto.socialAccountId);
  }

  @Put('entries/:id/tiktok-settings')
  @ApiOperation({ summary: "Save the person's TikTok posting choices (privacy, comment/duet/stitch, commercial disclosure, consent). Changing them withdraws approval" })
  @RequireTenantPermission('content.write')
  setTikTokSettings(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.calendar.setTikTokSettings(tenant, id, body);
  }

  @Post('entries/:id/unschedule')
  @HttpCode(200)
  @RequireTenantPermission('publication.schedule')
  unschedule(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.calendar.unschedule(tenant, id);
  }

  @Post('entries/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Authorize a FAILED entry again, optionally at a new time' })
  @RequireTenantPermission('publication.schedule')
  retry(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: RescheduleDto) {
    return this.calendar.retry(tenant, id, dto);
  }

  @Post('entries/:id/cancel')
  @HttpCode(200)
  @RequireTenantPermission('content.write')
  cancel(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: DecisionDto) {
    return this.calendar.cancel(tenant, id, dto.note);
  }

  @Delete('entries/:id')
  @RequireTenantPermission('content.write')
  remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.calendar.remove(tenant, id);
  }

  // ─── Insight ────────────────────────────────────────────────────────────────

  @Get('conflicts')
  @ApiOperation({ summary: 'Entries that are too close together or over the daily limit in a range' })
  @RequireTenantPermission('content.read')
  conflicts(@Tenant() tenant: TenantContext, @Query() q: RangeQueryDto) {
    return this.calendar.conflicts(tenant, q);
  }

  @Get('recommendations')
  @ApiOperation({ summary: 'Recommended posting times for a platform and date. source=ESTIMATE means general guidance, not audience data' })
  @RequireTenantPermission('content.read')
  recommendations(@Tenant() tenant: TenantContext, @Query() q: RecommendQueryDto) {
    return this.calendar.recommendations(tenant, q.platform as SocialPlatform, q.date);
  }

  @Get('approvals')
  @ApiOperation({ summary: 'Entries waiting for approval, or the history of decisions' })
  @RequireTenantPermission('content.read')
  approvals(@Tenant() tenant: TenantContext, @Query() q: ApprovalsQueryDto) {
    return this.calendar.approvals(tenant, q);
  }

  // ─── AI plans ───────────────────────────────────────────────────────────────

  @Post('plans')
  @HttpCode(202)
  @Throttle(planThrottle())
  @ApiOperation({ summary: 'Queue a 7-30 day marketing plan (background TOUMA AI job). Nothing enters the calendar until the plan is applied' })
  @RequireTenantPermission('ai.use')
  async createPlan(@Tenant() tenant: TenantContext, @Body() dto: CreatePlanDto) {
    const g = await this.plans.submit(tenant, dto);
    return { ...generationDto(g), statusUrl: `/api/v1/ai/generations/${g.id}/status` };
  }

  @Get('plans')
  @RequireTenantPermission('content.read')
  planGenerations(@Tenant() tenant: TenantContext, @Query() q: GenerationQueryDto) {
    return this.plans.list(tenant, q);
  }

  @Get('plans/applied')
  @RequireTenantPermission('content.read')
  appliedPlans(@Tenant() tenant: TenantContext) {
    return this.plans.plans(tenant);
  }

  @Get('plans/:generationId')
  @ApiOperation({ summary: 'A finished plan with the proposed date and time of each post' })
  @RequireTenantPermission('content.read')
  previewPlan(@Tenant() tenant: TenantContext, @Param('generationId') id: string) {
    return this.plans.preview(tenant, id);
  }

  @Post('plans/:generationId/apply')
  @HttpCode(201)
  @ApiOperation({ summary: 'Put the plan on the calendar as drafts (once per plan)' })
  @RequireTenantPermission('content.write')
  applyPlan(@Tenant() tenant: TenantContext, @Param('generationId') id: string, @Body() dto: ApplyPlanDto) {
    return this.plans.apply(tenant, id, dto);
  }

  // ─── Recurring schedules ────────────────────────────────────────────────────

  @Get('recurrences')
  @RequireTenantPermission('content.read')
  listRecurrences(@Tenant() tenant: TenantContext, @Query() _q: PageQueryDto) {
    return this.recurrences.list(tenant);
  }

  @Post('recurrences')
  @ApiOperation({ summary: 'Create a recurring schedule; its occurrences become draft entries at the same local time every time' })
  @RequireTenantPermission('content.write')
  createRecurrence(@Tenant() tenant: TenantContext, @Body() dto: CreateRecurrenceDto) {
    return this.recurrences.create(tenant, dto);
  }

  @Delete('recurrences/:id')
  @ApiOperation({ summary: 'Stop a recurring schedule and cancel its unapproved future entries' })
  @RequireTenantPermission('content.write')
  removeRecurrence(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.recurrences.remove(tenant, id);
  }
}
