import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CONSENT_VERSION, PLATFORM_AUTOMATION, PUBLISHING_MODES } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { PublishingAutomationService } from './automation.service';
import { AutopublishEnabledGuard } from './publishing.guard';
import { PublishingPlannerService } from './planner.service';
import { PublishingPolicyService } from './policy.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const id = z.string().min(1).max(40);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const policyBody = z.object({
  mode: z.enum(PUBLISHING_MODES).optional(), maximumPostsPerDay: z.number().int().min(1).max(10).optional(), timezone: z.string().max(64).optional(),
  allowedContentTypes: z.array(z.enum(['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'])).min(1).max(4).optional(),
  allowedPublishingHours: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), from: hhmm, to: hhmm }).strict()).min(1).max(14).optional(),
  requiresPlatformConfirmation: z.boolean().optional(), automationEnabled: z.boolean().optional(),
}).strict();
const consentBody = z.object({ accept: z.literal(true), consentVersion: z.string().max(30) }).strict();
const postSchema = z.object({ title: z.string().trim().min(1).max(120), caption: z.string().trim().min(1).max(2200), hashtags: z.array(z.string().max(60)).max(30).optional(), contentType: z.enum(['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO']).optional(), mediaIds: z.array(id).max(10).optional(), callToAction: z.string().max(250).optional(), productId: id.optional() }).strict();
const planBody = z.object({ accountId: id, days: z.number().int().min(1).max(14).default(7), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), posts: z.array(postSchema).max(14).optional(), process: z.boolean().default(true) }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(1).max(300) }).strict();
const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), page: z.coerce.number().int().min(1).max(1000).default(1) });
const rl = () => ({ default: { limit: Number(process.env.AUTOPUBLISH_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/**
 * Autonomous and hybrid publishing (N21). Off by default (404). Reading needs `autopublish.read`; consent, mode, limits, pause, planning need `autopublish.manage`;
 * approving a post that needs review needs `content.approve` and `publication.schedule`. The business always comes from the verified tenant context.
 */
@ApiTags('publishing')
@ApiBearerAuth()
@UseGuards(AutopublishEnabledGuard)
@Controller('publishing')
export class PublishingController {
  constructor(private readonly policies: PublishingPolicyService, private readonly automation: PublishingAutomationService, private readonly planner: PublishingPlannerService, private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv) {}

  @Get('accounts') @RequireTenantPermission('autopublish.read') accounts(@Tenant() t: TenantContext) { return this.policies.list(t); }
  @Get('capabilities') @RequireTenantPermission('autopublish.read') capabilities() { return { consentVersion: CONSENT_VERSION, platforms: PLATFORM_AUTOMATION, note: 'Statements about the platforms come from official documentation read by TOUMA and were not tested against real accounts.', publishingEnabled: this.env.SOCIAL_PUBLISHING_ENABLED }; }
  @Get('accounts/:accountId') @RequireTenantPermission('autopublish.read') account(@Tenant() t: TenantContext, @Param('accountId') a: string) { return this.policies.get(t, a); }

  @Post('accounts/:accountId/consent') @HttpCode(200) @RequireTenantPermission('autopublish.manage')
  consent(@Tenant() t: TenantContext, @Param('accountId') a: string, @Body() b: unknown) { return this.policies.grantConsent(t, a, parse(consentBody, b).consentVersion); }
  @Post('accounts/:accountId/consent/revoke') @HttpCode(200) @RequireTenantPermission('autopublish.manage') revoke(@Tenant() t: TenantContext, @Param('accountId') a: string) { return this.policies.revokeConsent(t, a); }
  @Put('accounts/:accountId/policy') @RequireTenantPermission('autopublish.manage')
  policy(@Tenant() t: TenantContext, @Param('accountId') a: string, @Body() b: unknown) { return this.policies.update(t, a, parse(policyBody, b)); }
  @Post('accounts/:accountId/pause') @HttpCode(200) @RequireTenantPermission('autopublish.manage') pause(@Tenant() t: TenantContext, @Param('accountId') a: string) { return this.policies.pause(t, a); }
  @Post('accounts/:accountId/resume') @HttpCode(200) @RequireTenantPermission('autopublish.manage') resume(@Tenant() t: TenantContext, @Param('accountId') a: string) { return this.policies.resume(t, a); }

  @Post('plan') @HttpCode(201) @Throttle(rl()) @RequireTenantPermission('autopublish.manage') plan(@Tenant() t: TenantContext, @Body() b: unknown) { return this.planner.plan(t, parse(planBody, b)); }
  @Post('entries/:entryId/process') @HttpCode(200) @Throttle(rl()) @RequireTenantPermission('autopublish.manage') process(@Tenant() t: TenantContext, @Param('entryId') e: string) { return this.automation.process(t, e); }

  @Get('reviews') @RequireTenantPermission('autopublish.read')
  async reviews(@Tenant() t: TenantContext) {
    const rows = await this.prisma.publishingDecision.findMany({ where: { businessId: t.businessId, action: { in: ['SENT_TO_REVIEW', 'AWAITING_PLATFORM_CONFIRMATION'] } }, orderBy: { createdAt: 'asc' }, take: 100 });
    return this.withEntries(t.businessId, rows);
  }
  @Post('entries/:entryId/approve') @HttpCode(200) @Throttle(rl()) @RequireTenantPermission('publication.schedule') approve(@Tenant() t: TenantContext, @Param('entryId') e: string) { return this.automation.approveReview(t, e); }
  @Post('entries/:entryId/reject') @HttpCode(200) @RequireTenantPermission('content.approve') reject(@Tenant() t: TenantContext, @Param('entryId') e: string, @Body() b: unknown) { return this.automation.rejectReview(t, e, parse(rejectBody, b).reason); }

  @Get('schedule') @RequireTenantPermission('autopublish.read')
  async schedule(@Tenant() t: TenantContext, @Query() q: Record<string, string>) {
    const r = parse(range, q);
    const rows = await this.prisma.publishingDecision.findMany({ where: { businessId: t.businessId, ...(r.from || r.to ? { updatedAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lt: r.to } : {}) } } : {}) }, orderBy: { createdAt: 'desc' }, skip: (r.page - 1) * 50, take: 50 });
    return this.withEntries(t.businessId, rows);
  }
  @Get('results') @RequireTenantPermission('autopublish.read')
  async results(@Tenant() t: TenantContext) {
    const rows = await this.prisma.publication.findMany({ where: { businessId: t.businessId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, calendarEventId: true, platform: true, status: true, simulated: true, errorCode: true, publishedAt: true, scheduledAt: true, socialAccountId: true } });
    return rows;
  }
  @Get('history') @RequireTenantPermission('autopublish.read')
  async history(@Tenant() t: TenantContext, @Query() q: Record<string, string>) {
    const r = parse(range, q);
    return this.prisma.publishingEvent.findMany({ where: { businessId: t.businessId }, orderBy: { createdAt: 'desc' }, skip: (r.page - 1) * 100, take: 100 });
  }

  private async withEntries(businessId: string, rows: Array<{ calendarEventId: string; contentVersion: number } & Record<string, unknown>>) {
    const entries = await this.prisma.calendarEvent.findMany({ where: { businessId, id: { in: rows.map((r) => r.calendarEventId) } }, select: { id: true, title: true, platform: true, scheduledAt: true, timezone: true, content: { select: { caption: true, status: true, version: true, type: true } } } });
    return rows.map((r) => ({ ...r, entry: entries.find((e) => e.id === r.calendarEventId) ?? null }));
  }
}
