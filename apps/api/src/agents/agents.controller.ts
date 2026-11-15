import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AGENT_TYPES } from '@touma/shared';
import { RequireFeature } from '../billing/plan-feature';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { AgentGuardian } from './agent-guardian.service';
import { AgentsEnabledGuard } from './agents.guard';
import { AgentsService } from './agents.service';
import { ApprovalsService } from './approvals.service';
import { ConversationStore } from './conversation.store';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const name = z.string().trim().min(2).max(60);
const createBody = z.object({ type: z.enum(AGENT_TYPES), name, config: z.record(z.unknown()).optional() }).strict();
const updateBody = z.object({ name: name.optional(), config: z.record(z.unknown()).optional() }).strict();
const taskBody = z.object({
  template: z.string().max(60), topic: z.string().max(200).optional(), question: z.string().max(200).optional(), channel: z.string().max(20).optional(), priority: z.number().int().min(3).max(9).optional(),
  agents: z.record(z.enum(AGENT_TYPES), z.string().max(40)).optional(),
}).strict();
const page = z.object({ state: z.enum(['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED']).optional(), page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
const approveBody = z.object({ contentHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const modifyBody = z.object({ title: z.string().trim().min(1).max(120).optional(), body: z.string().trim().min(1).max(2200).optional(), hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u)).max(10).optional() }).strict();
const micros = z.number().int().min(0).max(1_000_000_000_000).nullable().optional();
const budgetBody = z.object({ dailyCapMicros: micros, monthlyCapMicros: micros, perRunCapMicros: micros, alertPercent: z.number().int().min(1).max(100).optional(), enforce: z.boolean().optional() }).strict();
const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

const limit = () => ({ default: { limit: Number(process.env.AGENTS_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/**
 * AI agents of a business (N28). Off by default (404). Reading needs `agents.read`, running tasks `agents.run`, configuring agents and budgets `agents.manage`, and
 * approving what an agent prepared for publication `agents.approve`. The business always comes from the verified tenant context, never from the request.
 */
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(AgentsEnabledGuard)
@RequireFeature('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly svc: AgentsService, private readonly approvals: ApprovalsService, private readonly guardian: AgentGuardian, private readonly conversations: ConversationStore) {}

  @Get('catalog') @RequireTenantPermission('agents.read') catalog(@Tenant() t: TenantContext) { return this.svc.catalog(t); }

  @Get() @RequireTenantPermission('agents.read') list(@Tenant() t: TenantContext) { return this.svc.list(t); }

  @Post() @HttpCode(201) @Throttle(limit()) @RequireTenantPermission('agents.manage')
  create(@Tenant() t: TenantContext, @Body() body: unknown) { return this.svc.create(t, parse(createBody, body) as never); }

  @Patch(':id') @RequireTenantPermission('agents.manage')
  update(@Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) { return this.svc.update(t, id, parse(updateBody, body)); }

  @Post(':id/enable') @HttpCode(200) @RequireTenantPermission('agents.manage') enable(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.setEnabled(t, id, true); }
  @Post(':id/disable') @HttpCode(200) @RequireTenantPermission('agents.manage') disable(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.setEnabled(t, id, false); }

  // Tasks
  @Post('tasks') @HttpCode(202) @Throttle(limit()) @RequireTenantPermission('agents.run')
  @ApiOperation({ summary: 'Create a task (CREATED, then QUEUED after the billing guardian admits it). Idempotency-Key makes a retry safe.' })
  async createTask(@Tenant() t: TenantContext, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return this.svc.createTask(t, parse(taskBody, body) as never, key && key.length <= 100 ? key : randomUUID());
  }
  @Get('tasks') @RequireTenantPermission('agents.read') tasks(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { return this.svc.listTasks(t, parse(page, q)); }
  @Get('tasks/:id') @RequireTenantPermission('agents.read') task(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.task(t, id); }
  @Get('tasks/:id/conversations') @RequireTenantPermission('agents.read') conversationsOf(@Tenant() t: TenantContext, @Param('id') id: string) { return this.conversations.forRun(t.businessId, id); }
  @Post('tasks/:id/cancel') @HttpCode(200) @RequireTenantPermission('agents.run') cancel(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.cancel(t, id); }
  @Post('tasks/:id/retry') @HttpCode(200) @RequireTenantPermission('agents.run') retry(@Tenant() t: TenantContext, @Param('id') id: string) { return this.svc.retry(t, id); }

  // Approval queue
  @Get('approvals') @RequireTenantPermission('agents.read') listApprovals(@Tenant() t: TenantContext, @Query('status') status?: string) { return this.approvals.list(t, status); }
  @Get('approvals/:id') @RequireTenantPermission('agents.read') approval(@Tenant() t: TenantContext, @Param('id') id: string) { return this.approvals.get(t, id); }
  @Post('approvals/:id/approve') @HttpCode(200) @Throttle(limit()) @RequireTenantPermission('agents.approve')
  approve(@Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) { return this.approvals.approve(t, id, parse(approveBody, body).contentHash); }
  @Post('approvals/:id/reject') @HttpCode(200) @RequireTenantPermission('agents.approve') reject(@Tenant() t: TenantContext, @Param('id') id: string) { return this.approvals.reject(t, id); }
  @Post('approvals/:id/modify') @HttpCode(200) @RequireTenantPermission('agents.approve')
  modify(@Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) { return this.approvals.modify(t, id, parse(modifyBody, body)); }

  // Usage and budget
  @Get('usage') @RequireTenantPermission('agents.read') usage(@Tenant() t: TenantContext) { return this.guardian.summary(t.businessId); }
  @Get('usage/report') @RequireTenantPermission('agents.read')
  report(@Tenant() t: TenantContext, @Query() q: Record<string, string>) {
    const r = parse(range, q);
    const to = r.to ?? new Date(); const from = r.from ?? new Date(to.getTime() - 30 * 86_400_000);
    return this.guardian.report(t.businessId, from, to);
  }
  @Get('budget') @RequireTenantPermission('agents.read') budget(@Tenant() t: TenantContext) { return this.svc.budget(t); }
  @Put('budget') @RequireTenantPermission('agents.manage') setBudget(@Tenant() t: TenantContext, @Body() body: unknown) { return this.svc.setBudget(t, parse(budgetBody, body)); }
}
