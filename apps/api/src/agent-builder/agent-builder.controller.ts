import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards, CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AppEnv, InjectEnv } from '../config';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { AgentBuilderService } from './agent-builder.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
/** Feature flag: the builder endpoints do not exist (404) unless AGENT_BUILDER_ENABLED=true. */
@Injectable()
export class AgentBuilderEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}
  canActivate(): boolean { if (!this.env.AGENT_BUILDER_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' }); return true; }
}
// The definition is parsed leniently on purpose (a draft may be incomplete); the server normalizes and validates it. Only the size is bounded here.
const definition = z.record(z.unknown()).refine((v) => JSON.stringify(v).length <= 20_000, 'definition too large');
const testBody = z.object({ input: z.string().trim().min(1).max(1000) }).strict();
const id = z.string().min(1).max(40);
const rl = () => ({ default: { limit: Number(process.env.AGENT_BUILDER_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/** No-code agent builder (N23, first slice). Reading needs `agents.read`, saving/duplicating/archiving `agents.manage`, simulated tests `agents.run`. */
@ApiTags('agent-builder')
@ApiBearerAuth()
@UseGuards(AgentBuilderEnabledGuard)
@Controller('agent-builder')
export class AgentBuilderController {
  constructor(private readonly svc: AgentBuilderService) {}
  @Get('options') @RequireTenantPermission('agents.read') options() { return this.svc.options(); }
  @Get('agents') @RequireTenantPermission('agents.read') list(@Tenant() t: TenantContext) { return this.svc.list(t); }
  @Post('validate') @HttpCode(200) @RequireTenantPermission('agents.read') validate(@Tenant() t: TenantContext, @Body() b: unknown) { return this.svc.validate(t, parse(definition, b)); }
  @Post('agents') @HttpCode(201) @Throttle(rl()) @RequireTenantPermission('agents.manage') create(@Tenant() t: TenantContext, @Body() b: unknown) { return this.svc.create(t, parse(definition, b)); }
  @Get('agents/:id') @RequireTenantPermission('agents.read') get(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.get(t, parse(id, i)); }
  @Put('agents/:id') @Throttle(rl()) @RequireTenantPermission('agents.manage') update(@Tenant() t: TenantContext, @Param('id') i: string, @Body() b: unknown) { return this.svc.update(t, parse(id, i), parse(definition, b)); }
  @Post('agents/:id/duplicate') @HttpCode(201) @RequireTenantPermission('agents.manage') duplicate(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.duplicate(t, parse(id, i)); }
  @Delete('agents/:id') @RequireTenantPermission('agents.manage') archive(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.archive(t, parse(id, i)); }
  @Post('agents/:id/test') @HttpCode(200) @Throttle(rl()) @RequireTenantPermission('agents.run') test(@Tenant() t: TenantContext, @Param('id') i: string, @Body() b: unknown) { return this.svc.test(t, parse(id, i), parse(testBody, b).input); }
  @Get('agents/:id/tests') @RequireTenantPermission('agents.read') tests(@Tenant() t: TenantContext, @Param('id') i: string) { return this.svc.tests(t, parse(id, i)); }
}
