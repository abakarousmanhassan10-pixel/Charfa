import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AiLanguage, AiTone, VideoFormat, VideoStyle } from '@touma/shared';
import { BadRequestException } from '@nestjs/common';
import { GenerationQueryDto } from '../ai/ai.dto';
import { AiHistoryService, generationDto } from '../ai/ai-history.service';
import { AiOrchestratorService } from '../ai/orchestrator.service';
import { VIDEO_FORMATS } from '@touma/shared';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { UpdateBrandKitDto } from './brand-kit.dto';
import { BrandKitService } from './brand-kit.service';
import { CreateImageDto, CreateStoryboardDto, CreateVideoDto, CreativeQueryDto, SelectOutputDto, VariationDto } from './creative.dto';
import { CreativeService } from './creative.service';

/** Per-client limit on generation endpoints: every call may cost real money. */
const creativeThrottle = () => ({ default: { limit: Number(process.env.CREATIVE_RATE_LIMIT_PER_MINUTE ?? 10), ttl: 60_000 } });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

function idempotencyKey(raw?: string) {
  if (raw === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(raw)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_INVALID', message: 'Idempotency-Key must be 8-64 characters: letters, digits, "_" or "-"' });
  return raw;
}

@ApiTags('creative')
@ApiBearerAuth()
@Controller('creative')
export class CreativeController {
  constructor(
    private readonly creative: CreativeService,
    private readonly brandKit: BrandKitService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly history: AiHistoryService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Providers and capabilities, options, monthly usage and storage (no credentials)' })
  @RequireTenantPermission('content.read')
  status(@Tenant() tenant: TenantContext) {
    return this.creative.overview(tenant);
  }

  // ─── Brand kit ──────────────────────────────────────────────────────────────

  @Get('brand-kit')
  @RequireTenantPermission('content.read')
  getBrandKit(@Tenant() tenant: TenantContext) {
    return this.brandKit.get(tenant);
  }

  @Put('brand-kit')
  @ApiOperation({ summary: 'Update the brand kit: fields that are sent are updated, null clears one' })
  @RequireTenantPermission('business.update')
  updateBrandKit(@Tenant() tenant: TenantContext, @Body() dto: UpdateBrandKitDto) {
    return this.brandKit.update(tenant, dto);
  }

  // ─── Storyboards (TOUMA AI text pipeline) ───────────────────────────────────

  @Post('storyboards')
  @HttpCode(202)
  @Throttle(creativeThrottle())
  @ApiOperation({ summary: 'Queue a video script and storyboard (same background pipeline, grounding and limits as other TOUMA AI text)' })
  @RequireTenantPermission('ai.use')
  async storyboard(@Tenant() tenant: TenantContext, @Body() dto: CreateStoryboardDto) {
    const rule = VIDEO_FORMATS[dto.format as VideoFormat];
    if (dto.seconds < rule.minSeconds || dto.seconds > rule.maxSeconds) throw new BadRequestException({ code: 'VIDEO_LENGTH_INVALID', message: `${dto.format} videos are ${rule.minSeconds}-${rule.maxSeconds} seconds` });
    const g = await this.orchestrator.submit(tenant, {
      task: 'STORYBOARD', language: dto.language as AiLanguage, format: dto.format as VideoFormat, seconds: dto.seconds, style: dto.style as VideoStyle, tone: dto.tone as AiTone,
      item: dto.itemType && dto.itemId ? { type: dto.itemType, id: dto.itemId } : null, instructions: dto.instructions,
    });
    return { ...generationDto(g), statusUrl: `/api/v1/ai/generations/${g.id}/status` };
  }

  @Get('storyboards')
  @RequireTenantPermission('content.read')
  storyboards(@Tenant() tenant: TenantContext, @Query() q: GenerationQueryDto) {
    return this.history.list(tenant, { ...q, task: 'STORYBOARD' });
  }

  // ─── Images and videos ──────────────────────────────────────────────────────

  @Post('images')
  @HttpCode(202)
  @Throttle(creativeThrottle())
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Repeating a request with the same key returns the same generation instead of creating (and charging) another' })
  @ApiOperation({ summary: 'Queue AI image generation. Returns 202; poll /creative/generations/:id/status.' })
  @RequireTenantPermission('ai.use')
  async createImage(@Tenant() tenant: TenantContext, @Body() dto: CreateImageDto, @Headers('idempotency-key') key?: string) {
    const r = await this.creative.submitImage(tenant, dto, idempotencyKey(key));
    return { ...this.creative.toDto(r.generation), replayed: r.replayed, statusUrl: `/api/v1/creative/generations/${r.generation.id}/status` };
  }

  @Post('videos')
  @HttpCode(202)
  @Throttle(creativeThrottle())
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Queue AI video generation. 503 VIDEO_NOT_CONFIGURED when no video provider is configured: nothing is simulated.' })
  @RequireTenantPermission('ai.use')
  async createVideo(@Tenant() tenant: TenantContext, @Body() dto: CreateVideoDto, @Headers('idempotency-key') key?: string) {
    const r = await this.creative.submitVideo(tenant, dto, idempotencyKey(key));
    return { ...this.creative.toDto(r.generation), replayed: r.replayed, statusUrl: `/api/v1/creative/generations/${r.generation.id}/status` };
  }

  @Get('generations')
  @RequireTenantPermission('content.read')
  list(@Tenant() tenant: TenantContext, @Query() q: CreativeQueryDto) {
    return this.creative.list(tenant, q);
  }

  @Get('generations/:id/status')
  @RequireTenantPermission('content.read')
  jobStatus(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.creative.status(tenant, id);
  }

  @Get('generations/:id')
  @RequireTenantPermission('content.read')
  async get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.creative.toDto(await this.creative.find(tenant, id));
  }

  @Post('generations/:id/variations')
  @HttpCode(202)
  @Throttle(creativeThrottle())
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @RequireTenantPermission('ai.use')
  async variations(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: VariationDto, @Headers('idempotency-key') key?: string) {
    const r = await this.creative.variations(tenant, id, dto, idempotencyKey(key));
    return { ...this.creative.toDto(r.generation), replayed: r.replayed, statusUrl: `/api/v1/creative/generations/${r.generation.id}/status` };
  }

  @Delete('generations/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a finished generation and its files' })
  @RequireTenantPermission('media.write')
  remove(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.creative.remove(tenant, id);
  }

  @Patch('outputs/:id')
  @ApiOperation({ summary: 'Mark (or unmark) the favourite variation of a generation' })
  @RequireTenantPermission('content.write')
  select(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: SelectOutputDto) {
    return this.creative.select(tenant, id, dto.selected);
  }
}
