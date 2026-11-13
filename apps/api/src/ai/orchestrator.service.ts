import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type AIGeneration, type AITask } from '@touma/database';
import {
  AgentRunError, assessGrounding, businessAnalyst, contentCreator, contextHash, detectInjection, collectStrings, marketingStrategist, OutputValidationError,
  contentPlanner, productAnalyst, ProviderError, ProviderNotConfiguredError, runAgent, storyboardCreator,
  type AgentDefinition, type BusinessAnalysis, type BusinessContext, type ContentInput, type EngineConfig, type MarketingStrategy,
  type ProductAnalysis, type TextModelProvider,
} from '@touma/ai-engine';
import { FORMAT_RULES, addDays, type VideoFormat, type VideoStyle, type AiContentPurpose, type AiFormat, type AiLanguage, type AiPlatform, type AiTone } from '@touma/shared';
import type { ZodTypeAny } from 'zod';
import { Inject } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { lockTenantQuota, quotaExceeded } from '../common/tenant-quota';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { AiQueueService } from './ai-queue';
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

/** What a user asks for. Everything is validated at submission; the worker re-validates against live data. */
export type JobRequest =
  | { task: 'BUSINESS_ANALYSIS'; language: AiLanguage; instructions?: string | null }
  | { task: 'PRODUCT_ANALYSIS'; language: AiLanguage; item: Item; instructions?: string | null }
  | { task: 'MARKETING_STRATEGY'; language: AiLanguage; platforms: AiPlatform[]; goal?: string | null; focusItemIds?: string[]; instructions?: string | null }
  | ({ task: 'CONTENT' } & ContentRequest)
  | { task: 'STORYBOARD'; language: AiLanguage; format: VideoFormat; seconds: number; style: VideoStyle; tone: AiTone; item: Item | null; instructions?: string | null }
  | { task: 'CONTENT_PLAN'; language: AiLanguage; startDate: string; days: number; postsPerWeek: number; platforms: AiPlatform[]; tone?: AiTone | null; goal?: string | null; occasions: Array<{ name: string; date: string; day: number }>; instructions?: string | null };

/** A failure of a generation job, classified for retry decisions and stored on the generation. */
export class AiJobError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    /** Transient provider problems (rate limit, timeout, outage) are retried by the queue with backoff. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiJobError';
  }
}

const AGENT_FOR: Record<AITask, AgentDefinition<never, ZodTypeAny>> = {
  BUSINESS_ANALYSIS: businessAnalyst as never,
  PRODUCT_ANALYSIS: productAnalyst as never,
  MARKETING_STRATEGY: marketingStrategist as never,
  CONTENT: contentCreator as never,
  STORYBOARD: storyboardCreator as never,
  CONTENT_PLAN: contentPlanner as never,
};

/**
 * Central TOUMA AI orchestrator, in two halves:
 *
 *  - submit() (API process): validates the request against the business's verified data, reserves
 *    monthly quota atomically, stores a QUEUED generation and enqueues a BullMQ job. It answers
 *    immediately with the generation id.
 *  - runPipeline() (worker process): retrieves authorised business facts (tenant-scoped, verified
 *    only), ensures the business/product analyses exist for the current facts (reused while the data
 *    is unchanged), selects a marketing angle, runs the agent with schema validation, grounding checks,
 *    retries and repair, and persists the result, the pipeline steps, the quality report and every
 *    provider call (tokens, cost, latency).
 *
 * No agent has tools: nothing is published or sent. Content only becomes a draft on request and needs
 * human approval before publication.
 */
@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger('AiOrchestrator');

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly usage: AiUsageService,
    private readonly audit: AuditService,
    private readonly queue: AiQueueService,
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

  private async loadContext(tenant: Pick<TenantContext, 'businessId'>) {
    return (await this.knowledge.buildAgentContext(tenant as TenantContext)) as unknown as BusinessContext;
  }

  /** The item must belong to this business (404 otherwise) and be ACTIVE (only active items are AI facts). */
  private async assertItem(businessId: string, ctx: BusinessContext, item: Item) {
    const inContext = (item.type === 'PRODUCT' ? ctx.products : ctx.services).some((x) => x.id === item.id);
    if (inContext) return;
    const where = { id: item.id, businessId, deletedAt: null };
    const exists = item.type === 'PRODUCT' ? await this.prisma.product.count({ where }) : await this.prisma.service.count({ where });
    if (!exists) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `${item.type === 'PRODUCT' ? 'Product' : 'Service'} not found` });
    throw new BadRequestException({ code: 'ITEM_NOT_ACTIVE', message: 'Only ACTIVE products and services are used by TOUMA AI. Activate it first.' });
  }

  private assertFocus(ctx: BusinessContext, focus: string[]) {
    const known = new Set([...ctx.products.map((p) => p.id), ...ctx.services.map((s) => s.id)]);
    if (focus.some((id) => !known.has(id))) throw new BadRequestException({ code: 'ITEM_NOT_ACTIVE', message: 'Focus items must be ACTIVE products or services of this business' });
  }

  private injectionFlags(ctx: BusinessContext, instructions?: string | null) {
    const flags = new Set<string>();
    for (const t of collectStrings({ b: ctx.business, p: ctx.products, s: ctx.services, k: ctx.knowledge })) detectInjection(t).forEach((f) => flags.add(`data:${f}`));
    if (instructions) detectInjection(instructions).forEach((f) => flags.add(`instructions:${f}`));
    return [...flags];
  }

  private async latest(businessId: string, task: AITask, where: Prisma.AIGenerationWhereInput = {}) {
    return this.prisma.aIGeneration.findFirst({ where: { businessId, task, status: 'SUCCEEDED', ...where }, orderBy: { createdAt: 'desc' } });
  }

  // ─── Submission (API process) ────────────────────────────────────────────────

  /** Request-shaped parameters stored on the row; regeneration and the worker read them back. */
  private rowFor(req: JobRequest): Pick<Prisma.AIGenerationUncheckedCreateInput, 'task' | 'language' | 'params' | 'platform' | 'format' | 'tone' | 'purpose' | 'itemType' | 'itemId' | 'instructions'> {
    const instructions = req.instructions ?? null;
    switch (req.task) {
      case 'BUSINESS_ANALYSIS':
        return { task: req.task, language: req.language, params: { language: req.language }, instructions };
      case 'PRODUCT_ANALYSIS':
        return { task: req.task, language: req.language, params: { language: req.language, itemType: req.item.type, itemId: req.item.id }, itemType: req.item.type, itemId: req.item.id, instructions };
      case 'MARKETING_STRATEGY':
        return { task: req.task, language: req.language, params: { language: req.language, platforms: req.platforms, goal: req.goal ?? null, focusItems: req.focusItemIds ?? [] }, platform: req.platforms.join(','), instructions };
      case 'CONTENT':
        return {
          task: req.task,
          language: req.language,
          params: { language: req.language, platform: FORMAT_RULES[req.format].platform, format: req.format, purpose: req.purpose, tone: req.tone, item: req.item } as Prisma.InputJsonObject,
          platform: FORMAT_RULES[req.format].platform,
          format: req.format,
          tone: req.tone,
          purpose: req.purpose,
          itemType: req.item?.type,
          itemId: req.item?.id,
          instructions,
        };
      case 'STORYBOARD':
        return {
          task: req.task,
          language: req.language,
          params: { language: req.language, format: req.format, seconds: req.seconds, style: req.style, tone: req.tone, item: req.item } as Prisma.InputJsonObject,
          format: req.format,
          tone: req.tone,
          itemType: req.item?.type,
          itemId: req.item?.id,
          instructions,
        };
      case 'CONTENT_PLAN':
        return {
          task: req.task,
          language: req.language,
          params: { language: req.language, startDate: req.startDate, days: req.days, postsPerWeek: req.postsPerWeek, platforms: req.platforms, tone: req.tone ?? null, goal: req.goal ?? null, occasions: req.occasions } as Prisma.InputJsonObject,
          platform: req.platforms.join(','),
          tone: req.tone ?? undefined,
          instructions,
        };
    }
  }

  /** Generation units this request needs now (cached analyses are reused and cost nothing). The worker tops up if facts changed. */
  private async estimateUnits(businessId: string, req: JobRequest, hash: string) {
    const cachedProfile = async () => Boolean(await this.latest(businessId, 'BUSINESS_ANALYSIS', { contextHash: hash }));
    switch (req.task) {
      case 'BUSINESS_ANALYSIS':
      case 'PRODUCT_ANALYSIS':
        return 1;
      case 'MARKETING_STRATEGY':
        return 1 + ((await cachedProfile()) ? 0 : 1);
      case 'CONTENT_PLAN':
        return 1 + ((await cachedProfile()) ? 0 : 1);
      case 'STORYBOARD':
      case 'CONTENT': {
        let units = 1 + ((await cachedProfile()) ? 0 : 1);
        if (req.item && !(await this.latest(businessId, 'PRODUCT_ANALYSIS', { itemId: req.item.id, contextHash: hash }))) units += 1;
        return units;
      }
    }
  }

  /**
   * Accepts a generation: validates, reserves quota atomically, stores a QUEUED generation and enqueues
   * its job. Every failure here (not configured, unknown or inactive item, limit reached, queue down)
   * is raised before anything is charged or stored.
   */
  async submit(tenant: TenantContext, req: JobRequest, parentId?: string | null): Promise<AIGeneration> {
    this.requireConfigured();
    const ctx = await this.loadContext(tenant);
    if (req.task === 'PRODUCT_ANALYSIS' || ((req.task === 'CONTENT' || req.task === 'STORYBOARD') && req.item)) await this.assertItem(tenant.businessId, ctx, (req as { item: Item }).item);
    if (req.task === 'MARKETING_STRATEGY') this.assertFocus(ctx, req.focusItemIds ?? []);
    const hash = contextHash(ctx);
    const units = await this.estimateUnits(tenant.businessId, req, hash);
    const flags = this.injectionFlags(ctx, req.instructions);
    const agent = AGENT_FOR[req.task];

    const gen = await this.prisma.$transaction(async (tx) => {
      // Tenant limit on queued + running generations, decided under a tenant lock (nothing is charged when it refuses).
      await lockTenantQuota(tx, 'ai', tenant.businessId);
      const inFlight = await tx.aIGeneration.count({ where: { businessId: tenant.businessId, status: { in: ['QUEUED', 'RUNNING'] } } });
      if (inFlight >= this.env.AI_MAX_INFLIGHT_PER_BUSINESS) throw quotaExceeded('AI_QUEUE_LIMIT', `At most ${this.env.AI_MAX_INFLIGHT_PER_BUSINESS} generations can be waiting or running at once. Try again when one finishes.`);
      const created = await tx.aIGeneration.create({
        data: {
          ...this.rowFor(req),
          businessId: tenant.businessId,
          userId: tenant.userId,
          status: 'QUEUED',
          provider: this.provider.name,
          model: this.env.AI_MODEL,
          promptVersion: agent.promptVersion,
          contextHash: hash,
          injectionFlags: flags,
          parentId: parentId ?? null,
          queuedAt: new Date(),
          steps: [],
        },
      });
      const row = await tx.aIGeneration.update({ where: { id: created.id }, data: { rootId: created.id } });
      await this.usage.reserve(tx, { businessId: tenant.businessId, generationId: row.id, units });
      return row;
    });

    try {
      await this.queue.enqueue(gen.id);
    } catch (err) {
      await this.prisma.aIGeneration.update({ where: { id: gen.id }, data: { status: 'FAILED', errorCode: 'AI_QUEUE_UNAVAILABLE', errorMessage: 'The AI job queue was unavailable', completedAt: new Date() } });
      await this.usage.settle(gen.id, 'released');
      throw err;
    }
    if (flags.length) await this.audit.record({ action: 'ai.injection_flagged', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'AIGeneration', entityId: gen.id, metadata: { flags } });
    return gen;
  }

  async regenerate(tenant: TenantContext, id: string, instructions?: string | null) {
    const parent = await this.prisma.aIGeneration.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!parent) throw new NotFoundException({ code: 'GENERATION_NOT_FOUND', message: 'Generation not found' });
    if (parent.status === 'QUEUED' || parent.status === 'RUNNING') throw new ConflictException({ code: 'GENERATION_IN_PROGRESS', message: 'This generation is still running' });
    return this.submit(tenant, this.requestFrom(parent, instructions ?? parent.instructions), parent.id);
  }

  /** Rebuilds the request of a stored generation (used by regeneration and by the worker). */
  requestFrom(g: AIGeneration, instructions: string | null): JobRequest {
    const p = g.params as Record<string, unknown>;
    const language = (p.language ?? g.language) as AiLanguage;
    switch (g.task) {
      case 'BUSINESS_ANALYSIS':
        return { task: 'BUSINESS_ANALYSIS', language, instructions };
      case 'PRODUCT_ANALYSIS':
        return { task: 'PRODUCT_ANALYSIS', language, item: { type: (p.itemType ?? g.itemType) as Item['type'], id: (p.itemId ?? g.itemId) as string }, instructions };
      case 'MARKETING_STRATEGY':
        return { task: 'MARKETING_STRATEGY', language, platforms: p.platforms as AiPlatform[], goal: (p.goal as string | null) ?? null, focusItemIds: (p.focusItems as string[]) ?? [], instructions };
      case 'CONTENT':
        return { task: 'CONTENT', language, format: p.format as AiFormat, purpose: p.purpose as AiContentPurpose, tone: p.tone as AiTone, item: (p.item as Item | null) ?? null, instructions };
      case 'STORYBOARD':
        return { task: 'STORYBOARD', language, format: p.format as VideoFormat, seconds: Number(p.seconds), style: p.style as VideoStyle, tone: p.tone as AiTone, item: (p.item as Item | null) ?? null, instructions };
      case 'CONTENT_PLAN':
        return { task: 'CONTENT_PLAN', language, startDate: p.startDate as string, days: Number(p.days), postsPerWeek: Number(p.postsPerWeek), platforms: p.platforms as AiPlatform[], tone: (p.tone as AiTone | null) ?? null, goal: (p.goal as string | null) ?? null, occasions: (p.occasions as Array<{ name: string; date: string; day: number }>) ?? [], instructions };
    }
  }

  // ─── Execution (worker process) ──────────────────────────────────────────────

  mapError(err: Error): AiJobError {
    if (err instanceof ProviderNotConfiguredError) return new AiJobError('AI_NOT_CONFIGURED', 503, 'TOUMA AI is not configured on this server');
    if (err instanceof OutputValidationError) return new AiJobError('AI_INVALID_OUTPUT', 422, `The AI answer did not pass validation: ${err.issues.slice(0, 3).join('; ')}`);
    if (err instanceof ProviderError) {
      const map: Record<string, [string, number, string]> = {
        auth: ['AI_PROVIDER_AUTH', 502, 'The AI provider rejected the configured credentials'],
        rate_limit: ['AI_PROVIDER_RATE_LIMIT', 503, 'The AI provider is rate limiting requests; try again shortly'],
        timeout: ['AI_PROVIDER_TIMEOUT', 504, 'The AI provider did not answer in time'],
        refusal: ['AI_REFUSED', 422, 'The AI declined this request'],
        truncated: ['AI_OUTPUT_TRUNCATED', 502, 'The AI answer was too long; try a shorter format'],
      };
      const [code, status, message] = map[err.kind] ?? ['AI_PROVIDER_ERROR', 502, 'The AI provider is unavailable'];
      return new AiJobError(code, status, message, err.retryable);
    }
    if (err instanceof AiJobError) return err;
    if (err instanceof HttpException) {
      const body = err.getResponse() as { code?: string; message?: unknown };
      return new AiJobError(body.code ?? 'AI_ERROR', err.getStatus(), typeof body.message === 'string' ? body.message : err.message);
    }
    return new AiJobError('AI_ERROR', 500, 'Unexpected AI error');
  }

  private async saveSteps(id: string, steps: StepReport[]) {
    await this.prisma.aIGeneration.update({ where: { id }, data: { steps: steps as unknown as Prisma.InputJsonValue } });
  }

  /** Runs one agent into a generation row. Provider calls are recorded whether or not the run succeeds. */
  private async runInto<I, S extends ZodTypeAny>(row: AIGeneration, root: AIGeneration, agent: AgentDefinition<I, S>, args: { ctx: BusinessContext; input: I; instructions?: string | null; hash: string }) {
    try {
      const res = await runAgent(agent, { provider: this.provider, context: args.ctx, input: args.input, instructions: args.instructions, config: this.engineConfig });
      const totals = await this.usage.recordAttempts({ businessId: root.businessId, userId: root.userId ?? '', agent: agent.agent, provider: this.provider.name, operation: agent.task, generationId: row.id, attempts: res.attempts });
      await this.prisma.aIGeneration.update({
        where: { id: row.id },
        data: {
          status: 'SUCCEEDED',
          model: res.model,
          output: res.output as Prisma.InputJsonValue,
          params: args.input as unknown as Prisma.InputJsonValue,
          contextHash: args.hash,
          quality: assessGrounding(res.output, args.ctx) as unknown as Prisma.InputJsonValue,
          errorCode: null,
          errorMessage: null,
          completedAt: new Date(),
          attempts: totals.calls,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          costUsd: new Prisma.Decimal(totals.costUsd.toFixed(6)),
          latencyMs: totals.latencyMs,
        },
      });
      return res.output;
    } catch (err) {
      if (!(err instanceof AgentRunError)) throw err;
      const totals = await this.usage.recordAttempts({ businessId: root.businessId, userId: root.userId ?? '', agent: agent.agent, provider: this.provider.name, operation: agent.task, generationId: row.id, attempts: err.attempts });
      const e = this.mapError(err.error);
      await this.prisma.aIGeneration.update({
        where: { id: row.id },
        data: {
          attempts: totals.calls,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          costUsd: new Prisma.Decimal(totals.costUsd.toFixed(6)),
          latencyMs: totals.latencyMs,
          // The requested generation's final status is decided by the job (it may be retried); analyses record theirs now.
          ...(row.id === root.id ? { errorCode: e.code, errorMessage: e.message.slice(0, 500) } : { status: 'FAILED' as const, errorCode: e.code, errorMessage: e.message.slice(0, 500), completedAt: new Date() }),
        },
      });
      this.logger.warn(`AI ${agent.agent} failed for business ${root.businessId}: ${e.code} (${err.attempts.length} provider calls)`);
      throw e;
    }
  }

  /** Row for an analysis triggered by a job. A failed attempt's row is reused when the queue retries, so retries never multiply rows. */
  private async stepRow(root: AIGeneration, agent: AgentDefinition<never, ZodTypeAny>, hash: string, meta: Partial<Prisma.AIGenerationUncheckedCreateInput>, params: Prisma.InputJsonValue, instructions?: string | null) {
    const existing = await this.prisma.aIGeneration.findFirst({ where: { rootId: root.id, task: agent.task as AITask, id: { not: root.id }, status: { in: ['RUNNING', 'FAILED'] } }, orderBy: { createdAt: 'desc' } });
    if (existing) return this.prisma.aIGeneration.update({ where: { id: existing.id }, data: { status: 'RUNNING', errorCode: null, errorMessage: null, completedAt: null } });
    await this.usage.ensureCovers(root.id, (await this.prisma.aIGeneration.count({ where: { rootId: root.id } })) + 1);
    return this.prisma.aIGeneration.create({
      data: {
        businessId: root.businessId,
        userId: root.userId,
        task: agent.task as AITask,
        status: 'RUNNING',
        provider: this.provider.name,
        model: this.env.AI_MODEL,
        promptVersion: agent.promptVersion,
        contextHash: hash,
        instructions: instructions ?? null,
        injectionFlags: root.injectionFlags,
        language: root.language,
        params,
        rootId: root.id,
        queuedAt: root.queuedAt,
        startedAt: new Date(),
        ...meta,
      },
    });
  }

  private async analysisStep<I, S extends ZodTypeAny>(root: AIGeneration, agent: AgentDefinition<I, S>, args: { ctx: BusinessContext; input: I; hash: string; meta: Partial<Prisma.AIGenerationUncheckedCreateInput> }) {
    const row = await this.stepRow(root, agent as never, args.hash, args.meta, args.input as unknown as Prisma.InputJsonValue);
    return { row, output: await this.runInto(row, root, agent, { ctx: args.ctx, input: args.input, hash: args.hash }) };
  }

  /**
   * The worker's entry point for one job. Runs the whole pipeline for the stored request and leaves the
   * requested generation SUCCEEDED, or throws an AiJobError. Job state transitions, retries and quota
   * settlement are the processor's job.
   */
  async runPipeline(root: AIGeneration, tenant: TenantContext): Promise<void> {
    this.requireConfigured();
    const req = this.requestFrom(root, root.instructions);
    const ctx = await this.loadContext(tenant);
    const hash = contextHash(ctx);
    const steps: StepReport[] = [{ step: 'context', status: 'done' }];
    await this.saveSteps(root.id, steps);
    const add = async (s: StepReport) => {
      steps.push(s);
      await this.saveSteps(root.id, steps);
    };

    switch (req.task) {
      case 'BUSINESS_ANALYSIS': {
        await this.runInto(root, root, businessAnalyst, { ctx, input: { language: req.language }, instructions: req.instructions, hash });
        await add({ step: 'business-analysis', status: 'done', generationId: root.id });
        break;
      }
      case 'PRODUCT_ANALYSIS': {
        await this.assertItem(root.businessId, ctx, req.item);
        await this.runInto(root, root, productAnalyst, { ctx, input: { language: req.language, itemType: req.item.type, itemId: req.item.id }, instructions: req.instructions, hash });
        await add({ step: 'product-analysis', status: 'done', generationId: root.id });
        break;
      }
      case 'MARKETING_STRATEGY': {
        this.assertFocus(ctx, req.focusItemIds ?? []);
        const profile = await this.ensureBusinessAnalysis(root, ctx, hash, req.language, add);
        await this.runInto(root, root, marketingStrategist, {
          ctx,
          input: { language: req.language, platforms: req.platforms, goal: req.goal ?? null, focusItems: req.focusItemIds ?? [], businessProfile: summarizeProfile(profile) },
          instructions: req.instructions,
          hash,
        });
        await add({ step: 'strategy', status: 'done', generationId: root.id });
        break;
      }
      case 'CONTENT': {
        if (req.item) await this.assertItem(root.businessId, ctx, req.item);
        const platform = FORMAT_RULES[req.format].platform;
        const profile = await this.ensureBusinessAnalysis(root, ctx, hash, req.language, add);
        let productAnalysis: ProductAnalysis | null = null;
        if (req.item) {
          const cached = await this.latest(root.businessId, 'PRODUCT_ANALYSIS', { itemId: req.item.id, contextHash: hash });
          if (cached) {
            productAnalysis = cached.output as unknown as ProductAnalysis;
            await add({ step: 'product-analysis', status: 'reused', generationId: cached.id });
          } else {
            const r = await this.analysisStep(root, productAnalyst, { ctx, input: { language: req.language, itemType: req.item.type, itemId: req.item.id }, hash, meta: { itemType: req.item.type, itemId: req.item.id } });
            productAnalysis = r.output as unknown as ProductAnalysis;
            await add({ step: 'product-analysis', status: 'done', generationId: r.row.id });
          }
        } else await add({ step: 'product-analysis', status: 'skipped', detail: 'No product or service selected' });

        const angle = await this.selectAngle(root, productAnalysis, platform, req.purpose, add);
        const input: ContentInput = {
          language: req.language,
          platform,
          format: req.format,
          purpose: req.purpose,
          tone: req.tone,
          item: req.item,
          angle,
          brandVoice: (ctx.business.brandVoice as string | null) ?? profile?.communicationStyle.recommendedTone ?? null,
          brand: await this.brandFor(root.businessId).then((b) => (b ? { preferredTone: b.preferredTone, visualStyle: b.visualStyle, guidelines: b.guidelines } : null)),
        };
        await this.runInto(root, root, contentCreator, { ctx, input, instructions: req.instructions, hash });
        await add({ step: 'generation', status: 'done', generationId: root.id });
        await add({ step: 'validation', status: 'done', detail: 'Schema, platform rules and grounding against verified business data' });
        break;
      }
      case 'STORYBOARD': {
        await this.runStoryboard(root, req, ctx, hash, add);
        break;
      }
      case 'CONTENT_PLAN': {
        await this.runContentPlan(root, req, ctx, hash, add);
        break;
      }
    }
    await add({ step: 'save', status: 'done' });
  }

  private async runStoryboard(root: AIGeneration, req: Extract<JobRequest, { task: 'STORYBOARD' }>, ctx: BusinessContext, hash: string, add: (s: StepReport) => Promise<void>) {
    if (req.item) await this.assertItem(root.businessId, ctx, req.item);
    const profile = await this.ensureBusinessAnalysis(root, ctx, hash, req.language, add);
    let productAnalysis: ProductAnalysis | null = null;
    if (req.item) {
      const cached = await this.latest(root.businessId, 'PRODUCT_ANALYSIS', { itemId: req.item.id, contextHash: hash });
      if (cached) {
        productAnalysis = cached.output as unknown as ProductAnalysis;
        await add({ step: 'product-analysis', status: 'reused', generationId: cached.id });
      } else {
        const r = await this.analysisStep(root, productAnalyst, { ctx, input: { language: req.language, itemType: req.item.type, itemId: req.item.id }, hash, meta: { itemType: req.item.type, itemId: req.item.id } });
        productAnalysis = r.output as unknown as ProductAnalysis;
        await add({ step: 'product-analysis', status: 'done', generationId: r.row.id });
      }
    } else await add({ step: 'product-analysis', status: 'skipped', detail: 'No product or service selected' });
    const angle = await this.selectAngle(root, productAnalysis, null, 'PROMOTIONAL', add);
    const brand = await this.brandFor(root.businessId);
    await this.runInto(root, root, storyboardCreator, {
      ctx,
      input: { language: req.language, format: req.format, seconds: req.seconds, style: req.style, tone: req.tone, item: req.item, angle, brandVoice: (ctx.business.brandVoice as string | null) ?? profile?.communicationStyle.recommendedTone ?? null, brand: brand ? { visualStyle: brand.visualStyle, guidelines: brand.guidelines, colors: brand.colors } : null },
      instructions: req.instructions,
      hash,
    });
    await add({ step: 'generation', status: 'done', generationId: root.id });
    await add({ step: 'validation', status: 'done', detail: 'Schema, timing and grounding against verified business data' });
  }

  private async runContentPlan(root: AIGeneration, req: Extract<JobRequest, { task: 'CONTENT_PLAN' }>, ctx: BusinessContext, hash: string, add: (s: StepReport) => Promise<void>) {
    const profile = await this.ensureBusinessAnalysis(root, ctx, hash, req.language, add);
    const business = await this.prisma.business.findUnique({ where: { id: root.businessId }, select: { timezone: true, objectives: true } });
    const accounts = await this.prisma.socialAccount.findMany({ where: { businessId: root.businessId, status: 'CONNECTED', deletedAt: null }, select: { platform: true } });
    const brand = await this.brandFor(root.businessId);
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const calendar = Array.from({ length: req.days }, (_, k) => {
      const date = addDays(req.startDate, k);
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      return { day: k + 1, date, weekday: weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]! };
    });
    await add({ step: 'strategy', status: 'skipped', detail: `Plan of ${req.days} days from ${req.startDate}` });
    await this.runInto(root, root, contentPlanner, {
      ctx,
      input: {
        language: req.language,
        startDate: req.startDate,
        days: req.days,
        timezone: business?.timezone ?? 'UTC',
        postsPerWeek: req.postsPerWeek,
        platforms: req.platforms,
        connectedPlatforms: [...new Set(accounts.map((a) => a.platform))] as AiPlatform[],
        tone: req.tone ?? null,
        goal: req.goal ?? null,
        objectives: business?.objectives ?? null,
        occasions: req.occasions,
        calendar,
        brandVoice: (ctx.business.brandVoice as string | null) ?? profile?.communicationStyle.recommendedTone ?? null,
        brand: brand ? { preferredTone: brand.preferredTone, visualStyle: brand.visualStyle, guidelines: brand.guidelines, colors: brand.colors } : null,
      },
      instructions: req.instructions,
      hash,
    });
    await add({ step: 'generation', status: 'done', generationId: root.id });
    await add({ step: 'validation', status: 'done', detail: 'Schema, balance, occasions and promotions against verified business data' });
  }

  /** The business's brand kit as the text agents see it (null when it has none). */
  private async brandFor(businessId: string) {
    const kit = await this.prisma.brandKit.findUnique({ where: { businessId } });
    if (!kit) return null;
    const colors = ((kit.colors as Array<{ name: string; hex: string; role: string }> | null) ?? []).map((c) => `${c.role.toLowerCase()} ${c.hex}`);
    return { preferredTone: kit.preferredTone, visualStyle: kit.visualStyle, guidelines: kit.guidelines, colors };
  }

  private async ensureBusinessAnalysis(root: AIGeneration, ctx: BusinessContext, hash: string, language: AiLanguage, add: (s: StepReport) => Promise<void>) {
    const cached = await this.latest(root.businessId, 'BUSINESS_ANALYSIS', { contextHash: hash });
    if (cached) {
      await add({ step: 'business-analysis', status: 'reused', generationId: cached.id });
      return cached.output as unknown as BusinessAnalysis;
    }
    const r = await this.analysisStep(root, businessAnalyst, { ctx, input: { language }, hash, meta: {} });
    await add({ step: 'business-analysis', status: 'done', generationId: r.row.id });
    return r.output as unknown as BusinessAnalysis;
  }

  private async selectAngle(root: AIGeneration, pa: ProductAnalysis | null, platform: AiPlatform | null, purpose: AiContentPurpose, add: (s: StepReport) => Promise<void>) {
    if (pa?.marketingAngles.length) {
      // Rotate through angles so successive generations explore different ones.
      const n = await this.prisma.aIGeneration.count({ where: { businessId: root.businessId, task: 'CONTENT', itemId: pa.item.id, status: 'SUCCEEDED' } });
      const a = pa.marketingAngles[n % pa.marketingAngles.length]!;
      await add({ step: 'strategy', status: 'done', detail: `Angle from product analysis: ${a.name}` });
      return { name: a.name, hook: a.hook, description: a.description };
    }
    const strategy = await this.latest(root.businessId, 'MARKETING_STRATEGY');
    const plan = strategy && (strategy.output as unknown as MarketingStrategy).platforms.find((p) => p.platform === platform);
    if (strategy && plan?.contentPillars.length) {
      const pillar = plan.contentPillars[(purpose.length + new Date().getUTCDate()) % plan.contentPillars.length]!;
      await add({ step: 'strategy', status: 'reused', generationId: strategy.id, detail: `Content pillar: ${pillar.name}` });
      return { name: pillar.name, description: pillar.description };
    }
    await add({ step: 'strategy', status: 'skipped', detail: 'No strategy yet; the business profile guides the content' });
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
