import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';
import { AgentsAdminService } from './agents-admin.service';
import { AgentsEnabledGuard } from './agents.guard';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const filter = z.object({ businessId: z.string().max(40).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const stopBody = z.object({ scope: z.enum(['GLOBAL', 'TENANT', 'AGENT']), scopeId: z.string().max(40).default(''), reason: z.string().trim().max(300).nullable().default(null), cancelPending: z.boolean().default(false) }).strict();
const resumeBody = stopBody.omit({ cancelPending: true });
const priceBody = z.object({ modelId: z.string().max(100), inputPerMillionMicros: z.number().int(), outputPerMillionMicros: z.number().int(), cachedInputPerMillionMicros: z.number().int().nullable().optional() }).strict();

/** Admin control center for the AI agents. Platform administrators only; changes (stop, resume, prices) need SUPER_ADMIN. */
@ApiTags('admin-agents')
@ApiBearerAuth()
@UseGuards(AgentsEnabledGuard)
@RequirePlatformRole('SUPER_ADMIN', 'SUPPORT')
@Controller('admin/agents')
export class AgentsAdminController {
  constructor(private readonly svc: AgentsAdminService) {}

  @Get('overview') overview(@Query() q: Record<string, string>) {
    const f = parse(filter, q); const to = f.to ?? new Date();
    return this.svc.overview({ businessId: f.businessId, from: f.from ?? new Date(to.getTime() - 30 * 86_400_000), to });
  }
  @Get('businesses/:id/tasks') tasks(@Param('id') id: string, @Query('state') state?: string) { return this.svc.tasks(id, state); }
  @Get('controls') controls() { return this.svc.controls(); }
  @Get('models') models() { return this.svc.models(); }
  @Get('prices') prices() { return this.svc.prices_(); }

  @RequirePlatformRole('SUPER_ADMIN') @Post('stop') @HttpCode(200)
  stop(@CurrentUser() u: AuthenticatedUser, @Body() body: unknown) { const b = parse(stopBody, body); return this.svc.stop(b.scope, b.scopeId, true, b.reason, u.id, b.cancelPending); }
  @RequirePlatformRole('SUPER_ADMIN') @Post('resume') @HttpCode(200)
  resume(@CurrentUser() u: AuthenticatedUser, @Body() body: unknown) { const b = parse(resumeBody, body); return this.svc.stop(b.scope, b.scopeId, false, b.reason, u.id); }
  @RequirePlatformRole('SUPER_ADMIN') @Post('prices') @HttpCode(201)
  addPrice(@CurrentUser() u: AuthenticatedUser, @Body() body: unknown) { const b = parse(priceBody, body); return this.svc.addPrice(b.modelId, b, u.id); }
}
