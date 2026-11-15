import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreativeCampaignsService, type CampaignInput } from './creative-campaigns.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const text = (max: number) => z.string().trim().min(1).max(max);
const createBody = z.object({
  name: text(80), subject: text(200), objective: text(300), audience: text(300),
  platform: z.enum(['INSTAGRAM', 'TIKTOK', 'YOUTUBE']), language: z.enum(['en', 'fr']).default('en'),
  brand: z.object({ tone: z.string().max(60).optional(), colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(5).optional(), style: z.string().max(30).optional(), tagline: z.string().max(100).optional() }).strict().default({}),
  // 5 per day is the daily quota of each kind: a campaign cannot ask for more than a day can deliver.
  photoCount: z.number().int().min(0).max(5), videoCount: z.number().int().min(0).max(5),
  startAt: z.string().max(40), intervalHours: z.number().int().min(1).max(168).default(24), publishMode: z.enum(['AUTO', 'HYBRID']),
}).strict();
const approveBody = z.object({ contentHash: z.string().length(64) }).strict();
const editBody = z.object({ caption: text(2200).optional(), scheduledAt: z.string().max(40).optional() }).strict().refine((b) => b.caption !== undefined || b.scheduledAt !== undefined, 'nothing to change');
const dueBody = z.object({ asOf: z.string().max(40).optional() }).strict();
const id = z.string().min(1).max(40);

/** Automated creative campaigns (free test mode). Reading needs `content.read`; building needs `ai.use`; approving `content.approve`; stopping and resuming `autopublish.manage`. */
@ApiTags('creative')
@ApiBearerAuth()
@Controller('creative/campaigns')
export class CreativeCampaignsController {
  constructor(private readonly svc: CreativeCampaignsService) {}

  @Get('overview') @RequireTenantPermission('content.read') overview(@Tenant() t: TenantContext) { return this.svc.overview(t); }
  @Post('emergency-stop') @HttpCode(200) @RequireTenantPermission('autopublish.manage') stopAll(@Tenant() t: TenantContext) { return this.svc.emergencyStop(t); }
  @Get() @RequireTenantPermission('content.read') list(@Tenant() t: TenantContext) { return this.svc.list(t); }

  @Post() @RequireTenantPermission('ai.use')
  async create(@Tenant() t: TenantContext, @Body() b: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.create(t, parse(createBody, b) as CampaignInput, key?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || randomUUID());
    res.status(r.replayed ? 200 : 201);
    return { ...r.campaign, replayed: r.replayed };
  }
  @Get(':id') @RequireTenantPermission('content.read') get(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.get(t, parse(id, i)); }
  @Post(':id/start') @HttpCode(202) @RequireTenantPermission('ai.use') start(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.start(t, parse(id, i)); }
  @Post(':id/retry') @HttpCode(202) @RequireTenantPermission('ai.use') retry(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.retry(t, parse(id, i)); }
  @Post(':id/cancel') @HttpCode(200) @RequireTenantPermission('ai.use') cancel(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.cancel(t, parse(id, i)); }
  @Post(':id/emergency-stop') @HttpCode(200) @RequireTenantPermission('autopublish.manage') stop(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.emergencyStop(t, parse(id, i)); }
  @Post(':id/resume') @HttpCode(202) @RequireTenantPermission('autopublish.manage') resume(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.resume(t, parse(id, i)); }
  @Post(':id/simulate-due') @HttpCode(200) @RequireTenantPermission('publication.schedule') due(@Tenant() t: TenantContext, @Param('id') i: string, @Body() b: unknown) { return this.svc.simulateDue(t, parse(id, i), parse(dueBody, b ?? {}).asOf); }
  @Post(':id/posts/:postId/approve') @HttpCode(200) @RequireTenantPermission('content.approve') approve(@Tenant() t: TenantContext, @Param('id') i: string, @Param('postId') p: string, @Body() b: unknown) { return this.svc.approve(t, parse(id, i), parse(id, p), parse(approveBody, b).contentHash); }
  @Post(':id/posts/:postId/reject') @HttpCode(200) @RequireTenantPermission('content.approve') reject(@Tenant() t: TenantContext, @Param('id') i: string, @Param('postId') p: string) { return this.svc.reject(t, parse(id, i), parse(id, p)); }
  @Patch(':id/posts/:postId') @RequireTenantPermission('ai.use') edit(@Tenant() t: TenantContext, @Param('id') i: string, @Param('postId') p: string, @Body() b: unknown) { return this.svc.editPost(t, parse(id, i), parse(id, p), parse(editBody, b)); }
}
