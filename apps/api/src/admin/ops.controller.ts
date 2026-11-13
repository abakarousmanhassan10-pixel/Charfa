import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { requestMeta } from '../common/request-meta';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';
import { OPS_QUEUE_NAMES, OpsService } from './ops.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}

const page = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
const queueName = z.string().refine((q) => OPS_QUEUE_NAMES.includes(q), 'unknown queue');
const ruleBody = z.object({ queue: queueName.nullable().default(null), threshold: z.number().int().min(1).max(100_000), enabled: z.boolean().default(true) }).strict();
const resolveBody = z.object({ note: z.string().max(300).optional() }).strict();

/**
 * Operations control center API (Phase N6). Platform administrators only (SUPER_ADMIN, SUPPORT); changing rules, taking
 * a sample and handling alerts need SUPER_ADMIN. Platform-level telemetry: no tenant data is exposed here.
 */
@ApiTags('admin-ops')
@ApiBearerAuth()
@RequirePlatformRole('SUPER_ADMIN', 'SUPPORT')
@Controller('admin/ops')
export class OpsController {
  constructor(private readonly ops: OpsService, private readonly audit: AuditService) {}

  @Get('overview')
  async overview() {
    const [snapshot, alerts] = await Promise.all([this.ops.snapshot(), this.ops.alerts({ status: 'OPEN', page: 1, pageSize: 20 })]);
    return { ...snapshot, openAlerts: alerts.total };
  }

  @Get('queues/history')
  history(@Query() q: Record<string, string>) {
    const p = parse(page.extend({ queue: queueName.optional(), hours: z.coerce.number().int().min(1).max(168).default(24) }), q);
    return this.ops.history(p);
  }

  @RequirePlatformRole('SUPER_ADMIN')
  @Post('collect')
  async collect(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const out = await this.ops.collect({ force: true });
    await this.audit.record({ action: 'admin.ops_collect', actorId: user.id, ...requestMeta(req) });
    return out;
  }

  @Get('alert-rules')
  rules() {
    return this.ops.rules().then((items) => ({ items, queues: OPS_QUEUE_NAMES }));
  }

  @RequirePlatformRole('SUPER_ADMIN')
  @Put('alert-rules')
  async setRule(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const b = parse(ruleBody, body);
    const rule = await this.ops.setRule(b, user.id);
    await this.audit.record({ action: 'admin.ops_rule_set', actorId: user.id, entityType: 'OpsAlertRule', entityId: rule.id, metadata: { queue: rule.queue, threshold: rule.threshold, enabled: rule.enabled }, ...requestMeta(req) });
    return rule;
  }

  @Get('alerts')
  alerts(@Query() q: Record<string, string>) {
    return this.ops.alerts(parse(page.extend({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional() }), q));
  }

  @RequirePlatformRole('SUPER_ADMIN')
  @Post('alerts/:id/acknowledge')
  async acknowledge(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const a = await this.ops.acknowledge(id, user.id);
    await this.audit.record({ action: 'admin.ops_alert_ack', actorId: user.id, entityType: 'OpsAlert', entityId: id, ...requestMeta(req) });
    return a;
  }

  @RequirePlatformRole('SUPER_ADMIN')
  @Post('alerts/:id/resolve')
  async resolve(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    const b = parse(resolveBody, body ?? {});
    const a = await this.ops.resolve(id, user.id, b.note);
    await this.audit.record({ action: 'admin.ops_alert_resolve', actorId: user.id, entityType: 'OpsAlert', entityId: id, ...requestMeta(req) });
    return a;
  }
}
