import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { CreativeProjectsService } from './creative-projects.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const text = (max: number) => z.string().trim().min(1).max(max);
const brief = z.object({ kind: z.enum(['IMAGE', 'VIDEO']), description: text(1000), aspectRatio: z.enum(['1:1', '4:5', '9:16', '16:9']), style: z.string().min(2).max(30), platform: z.enum(['INSTAGRAM', 'TIKTOK', 'YOUTUBE']).default('INSTAGRAM'), language: z.enum(['en', 'fr']).default('en') }).strict();
const createBody = z.object({ name: text(80), brief }).strict();
const updateBody = z.object({ name: text(80).optional(), brief: brief.optional(), caption: z.string().max(2200).optional() }).strict();
const restoreBody = z.object({ generationId: z.string().min(1).max(40) }).strict();
const scheduleBody = z.object({ platform: z.enum(['INSTAGRAM', 'TIKTOK', 'YOUTUBE']), scheduledAt: z.string().max(40), mode: z.enum(['AUTO', 'HYBRID', 'MANUAL']).optional() }).strict();
const libQuery = z.object({ type: z.enum(['IMAGE', 'VIDEO']).optional(), projectId: z.string().max(40).optional(), page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(24) });
const id = z.string().min(1).max(40);

/** Studio projects, library and the simulated advertising workflow. Reading needs `content.read`; changing needs `ai.use`; fictitious scheduling needs `publication.schedule`. */
@ApiTags('creative')
@ApiBearerAuth()
@Controller('creative')
export class CreativeProjectsController {
  constructor(private readonly svc: CreativeProjectsService) {}
  @Get('projects') @RequireTenantPermission('content.read') list(@Tenant() t: TenantContext) { return this.svc.list(t); }
  @Post('projects') @HttpCode(201) @RequireTenantPermission('ai.use') create(@Tenant() t: TenantContext, @Body() b: unknown) { return this.svc.create(t, parse(createBody, b)); }
  @Get('projects/:id') @RequireTenantPermission('content.read') get(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.get(t, parse(id, i)); }
  @Patch('projects/:id') @RequireTenantPermission('ai.use') update(@Tenant() t: TenantContext, @Param('id') i: string, @Body() b: unknown) { return this.svc.update(t, parse(id, i), parse(updateBody, b)); }
  @Delete('projects/:id') @RequireTenantPermission('ai.use') remove(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.remove(t, parse(id, i)); }
  @Post('projects/:id/script') @HttpCode(200) @RequireTenantPermission('ai.use') script(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.prepareScript(t, parse(id, i)); }
  @Post('projects/:id/restore') @HttpCode(200) @RequireTenantPermission('ai.use') restore(@Tenant() t: TenantContext, @Param('id') i: string, @Body() b: unknown) { return this.svc.restore(t, parse(id, i), parse(restoreBody, b).generationId); }
  @Post('projects/:id/schedule-simulation') @HttpCode(200) @RequireTenantPermission('publication.schedule') schedule(@Tenant() t: TenantContext, @Param('id') i: string, @Body() b: unknown) { return this.svc.scheduleSim(t, parse(id, i), parse(scheduleBody, b)); }
  @Get('library') @RequireTenantPermission('content.read') library(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { return this.svc.library(t, parse(libQuery, q)); }
}
