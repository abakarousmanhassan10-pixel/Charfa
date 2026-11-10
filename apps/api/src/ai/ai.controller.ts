import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AI_CONTENT_PURPOSES, AI_FORMATS, AI_LANGUAGES, AI_TONES, FORMAT_RULES, FORMATS_BY_PLATFORM, type AiContentPurpose, type AiFormat, type AiLanguage, type AiPlatform, type AiTone } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { BusinessAnalysisDto, ContentDto, GenerationQueryDto, ProductAnalysisDto, RegenerateDto, SaveDraftDto, StrategyDto, UsageQueryDto } from './ai.dto';
import { AiHistoryService, generationDto } from './ai-history.service';
import { AiUsageService } from './ai-usage.service';
import { AiOrchestratorService } from './orchestrator.service';

/** Per-client limit on generation endpoints (each call may cost provider tokens). */
const aiThrottle = () => ({ default: { limit: Number(process.env.AI_RATE_LIMIT_PER_MINUTE ?? 10), ttl: 60_000 } });

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly history: AiHistoryService,
    private readonly usage: AiUsageService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Provider configuration (no secrets), limits and month-to-date usage' })
  @RequireTenantPermission('content.read')
  async status(@Tenant() tenant: TenantContext) {
    return {
      configured: this.orchestrator.configured,
      provider: this.env.AI_PROVIDER,
      model: this.env.AI_MODEL,
      temperature: this.env.AI_TEMPERATURE ?? 'agent-default',
      maxOutputTokens: this.env.AI_MAX_OUTPUT_TOKENS,
      costTracking: this.usage.costConfigured,
      usage: await this.usage.monthToDate(tenant.businessId),
      options: { languages: AI_LANGUAGES, tones: AI_TONES, purposes: AI_CONTENT_PURPOSES, formats: AI_FORMATS, formatsByPlatform: FORMATS_BY_PLATFORM, formatRules: FORMAT_RULES },
    };
  }

  @Post('business-analysis')
  @Throttle(aiThrottle())
  @RequireTenantPermission('ai.use')
  async businessAnalysis(@Tenant() tenant: TenantContext, @Body() dto: BusinessAnalysisDto) {
    const r = await this.orchestrator.businessAnalysis(tenant, { language: dto.language as AiLanguage, instructions: dto.instructions });
    return generationDto(r.generation, r.steps);
  }

  @Post('product-analysis')
  @Throttle(aiThrottle())
  @RequireTenantPermission('ai.use')
  async productAnalysis(@Tenant() tenant: TenantContext, @Body() dto: ProductAnalysisDto) {
    const r = await this.orchestrator.productAnalysis(tenant, { language: dto.language as AiLanguage, item: { type: dto.itemType, id: dto.itemId }, instructions: dto.instructions });
    return generationDto(r.generation, r.steps);
  }

  @Post('marketing-strategy')
  @Throttle(aiThrottle())
  @RequireTenantPermission('ai.use')
  async strategy(@Tenant() tenant: TenantContext, @Body() dto: StrategyDto) {
    const r = await this.orchestrator.strategy(tenant, {
      language: dto.language as AiLanguage,
      platforms: dto.platforms as AiPlatform[],
      goal: dto.goal,
      focusItemIds: dto.focusItemIds,
      instructions: dto.instructions,
    });
    return generationDto(r.generation, r.steps);
  }

  @Post('content')
  @Throttle(aiThrottle())
  @RequireTenantPermission('ai.use')
  async content(@Tenant() tenant: TenantContext, @Body() dto: ContentDto) {
    const r = await this.orchestrator.content(tenant, {
      language: dto.language as AiLanguage,
      format: dto.format as AiFormat,
      purpose: dto.purpose as AiContentPurpose,
      tone: dto.tone as AiTone,
      item: dto.itemType && dto.itemId ? { type: dto.itemType, id: dto.itemId } : null,
      instructions: dto.instructions,
    });
    return generationDto(r.generation, r.steps);
  }

  @Get('generations')
  @RequireTenantPermission('content.read')
  list(@Tenant() tenant: TenantContext, @Query() q: GenerationQueryDto) {
    return this.history.list(tenant, q);
  }

  @Get('generations/latest/:task')
  @RequireTenantPermission('content.read')
  @ApiOperation({ summary: 'Latest successful analysis or strategy; { generation: null } when there is none' })
  async latest(@Tenant() tenant: TenantContext, @Param('task') task: string, @Query('itemId') itemId?: string) {
    const t = ({ 'business-analysis': 'BUSINESS_ANALYSIS', 'product-analysis': 'PRODUCT_ANALYSIS', 'marketing-strategy': 'MARKETING_STRATEGY' } as const)[task as 'business-analysis'];
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown task' });
    return { generation: await this.history.latest(tenant, t, typeof itemId === 'string' && /^[a-z0-9]{20,40}$/.test(itemId) ? itemId : undefined) };
  }

  @Get('generations/:id')
  @RequireTenantPermission('content.read')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.history.get(tenant, id);
  }

  @Post('generations/:id/regenerate')
  @Throttle(aiThrottle())
  @RequireTenantPermission('ai.use')
  async regenerate(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: RegenerateDto) {
    const r = await this.orchestrator.regenerate(tenant, id, dto.instructions);
    return generationDto(r.generation, r.steps);
  }

  @Post('generations/:id/draft')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save content as a DRAFT (optionally with human edits). Never publishes.' })
  @RequireTenantPermission('content.write')
  saveDraft(@Tenant() tenant: TenantContext, @Param('id') id: string, @Body() dto: SaveDraftDto) {
    return this.history.saveDraft(tenant, id, dto.output);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Token consumption report (measured provider usage; cost from configured prices)' })
  @RequireTenantPermission('content.read')
  report(@Tenant() tenant: TenantContext, @Query() q: UsageQueryDto) {
    return this.usage.report(tenant.businessId, q.days);
  }
}
