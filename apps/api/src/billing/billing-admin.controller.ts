import { Body, Controller, Get, HttpCode, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { PROVIDER_APPROVAL_STATUSES } from '@touma/shared';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';
import { BillingAdminService } from './billing-admin.service';
import { BillingEnabledGuard } from './billing.guard';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const approvalBody = z.object({ status: z.enum(PROVIDER_APPROVAL_STATUSES), reference: z.string().max(200).optional(), note: z.string().max(500).optional() }).strict();
const listQuery = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED']).optional(), page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

/** Platform administrators only (SUPER_ADMIN, SUPPORT). Reading changes nothing; recording a provider's decision needs SUPER_ADMIN and never enables real payments. */
@ApiTags('admin-billing')
@ApiBearerAuth()
@RequirePlatformRole('SUPER_ADMIN', 'SUPPORT')
@UseGuards(BillingEnabledGuard)
@Controller('admin/billing')
export class BillingAdminController {
  constructor(private readonly admin: BillingAdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Subscriptions by state, failed payments, SIMULATED revenue, upcoming renewals, incidents, events, provider readiness and approval' })
  overview() { return this.admin.overview(); }

  @Get('subscriptions')
  @ApiOperation({ summary: 'Subscriptions to review (filter by status)' })
  subscriptions(@Query() q: Record<string, string>) { return this.admin.subscriptions(parse(listQuery, q)); }

  @Get('incidents')
  @ApiOperation({ summary: 'Provider outages, amount mismatches, duplicate or stale events, failed notifications (30 days)' })
  incidents() { return this.admin.incidents(); }

  @Get('providers')
  @ApiOperation({ summary: 'Payment providers: verified capabilities, the provider\'s approval of TOUMA\'s activities, and why real payments are blocked' })
  providers() { return this.admin.providers(); }

  @Put('providers/:provider/approval')
  @HttpCode(200)
  @RequirePlatformRole('SUPER_ADMIN')
  @ApiOperation({ summary: 'Record the provider\'s own decision about TOUMA (needs the reference of its written decision for APPROVED). Never enables real payments.' })
  approval(@Param('provider') provider: string, @Body() body: unknown, @CurrentUser() u: AuthenticatedUser) { return this.admin.setApproval(provider, parse(approvalBody, body), u.id); }
}
