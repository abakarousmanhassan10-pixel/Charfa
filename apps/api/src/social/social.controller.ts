import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { SOCIAL_PLATFORMS, type SocialPlatformId } from '@touma/shared';
import { Public } from '../common/decorators/current-user.decorator';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { AnalyticsQueryDto, ManualCompleteDto, PublicationsQueryDto, RetryPublicationDto, SelectAccountsDto, StartConnectionDto } from './social.dto';
import { SocialAccountsService } from './social-accounts.service';
import { SocialAnalyticsService } from './social-analytics.service';
import { SocialPublisherService } from './social-publisher.service';
import { SOCIAL_WORKER_HEARTBEAT_KEY } from './social-queue';

const socialThrottle = () => ({ default: { limit: Number(process.env.SOCIAL_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/** Platform path parameter ("instagram", "FACEBOOK"...). */
function platformOf(raw: string): SocialPlatformId {
  const p = raw.toUpperCase();
  if (!(SOCIAL_PLATFORMS as readonly string[]).includes(p)) throw new NotFoundException({ code: 'PLATFORM_NOT_FOUND', message: 'Unknown platform' });
  return p as SocialPlatformId;
}

@ApiTags('social')
@ApiBearerAuth()
@Controller('social')
export class SocialController {
  constructor(
    private readonly accounts: SocialAccountsService,
    private readonly publisher: SocialPublisherService,
    private readonly analytics: SocialAnalyticsService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Which platforms the server can connect (names of missing settings only, never values), publishing availability and the queue' })
  @RequireTenantPermission('social.read')
  async status(@Tenant() tenant: TenantContext) {
    const queue = await this.publisher.queueOverview(tenant);
    return { platforms: this.accounts.platforms(), publishing: { available: this.publisher.available() }, queue: queue.queue, inFlight: queue.inFlight, heartbeatKey: SOCIAL_WORKER_HEARTBEAT_KEY };
  }

  // ─── Accounts ───────────────────────────────────────────────────────────────

  @Get('accounts')
  @ApiOperation({ summary: 'Connected accounts of this business. Tokens are never included' })
  @RequireTenantPermission('social.read')
  list(@Tenant() tenant: TenantContext) {
    return this.accounts.list(tenant);
  }

  @Get('accounts/:id/tiktok/creator-info')
  @ApiOperation({ summary: "TikTok creator information for the posting screen: nickname, visibility options, disabled interactions, maximum video duration. Queried live from TikTok" })
  @RequireTenantPermission('content.write')
  tiktokCreatorInfo(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.accounts.tiktokCreatorInfo(tenant.businessId, id);
  }

  @Get('accounts/:id')
  @RequireTenantPermission('social.read')
  async get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.accounts.dto(await this.accounts.get(tenant, id));
  }

  @Post('accounts/:id/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Renew the access token now (platforms that allow it)' })
  @RequireTenantPermission('social.manage')
  async refresh(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    const a = await this.accounts.get(tenant, id);
    return this.accounts.dto(await this.accounts.refresh(a));
  }

  @Post('accounts/:id/disconnect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke access at the platform (best effort) and wipe the stored tokens' })
  @RequireTenantPermission('social.manage')
  disconnect(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.accounts.disconnect(tenant, id);
  }

  // ─── OAuth connection ───────────────────────────────────────────────────────

  @Post('connections/:platform/start')
  @HttpCode(200)
  @Throttle(socialThrottle())
  @ApiOperation({ summary: 'Start an OAuth 2.0 connection (or a reconnection). Send the browser to authorizationUrl' })
  @RequireTenantPermission('social.manage')
  start(@Tenant() tenant: TenantContext, @Param('platform') platform: string, @Body() dto: StartConnectionDto) {
    return this.accounts.start(tenant, platformOf(platform), dto.reconnectAccountId, dto.variant);
  }

  /** The platform sends the browser back here. Public by nature: the single-use state proves who started the connection. */
  @Public()
  @Get('oauth/callback/:platform')
  @Throttle(socialThrottle())
  async callback(@Param('platform') platform: string, @Query() q: { code?: string; state?: string; error?: string; error_description?: string }, @Res() res: Response) {
    const url = await this.accounts.callback(platformOf(platform), { code: q.code, state: q.state, error: q.error, error_description: q.error_description });
    res.redirect(302, url);
  }

  @Get('connections/:id')
  @ApiOperation({ summary: 'The accounts the platform offered, waiting for the person to choose' })
  @RequireTenantPermission('social.manage')
  pending(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.accounts.pending(tenant, id);
  }

  @Post('connections/:id/select')
  @HttpCode(200)
  @ApiOperation({ summary: 'Connect the chosen accounts' })
  @RequireTenantPermission('social.manage')
  select(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: SelectAccountsDto) {
    return this.accounts.select(tenant, id, dto.externalAccountIds);
  }

  @Delete('connections/:id')
  @RequireTenantPermission('social.manage')
  cancel(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.accounts.cancelPending(tenant, id);
  }

  // ─── Publications ───────────────────────────────────────────────────────────

  @Get('publications')
  @ApiOperation({ summary: 'Publication history with status, platform ids, links and error messages' })
  @RequireTenantPermission('social.read')
  publications(@Tenant() tenant: TenantContext, @Query() q: PublicationsQueryDto) {
    return this.publisher.list(tenant, q);
  }

  @Get('queue')
  @ApiOperation({ summary: 'In-flight publications, upcoming scheduled entries and queue counters' })
  @RequireTenantPermission('social.read')
  async queue(@Tenant() tenant: TenantContext, @Query() q: PublicationsQueryDto) {
    const [overview, inFlight] = await Promise.all([this.publisher.queueOverview(tenant), this.publisher.list(tenant, { ...q, scope: 'queue' })]);
    return { ...overview, items: inFlight.items };
  }

  @Get('publications/:id')
  @RequireTenantPermission('social.read')
  publication(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.publisher.get(tenant, id);
  }

  @Post('publications/:id/reconcile')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ask the platform whether a post with an unknown outcome exists. Found = recorded as published (confirmed by the platform); otherwise a person decides' })
  @RequireTenantPermission('publication.schedule')
  reconcile(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.publisher.reconcile(id, { userId: tenant.userId, businessId: tenant.businessId });
  }

  @Post('publications/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a failed publication. When its outcome is unknown, confirm you checked the platform' })
  @RequireTenantPermission('publication.schedule')
  retry(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: RetryPublicationDto) {
    return this.publisher.retry(tenant, id, dto.confirmNotPublished === true);
  }

  @Post('publications/:id/manual-complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record that you published it yourself (manual fallback). It is never shown as confirmed by the platform' })
  @RequireTenantPermission('publication.schedule')
  manual(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: ManualCompleteDto) {
    if (dto.confirmPublished !== true) throw new NotFoundException({ code: 'CONFIRMATION_REQUIRED', message: 'Confirm that the post was published' });
    return this.publisher.manualComplete(tenant, id, dto.externalUrl);
  }

  // ─── Analytics ──────────────────────────────────────────────────────────────

  @Get('analytics/summary')
  @ApiOperation({ summary: 'Totals over measured posts. null = unavailable from the platform, 0 = reported zero' })
  @RequireTenantPermission('analytics.read')
  summary(@Tenant() tenant: TenantContext, @Query() q: AnalyticsQueryDto) {
    return this.analytics.summary(tenant, q);
  }

  @Get('analytics/publications/:id')
  @RequireTenantPermission('analytics.read')
  forPublication(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.analytics.forPublication(tenant, id);
  }

  @Post('analytics/publications/:id/refresh')
  @HttpCode(200)
  @Throttle(socialThrottle())
  @RequireTenantPermission('social.manage')
  refreshMetrics(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.analytics.refresh(tenant, id);
  }
}

