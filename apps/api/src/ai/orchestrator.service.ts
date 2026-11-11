import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type AIGeneration, type AITask } from '@touma/database';
import {
  AgentRunError, businessAnalyst, contentCreator, contextHash, detectInjection, collectStrings, marketingStrategist, OutputValidationError,
  productAnalyst, ProviderError, ProviderNotConfiguredError, runAgent,
  type AgentDefinition, type BusinessAnalysis, type BusinessContext, type ContentInput, type EngineConfig, type MarketingStrategy,
  type ProductAnalysis, type TextModelProvider,
} from '@touma/ai-engine';
import { FORMAT_RULES, type AiContentPurpose, type AiFormat, type AiLanguage, type AiPlatform, type AiTone } from '@touma/shared';
import type { ZodTypeAny } from 'zod';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { AiUsageService } from './ai-usage.service';
import { TEXT_PROVIDER } from './ai-provider';

type Item = { type: 'PRODUCT' | 'SERVICE'; id: string };

export interface StepReport {
  step: 'context' | 'business-analysis' | 'product-analysis' | 'strategy' | 'generation' | 'validation' | 'save';
  status: 'done' | 'reused' | 'skipped';
  generationId?: string;
  detail?: string;
}

export interface ContentRequest {
  language: AiLanguage;
  format: AiFormat;
  purpose: AiContentPurpose;
  tone: AiTone;
  item: Item | null;
  instructions?: string | null;
}

/**
 * Central TOUMA AI orchestrator.
 *  1. Retrieves authorised business facts through KnowledgeService (tenant-scoped, verified only).
 *  2–3. Ensures a business analysis and (for item content) a product analysis exist for the current
 *     facts, reusing previous ones while the data is unchanged (same context hash).
 *  4. Selects a marketing angle from the product analysis or the latest strategy.
 *  5–6. Runs the agent with schema validation, grounding checks, retries and repair (ai-engine).
 *  7. Persists the generation and every provider call (tokens, cost, latency).
 *  8. Returns the validated result and the pipeline steps to the caller.
 * No agent has tools: nothing is published or sent; content is saved as a draft only on request.
 */
@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger('AiOrchestrator');

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly usage: AiUsageService,
    private readonly audit: AuditService,
    @Inject(TEXT_PROVIDER) private readonly provider: TextModelProvider,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get configured() {
    return this.provider.isConfigured();
  }

  private get engineConfig(): EngineConfig {
    return {
      model: this.env.AI_MODEL,
      temperature: this.env.AI_TEMPERATURE,
      maxOutputTokens: this.env.AI_MAX_OUTPUT_TOKENS,
      timeoutMs: this.env.AI_TIMEOUT_MS,
      maxProviderRetries: this.env.AI_MAX_PROVIDER_RETRIES,
      maxRepairAttempts: this.env.AI_MAX_REPAIR_ATTEMPTS,
    };
  }

  private requireConfigured() {
    if (!this.provider.isConfigured()) {
      throw new ServiceUnavailableException({ code: 'AI_NOT_CONFIGURED', message: 'TOUMA AI is not configured on this server (missing provider credentials)' });
    }
  }

  private async loadContext(tenant: TenantContext) {
    return (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
  }

  /** The item must belong to this business (404 otherwise) and be ACTIVE (only active items are AI facts). */
  private async assertItem(tenant: TenantContext, ctx: BusinessContext, item: Item) {
    const inContext = (item.type === 'PRODUCT' ? ctx.products : ctx.services).some((x) => x.id === item.id);
    if (inContext) return;
    const where = { id: item.id, businessId: tenant.businessId, deletedAt: null };
    const exists = item.type === 'PRODUCT' ? await this.prisma.product.count({ where }) : await this.prisma.service.count({ where });
    if (!exists) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `${item.type === 'PRODUCT' ? 'Product' : 'Service'} not found` });
    throw new BadRequestException({ code: 'ITEM_NOT_ACTIVE', message: 'Only ACTIVE products and services are used by TOUMA AI. Activate it first.' });
  }

  private injectionFlags(ctx: BusinessContext, instructions?: string | null) {
    const flags = new Set<string>();
    for (const t of collectStrings({ b: ctx.business, p: ctx.products, s: ctx.services, k: ctx.knowledge })) detectInjection(t).forEach((f) => flags.add(`data:${f}`));
    if (instructions) detectInjection(instructions).forEach((f) => flags.add(`instructions:${f}`));
    return [...flags];
  }

  private async latest(tenant: TenantContext, task: AITask, where: Prisma.AIGenerationWhereInput = {}) {
    return this.prisma.aIGeneration.findFirst({
      where: { businessId: tenant.businessId, task, status: 'SUCCEEDED', ...where },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Runs one agent and persists the outcome. Failures are stored too (with their token usage) and rethrown as HTTP errors. */
  private async execute<I, S extends ZodTypeAny>(
    tenant: TenantContext,
    agent: AgentDefinition<I, S>,
    args: { ctx: BusinessContext; input: I; hash: string; instructions?: string | null; meta: Partial<Prisma.AIGenerationUncheckedCreateInput>; parentId?: string | null },
  ): Promise<AIGeneration> {
    const flags = this.injectionFlags(args.ctx, args.instructions);
    const base = {
      businessId: tenant.businessId,
      userId: tenant.userId,
      task: agent.task as AITask,
      provider: this.provider.name,
      model: this.env.AI_MODEL,
      promptVersion: agent.promptVersion,
      contextHash: args.hash,
      instructions: args.instructions ?? null,
      injectionFlags: flags,
      parentId: args.parentId ?? null,
      params: args.input as unknown as Prisma.InputJsonValue,
      language: (args.input as { language: string }).language,
      ...args.meta,
    } satisfies Partial<Prisma.AIGenerationUncheckedCreateInput>;

    try {
      const res = await runAgent(agent, { provider: this.provider, context: args.ctx, input: args.input, instructions: args.instructions, config: this.engineConfig });
      const gen = await this.prisma.aIGeneration.create({
        data: { ...base, status: 'SUCCEEDED', model: res.model, output: res.output as Prisma.InputJsonValue, attempts: res.attempts.length },
      });
      const totals = await this.usage.recordAttempts({ businessId: tenant.businessId, userId: tenant.userId, agent: agent.agent, provider: this.provider.name, operation: agent.task, generationId: gen.id, attempts: res.attempts });
      if (flags.length) await this.audit.record({ action: 'ai.injection_flagged', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'AIGeneration', entityId: gen.id, metadata: { flags } });
      return this.prisma.aIGeneration.update({
        where: { id: gen.id },
        data: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: new Prisma.Decimal(totals.costUsd.toFixed(6)), latencyMs: totals.latencyMs },
      });
    } catch (err) {
      if (!(err instanceof AgentRunError)) throw err;
      const { code, status, message } = this.mapError(err.error);
      const gen = await this.prisma.aIGeneration.create({ data: { ...base, status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), attempts: err.attempts.length } });
      const totals = await this.usage.recordAttempts({ businessId: tenant.businessId, userId: tenant.userId, agent: agent.agent, provider: this.provider.name, operation: agent.task, generationId: gen.id, attempts: err.attempts });
      await this.prisma.aIGeneration.update({ where: { id: gen.id }, data: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: new Prisma.Decimal(totals.costUsd.toFixed(6)), latencyMs: totals.latencyMs } });
      this.logger.warn(`AI ${agent.agent} failed for business ${tenant.businessId}: ${code} (${err.attempts.length} attempts)`);
      throw new HttpException({ code, message, generationId: gen.id }, status);
    }
  }

  private mapError(err: Error): { code: string; status: number; message: string } {
    if (err instanceof ProviderNotConfiguredError) return { code: 'AI_NOT_CONFIGURED', status: 503, message: 'TOUMA AI is not configured on this server' };
    if (err instanceof OutputValidationError) return { code: 'AI_INVALID_OUTPUT', status: 422, message: `The AI answer did not pass validation: ${err.issues.slice(0, 3).join('; ')}` };
    if (err instanceof ProviderError) {
      const map: Record<string, [string, number, string]> = {
        auth: ['AI_PROVIDER_AUTH', 502, 'The AI provider rejected the configured credentials'],
        rate_limit: ['AI_PROVIDER_RATE_LIMIT', 503, 'The AI provider is rate limiting requests; try again shortly'],
        timeout: ['AI_PROVIDER_TIMEOUT', 504, 'The AI provider did not answer in time'],
        refusal: ['AI_REFUSED', 422, 'The AI declined this request'],
        truncated: ['AI_OUTPUT_TRUNCATED', 502, 'The AI answer was too long; try a shorter format'],
      };
      const [code, status, message] = map[err.kind] ?? ['AI_PROVIDER_ERROR', 502, 'The AI provider is unavailable'];
      return { code, status, message };
    }
    return { code: 'AI_ERROR', status: 500, message: 'Unexpected AI error' };
  }

  // ─── Public tasks ────────────────────────────────────────────────────────────

  async businessAnalysis(tenant: TenantContext, input: { language: AiLanguage; instructions?: string | null }, parentId?: string) {
    this.requireConfigured();
    await this.usage.assertWithinLimits(tenant.businessId);
    const ctx = await this.loadContext(tenant);
    const gen = await this.execute(tenant, businessAnalyst, { ctx, input: { language: input.language }, hash: contextHash(ctx), instructions: input.instructions, meta: {}, parentId });
    return { generation: gen, steps: [{ step: 'context', status: 'done' }, { step: 'business-analysis', status: 'done', generationId: gen.id }, { step: 'save', status: 'done' }] as StepReport[] };
  }

  async productAnalysis(tenant: TenantContext, input: { language: AiLanguage; item: Item; instructions?: string | null }, parentId?: string) {
    this.requireConfigured();
    await this.usage.assertWithinLimits(tenant.businessId);
    const ctx = await this.loadContext(tenant);
    await this.assertItem(tenant, ctx, input.item);
    const gen = await this.execute(tenant, productAnalyst, {
      ctx,
      input: { language: input.language, itemType: input.item.type, itemId: input.item.id },
      hash: contextHash(ctx),
      instructions: input.instructions,
      meta: { itemType: input.item.type, itemId: input.item.id },
      parentId,
    });
    return { generation: gen, steps: [{ step: 'context', status: 'done' }, { step: 'product-analysis', status: 'done', generationId: gen.id }, { step: 'save', status: 'done' }] as StepReport[] };
  }

  async strategy(tenant: TenantContext, input: { language: AiLanguage; platforms: AiPlatform[]; goal?: string | null; focusItemIds?: string[]; instructions?: string | null }, parentId?: string) {
    this.requireConfigured();
    const ctx = await this.loadContext(tenant);
    const focus = input.focusItemIds ?? [];
    const known = new Set([...ctx.products.map((p) => p.id), ...ctx.services.map((s) => s.id)]);
    if (focus.some((id) => !known.has(id))) throw new BadRequestException({ code: 'ITEM_NOT_ACTIVE', message: 'Focus items must be ACTIVE products or services of this business' });
    const hash = contextHash(ctx);
    const steps: StepReport[] = [{ step: 'context', status: 'done' }];
    const profile = await this.ensureBusinessAnalysis(tenant, ctx, hash, input.language, steps);
    await this.usage.assertWithinLimits(tenant.businessId);
    const gen = await this.execute(tenant, marketingStrategist, {
      ctx,
      input: { language: input.language, platforms: input.platforms, goal: input.goal ?? null, focusItems: focus, businessProfile: summarizeProfile(profile) },
      hash,
      instructions: input.instructions,
      meta: { platform: input.platforms.join(',') },
      parentId,
    });
    steps.push({ step: 'strategy', status: 'done', generationId: gen.id }, { step: 'save', status: 'done' });
    return { generation: gen, steps };
  }

  async content(tenant: TenantContext, req: ContentRequest, parentId?: string) {
    this.requireConfigured();
    const ctx = await this.loadContext(tenant);
    if (req.item) await this.assertItem(tenant, ctx, req.item);
    const hash = contextHash(ctx);
    const steps: StepReport[] = [{ step: 'context', status: 'done' }];
    const platform = FORMAT_RULES[req.format].platform;

    // Steps 2–3: analyses for the current facts (reused when unchanged).
    const profile = await this.ensureBusinessAnalysis(tenant, ctx, hash, req.language, steps);
    let productAnalysis: ProductAnalysis | null = null;
    if (req.item) {
      const cached = await this.latest(tenant, 'PRODUCT_ANALYSIS', { itemId: req.item.id, contextHash: hash });
      if (cached) {
        productAnalysis = cached.output as unknown as ProductAnalysis;
        steps.push({ step: 'product-analysis', status: 'reused', generationId: cached.id });
      } else {
        await this.usage.assertWithinLimits(tenant.businessId);
        const g = await this.execute(tenant, productAnalyst, { ctx, input: { language: req.language, itemType: req.item.type, itemId: req.item.id }, hash, meta: { itemType: req.item.type, itemId: req.item.id } });
        productAnalysis = g.output as unknown as ProductAnalysis;
        steps.push({ step: 'product-analysis', status: 'done', generationId: g.id });
      }
    } else steps.push({ step: 'product-analysis', status: 'skipped', detail: 'No product or service selected' });

    // Step 4: choose the marketing angle (product analysis first, then latest strategy for the platform).
    const angle = await this.selectAngle(tenant, productAnalysis, platform, req.purpose, steps);

    // Steps 5–7.
    await this.usage.assertWithinLimits(tenant.businessId);
    const input: ContentInput = {
      language: req.language,
      platform,
      format: req.format,
      purpose: req.purpose,
      tone: req.tone,
      item: req.item,
      angle,
      brandVoice: (ctx.business.brandVoice as string | null) ?? profile?.communicationStyle.recommendedTone ?? null,
    };
    const gen = await this.execute(tenant, contentCreator, {
      ctx,
      input,
      hash,
      instructions: req.instructions,
      meta: { platform, format: req.format, tone: req.tone, purpose: req.purpose, itemType: req.item?.type, itemId: req.item?.id },
      parentId,
    });
    steps.push({ step: 'generation', status: 'done', generationId: gen.id }, { step: 'validation', status: 'done' }, { step: 'save', status: 'done' });
    return { generation: gen, steps };
  }

  async regenerate(tenant: TenantContext, id: string, instructions?: string | null) {
    const parent = await this.prisma.aIGeneration.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!parent) throw new NotFoundException({ code: 'GENERATION_NOT_FOUND', message: 'Generation not found' });
    const p = parent.params as Record<string, unknown>;
    const lang = p.language as AiLanguage;
    const instr = instructions ?? parent.instructions;
    switch (parent.task) {
      case 'BUSINESS_ANALYSIS':
        return this.businessAnalysis(tenant, { language: lang, instructions: instr }, parent.id);
      case 'PRODUCT_ANALYSIS':
        return this.productAnalysis(tenant, { language: lang, item: { type: p.itemType as Item['type'], id: p.itemId as string }, instructions: instr }, parent.id);
      case 'MARKETING_STRATEGY':
        return this.strategy(tenant, { language: lang, platforms: p.platforms as AiPlatform[], goal: p.goal as string | null, focusItemIds: p.focusItems as string[], instructions: instr }, parent.id);
      case 'CONTENT':
        return this.content(tenant, { language: lang, format: p.format as AiFormat, purpose: p.purpose as AiContentPurpose, tone: p.tone as AiTone, item: (p.item as Item | null) ?? null, instructions: instr }, parent.id);
    }
  }

  private async ensureBusinessAnalysis(tenant: TenantContext, ctx: BusinessContext, hash: string, language: AiLanguage, steps: StepReport[]) {
    const cached = await this.latest(tenant, 'BUSINESS_ANALYSIS', { contextHash: hash });
    if (cached) {
      steps.push({ step: 'business-analysis', status: 'reused', generationId: cached.id });
      return cached.output as unknown as BusinessAnalysis;
    }
    await this.usage.assertWithinLimits(tenant.businessId);
    const g = await this.execute(tenant, businessAnalyst, { ctx, input: { language }, hash, meta: {} });
    steps.push({ step: 'business-analysis', status: 'done', generationId: g.id });
    return g.output as unknown as BusinessAnalysis;
  }

  private async selectAngle(tenant: TenantContext, pa: ProductAnalysis | null, platform: AiPlatform | null, purpose: AiContentPurpose, steps: StepReport[]) {
    if (pa?.marketingAngles.length) {
      // Rotate through angles so successive generations explore different ones.
      const n = await this.prisma.aIGeneration.count({ where: { businessId: tenant.businessId, task: 'CONTENT', itemId: pa.item.id } });
      const a = pa.marketingAngles[n % pa.marketingAngles.length]!;
      steps.push({ step: 'strategy', status: 'done', detail: `Angle from product analysis: ${a.name}` });
      return { name: a.name, hook: a.hook, description: a.description };
    }
    const strategy = await this.latest(tenant, 'MARKETING_STRATEGY');
    const plan = strategy && (strategy.output as unknown as MarketingStrategy).platforms.find((p) => p.platform === platform);
    if (strategy && plan?.contentPillars.length) {
      const pillar = plan.contentPillars[(purpose.length + new Date().getUTCDate()) % plan.contentPillars.length]!;
      steps.push({ step: 'strategy', status: 'reused', generationId: strategy.id, detail: `Content pillar: ${pillar.name}` });
      return { name: pillar.name, description: pillar.description };
    }
    steps.push({ step: 'strategy', status: 'skipped', detail: 'No strategy yet; the business profile guides the content' });
    return null;
  }
}

function summarizeProfile(p: BusinessAnalysis | null) {
  if (!p) return null;
  return {
    positioning: p.positioning,
    segments: p.targetSegments.map((s) => s.name),
    tone: p.communicationStyle.recommendedTone,
    recommendedPlatforms: p.recommendedPlatforms,
    objectives: p.marketingObjectives,
  };
}
