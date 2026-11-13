import { createHash } from 'crypto';
import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type CreativeGeneration, type CreativeOutput, type MediaAsset } from '@touma/database';
import { checkGrounding, type BusinessContext, type TextModelProvider } from '@touma/ai-engine';
import {
  buildImagePrompt, buildVideoPrompt, extractProduct, snapSeconds,
  type ImageProvider, type PromptBrand, type PromptItem, type VideoProvider,
} from '@touma/creative';
import {
  ASPECT_RATIOS, BRAND_FONT_NAMES, CREATIVE_LIMITS, CREATIVE_PLATFORMS, dimensionsFor, IMAGE_BACKGROUNDS, IMAGE_STYLES, IMAGE_THEMES, IMAGE_TYPES, LOGO_PLACEMENTS,
  OVERLAY_POSITIONS, PLATFORM_ASPECTS, PRESERVATION_MODES, RESOLUTIONS, VIDEO_FORMATS, VIDEO_STYLES,
  type AspectRatio, type CreativePlatform, type ImageStyle, type Resolution, type VideoFormat, type VideoStyle,
} from '@touma/shared';
import { OBJECT_STORAGE, type ObjectStorage } from '@touma/storage';
import { TEXT_PROVIDER } from '../ai/ai-provider';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { pageArgs, toPage } from '../common/pagination';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MediaService } from '../media/media.service';
import { lockTenantQuota, quotaExceeded } from '../common/tenant-quota';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { BrandKitService } from './brand-kit.service';
import { IMAGE_PROVIDER, VIDEO_PROVIDER } from './creative-providers';
import { CreativeQueueService } from './creative-queue';
import { CreativeUsageService } from './creative-usage.service';
import type { CreateImageDto, CreateVideoDto, CreativeQueryDto, VariationDto } from './creative.dto';

type Full = CreativeGeneration & { outputs: Array<CreativeOutput & { media: MediaAsset }> };
type Item = { type: 'PRODUCT' | 'SERVICE'; id: string };

export interface ImageParams {
  type: string; style: ImageStyle; aspectRatio: AspectRatio; resolution: Resolution; width: number; height: number;
  background: string; backgroundNote: string | null; theme: string; themeNote: string | null;
  overlayText: string | null; overlayPosition: string; logoPlacement: string; platform: CreativePlatform;
  preservation: 'EXACT' | 'GUIDED' | 'NONE'; mode: 'TEXT_TO_IMAGE' | 'SCENE_ONLY' | 'EDIT'; count: number; useBrandKit: boolean; instructions: string | null;
}
export interface VideoParams {
  format: VideoFormat; aspectRatio: AspectRatio; requestedSeconds: number; seconds: number; style: VideoStyle;
  storyboardId: string | null; sceneOrder: number | null; useBrandKit: boolean; instructions: string | null;
}

@Injectable()
export class CreativeService {
  private readonly logger = new Logger('Creative');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
    private readonly knowledge: KnowledgeService,
    private readonly brandKit: BrandKitService,
    private readonly usage: CreativeUsageService,
    private readonly queue: CreativeQueueService,
    @Inject(IMAGE_PROVIDER) private readonly image: ImageProvider | null,
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider | null,
    @Inject(TEXT_PROVIDER) private readonly text: TextModelProvider,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  // ─── Overview ───────────────────────────────────────────────────────────────

  /** What the studio can do right now: providers, capabilities, options, limits and storage. Never contains credentials. */
  async overview(tenant: TenantContext) {
    const [usage, storage] = await Promise.all([this.usage.monthToDate(tenant.businessId), this.media.usage(tenant.businessId)]);
    const img = this.image?.isConfigured() ? this.image : null;
    const vid = this.video?.isConfigured() ? this.video : null;
    return {
      image: { configured: Boolean(img), provider: this.image?.name ?? 'none', model: this.env.IMAGE_MODEL, capabilities: img?.capabilities ?? null },
      video: {
        configured: Boolean(vid),
        provider: this.video?.name ?? 'none',
        model: this.env.VIDEO_MODEL,
        capabilities: vid ? { seconds: vid.capabilities.seconds, aspectRatios: Object.keys(vid.capabilities.sizes), imageToVideo: vid.capabilities.imageToVideo, thumbnail: vid.capabilities.thumbnail } : null,
      },
      storyboard: { configured: this.text.isConfigured() },
      storage: { configured: this.storage.configured, ...storage },
      usage,
      costTracking: this.usage.costConfigured,
      pricing: this.usage.pricingSummary(),
      options: {
        imageTypes: IMAGE_TYPES, styles: IMAGE_STYLES, backgrounds: IMAGE_BACKGROUNDS, themes: IMAGE_THEMES, aspectRatios: ASPECT_RATIOS, resolutions: RESOLUTIONS,
        overlayPositions: OVERLAY_POSITIONS, logoPlacements: LOGO_PLACEMENTS, preservationModes: PRESERVATION_MODES, platforms: CREATIVE_PLATFORMS, platformAspects: PLATFORM_ASPECTS,
        videoFormats: VIDEO_FORMATS, videoStyles: VIDEO_STYLES, fonts: BRAND_FONT_NAMES, limits: CREATIVE_LIMITS,
      },
    };
  }

  // ─── Shared helpers ─────────────────────────────────────────────────────────

  private hashOf(businessId: string, kind: string, body: unknown) {
    return createHash('sha256').update(JSON.stringify({ businessId, kind, body })).digest('hex');
  }

  private async replay(businessId: string, key: string | undefined, hash: string) {
    if (!key) return null;
    const existing = await this.prisma.creativeGeneration.findUnique({ where: { businessId_idempotencyKey: { businessId, idempotencyKey: key } }, include: { outputs: { include: { media: true } } } });
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with different parameters' });
    return existing as Full;
  }

  private async loadItem(tenant: TenantContext, ctx: BusinessContext, itemType?: string, itemId?: string): Promise<{ item: Item; prompt: PromptItem } | null> {
    if (!itemId) return null;
    const type = (itemType ?? 'PRODUCT') as Item['type'];
    const rows = (type === 'PRODUCT' ? ctx.products : ctx.services) as Array<Record<string, unknown> & { id: string; name: string }>;
    const row = rows.find((r) => r.id === itemId);
    if (!row) {
      const where = { id: itemId, businessId: tenant.businessId, deletedAt: null };
      const exists = type === 'PRODUCT' ? await this.prisma.product.count({ where }) : await this.prisma.service.count({ where });
      if (!exists) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: `${type === 'PRODUCT' ? 'Product' : 'Service'} not found` });
      throw new BadRequestException({ code: 'ITEM_NOT_ACTIVE', message: 'Only ACTIVE products and services are used by TOUMA AI. Activate it first.' });
    }
    return {
      item: { type, id: itemId },
      prompt: { kind: type, name: row.name, description: (row.description as string | null) ?? null, features: (row.features as string[]) ?? [], benefits: (row.benefits as string[]) ?? [], category: (row.category as string | null) ?? null },
    };
  }

  private promptBrand(kit: Awaited<ReturnType<BrandKitService['forPrompt']>>): PromptBrand | null {
    return kit ? { colors: kit.colors, visualStyle: kit.visualStyle, guidelines: kit.guidelines } : null;
  }

  private bizPrompt(ctx: BusinessContext) {
    const b = ctx.business as Record<string, unknown>;
    return { name: ctx.business.name, type: (b.type as string) ?? null, industry: (b.industry as string) ?? null, description: (b.description as string) ?? null, city: (b.city as string) ?? null };
  }

  private requireStorage() {
    if (!this.storage.configured) throw new ServiceUnavailableException({ code: 'STORAGE_NOT_CONFIGURED', message: 'Media storage is not configured on this server' });
  }

  /** Creates the generation and takes its reservation in one transaction, then enqueues it. Rolls the reservation back if the queue is down. */
  private async create(tenant: TenantContext, data: Omit<Prisma.CreativeGenerationUncheckedCreateInput, 'businessId' | 'userId' | 'status' | 'periodStart' | 'queuedAt' | 'reservedUnits'>, key: string | undefined): Promise<{ generation: Full; replayed: boolean }> {
    let created: CreativeGeneration;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await lockTenantQuota(tx, 'creative', tenant.businessId);
        const inFlight = await tx.creativeGeneration.count({ where: { businessId: tenant.businessId, status: { in: ['QUEUED', 'RUNNING'] } } });
        if (inFlight >= this.env.CREATIVE_MAX_INFLIGHT_PER_BUSINESS) throw quotaExceeded('CREATIVE_QUEUE_LIMIT', `At most ${this.env.CREATIVE_MAX_INFLIGHT_PER_BUSINESS} image or video generations can be waiting or running at once.`);
        const periodStart = await this.usage.reserve(tx, { businessId: tenant.businessId, kind: data.unitKind as 'IMAGE' | 'VIDEO_SECOND', units: data.requestedUnits });
        return tx.creativeGeneration.create({ data: { ...data, businessId: tenant.businessId, userId: tenant.userId, status: 'QUEUED', periodStart, queuedAt: new Date(), reservedUnits: data.requestedUnits, idempotencyKey: key ?? null } });
      });
    } catch (err) {
      // Two identical requests raced: the loser returns the winner's generation.
      if (key && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.replay(tenant.businessId, key, data.requestHash as string);
        if (existing) return { generation: existing, replayed: true };
      }
      throw err;
    }
    try {
      await this.queue.enqueue(created.id);
    } catch (err) {
      await this.prisma.creativeGeneration.update({ where: { id: created.id }, data: { status: 'FAILED', errorCode: 'CREATIVE_QUEUE_UNAVAILABLE', errorMessage: 'The creative job queue was unavailable', completedAt: new Date() } });
      await this.usage.settle(created.id);
      throw err;
    }
    return { generation: (await this.getFull(tenant.businessId, created.id)) as Full, replayed: false };
  }

  // ─── Images ─────────────────────────────────────────────────────────────────

  async submitImage(tenant: TenantContext, dto: CreateImageDto, key?: string, parentId?: string | null) {
    const provider = this.image;
    if (!provider || !provider.isConfigured()) throw new ServiceUnavailableException({ code: 'IMAGE_NOT_CONFIGURED', message: 'Image generation is not configured on this server (no image provider credentials)' });
    const caps = provider.capabilities;
    if (dto.count > Math.min(CREATIVE_LIMITS.maxImagesPerRequest, caps.maxImagesPerRequest)) throw new BadRequestException({ code: 'TOO_MANY_IMAGES', message: `At most ${Math.min(CREATIVE_LIMITS.maxImagesPerRequest, caps.maxImagesPerRequest)} images per request` });
    const platform = dto.platform as CreativePlatform;
    if (platform !== 'ANY' && !PLATFORM_ASPECTS[platform].includes(dto.aspectRatio as AspectRatio)) {
      throw new BadRequestException({ code: 'ASPECT_NOT_SUITED', message: `${dto.aspectRatio} is not a good fit for ${platform}. Suggested: ${PLATFORM_ASPECTS[platform].join(', ')}` });
    }
    const hash = this.hashOf(tenant.businessId, 'IMAGE', { ...dto, parentId: parentId ?? null });
    const replayed = await this.replay(tenant.businessId, key, hash);
    if (replayed) return { generation: replayed, replayed: true };

    this.requireStorage();
    const storage = await this.media.usage(tenant.businessId);
    if (storage.usedBytes >= storage.quotaBytes) throw new HttpException({ code: 'STORAGE_QUOTA_EXCEEDED', message: 'Your storage quota is full. Delete files or ask for more storage before generating images.' }, 413);

    const ctx = (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
    const loaded = await this.loadItem(tenant, ctx, dto.itemType, dto.itemId);

    // Text on the image is the merchant's, but it must not state anything the verified data does not support.
    if (dto.overlayText) {
      const issues = checkGrounding({ caption: dto.overlayText }, ctx);
      if (issues.length) throw new HttpException({ code: 'OVERLAY_UNVERIFIED', message: 'The text on the image contains information that is not in your verified business data', issues }, 422);
    }

    // Preserving the original product.
    let preservation: ImageParams['preservation'] = 'NONE';
    let mode: ImageParams['mode'] = 'TEXT_TO_IMAGE';
    if (dto.sourceMediaId) {
      await this.media.assertUsable(tenant.businessId, [dto.sourceMediaId], 'IMAGE');
      if (dto.preservation === 'GUIDED') {
        if (!caps.edit) throw new BadRequestException({ code: 'EDIT_NOT_SUPPORTED', message: 'The configured image provider cannot edit photos' });
        preservation = 'GUIDED';
        mode = 'EDIT';
      } else {
        const src = await this.media.readOriginal(tenant.businessId, dto.sourceMediaId);
        const cutout = await extractProduct(src.data, this.env.MEDIA_MAX_IMAGE_PIXELS).catch(() => null);
        if (!cutout) {
          throw new HttpException(
            { code: 'PRODUCT_CUTOUT_FAILED', message: 'The product could not be separated from its background. Use a photo with a plain or transparent background, or choose the guided mode (the AI edits the photo; review the result against your original).' },
            422,
          );
        }
        preservation = 'EXACT';
        mode = 'SCENE_ONLY';
      }
    }
    if (dto.logoPlacement !== 'NONE') {
      const b = await this.prisma.business.findUniqueOrThrow({ where: { id: tenant.businessId }, select: { logo: { select: { id: true, deletedAt: true, status: true } } } });
      if (!b.logo || b.logo.deletedAt || b.logo.status !== 'READY') throw new BadRequestException({ code: 'NO_LOGO', message: 'Add your logo in the brand kit before placing it on images' });
    }

    const kit = dto.useBrandKit ? await this.brandKit.forPrompt(tenant.businessId) : null;
    const style = (dto.style ?? (kit?.visualStyle && (IMAGE_STYLES as readonly string[]).includes(kit.visualStyle) ? kit.visualStyle : 'PHOTOREALISTIC')) as ImageStyle;
    const { width, height } = dimensionsFor(dto.aspectRatio as AspectRatio, dto.resolution as Resolution);
    const params: ImageParams = {
      type: dto.type, style, aspectRatio: dto.aspectRatio as AspectRatio, resolution: dto.resolution as Resolution, width, height,
      background: dto.background, backgroundNote: dto.backgroundNote ?? null, theme: dto.theme, themeNote: dto.themeNote ?? null,
      overlayText: dto.overlayText ?? null, overlayPosition: dto.overlayPosition, logoPlacement: dto.logoPlacement, platform,
      preservation, mode, count: dto.count, useBrandKit: dto.useBrandKit, instructions: dto.instructions ?? null,
    };
    const prompt = buildImagePrompt({
      mode, business: this.bizPrompt(ctx), item: loaded?.prompt ?? null, type: dto.type as never, style, background: dto.background as never, backgroundNote: dto.backgroundNote,
      theme: dto.theme as never, themeNote: dto.themeNote, platform, aspect: params.aspectRatio, brand: this.promptBrand(kit), instructions: dto.instructions, hasOverlay: Boolean(dto.overlayText),
    });
    const result = await this.create(
      tenant,
      {
        kind: 'IMAGE', provider: provider.name, model: this.env.IMAGE_MODEL, prompt, params: params as unknown as Prisma.InputJsonValue, requestHash: hash,
        itemType: loaded?.item.type ?? null, itemId: loaded?.item.id ?? null, sourceMediaId: dto.sourceMediaId ?? null, parentId: parentId ?? null,
        brandSnapshot: (kit ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue, requestedUnits: dto.count, unitKind: 'IMAGE',
      },
      key,
    );
    if (!result.replayed) await this.audit.record({ action: 'creative.image_requested', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CreativeGeneration', entityId: result.generation.id, metadata: { count: dto.count, preservation, mode } });
    return result;
  }

  /** More variations of a finished generation: same settings and prompt, fresh results. */
  async variations(tenant: TenantContext, id: string, dto: VariationDto, key?: string) {
    const parent = await this.prisma.creativeGeneration.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!parent) throw new NotFoundException({ code: 'CREATIVE_NOT_FOUND', message: 'Generation not found' });
    if (parent.kind !== 'IMAGE') throw new BadRequestException({ code: 'NOT_AN_IMAGE', message: 'Variations are available for images' });
    if (parent.status === 'QUEUED' || parent.status === 'RUNNING') throw new ConflictException({ code: 'GENERATION_IN_PROGRESS', message: 'This generation is still running' });
    const p = parent.params as unknown as ImageParams;
    return this.submitImage(
      tenant,
      {
        type: p.type, style: p.style, aspectRatio: p.aspectRatio, resolution: p.resolution, background: p.background, backgroundNote: p.backgroundNote ?? undefined, theme: p.theme, themeNote: p.themeNote ?? undefined,
        overlayText: p.overlayText ?? undefined, overlayPosition: p.overlayPosition, logoPlacement: p.logoPlacement, platform: p.platform, itemType: (parent.itemType as Item['type'] | null) ?? undefined, itemId: parent.itemId ?? undefined,
        sourceMediaId: parent.sourceMediaId ?? undefined, preservation: p.preservation === 'GUIDED' ? 'GUIDED' : 'EXACT', count: dto.count, useBrandKit: p.useBrandKit, instructions: dto.instructions ?? p.instructions ?? undefined,
      },
      key,
      parent.id,
    );
  }

  // ─── Videos ─────────────────────────────────────────────────────────────────

  async submitVideo(tenant: TenantContext, dto: CreateVideoDto, key?: string) {
    const provider = this.video;
    if (!provider || !provider.isConfigured()) {
      throw new ServiceUnavailableException({ code: 'VIDEO_NOT_CONFIGURED', message: 'Video generation is not configured on this server. Storyboards and scripts are still available. See the provider configuration guide to enable video.' });
    }
    const caps = provider.capabilities;
    const format = dto.format as VideoFormat;
    const rule = VIDEO_FORMATS[format];
    if (dto.seconds < rule.minSeconds || dto.seconds > rule.maxSeconds) throw new BadRequestException({ code: 'VIDEO_LENGTH_INVALID', message: `${format} videos are ${rule.minSeconds}-${rule.maxSeconds} seconds` });
    if (!caps.sizes[rule.aspect]) throw new BadRequestException({ code: 'VIDEO_FORMAT_UNSUPPORTED', message: `The configured video provider does not render ${rule.aspect} videos` });
    const hash = this.hashOf(tenant.businessId, 'VIDEO', dto);
    const replayed = await this.replay(tenant.businessId, key, hash);
    if (replayed) return { generation: replayed, replayed: true };

    this.requireStorage();
    const storage = await this.media.usage(tenant.businessId);
    if (storage.usedBytes >= storage.quotaBytes) throw new HttpException({ code: 'STORAGE_QUOTA_EXCEEDED', message: 'Your storage quota is full.' }, 413);
    const seconds = snapSeconds(caps, dto.seconds);

    const ctx = (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
    const loaded = await this.loadItem(tenant, ctx, dto.itemType, dto.itemId);
    type Board = { title: string; concept: string; scenes: Array<{ order: number; durationSeconds: number; visual: string; camera: string | null }> };
    let storyboard: Board | null = null;
    if (dto.storyboardId) {
      const sb = await this.prisma.aIGeneration.findFirst({ where: { id: dto.storyboardId, businessId: tenant.businessId, task: 'STORYBOARD', status: 'SUCCEEDED' } });
      if (!sb) throw new NotFoundException({ code: 'STORYBOARD_NOT_FOUND', message: 'Storyboard not found' });
      const out = (sb.editedOutput ?? sb.output) as unknown as Board;
      if (dto.sceneOrder && !out.scenes.some((s) => s.order === dto.sceneOrder)) throw new BadRequestException({ code: 'SCENE_NOT_FOUND', message: 'That scene does not exist in the storyboard' });
      storyboard = out;
    } else if (dto.sceneOrder) throw new BadRequestException({ code: 'STORYBOARD_REQUIRED', message: 'sceneOrder needs a storyboard' });
    if (dto.sourceMediaId) {
      if (!caps.imageToVideo) throw new BadRequestException({ code: 'IMAGE_TO_VIDEO_UNSUPPORTED', message: 'The configured video provider cannot animate a photo' });
      await this.media.assertUsable(tenant.businessId, [dto.sourceMediaId], 'IMAGE');
    }
    const kit = dto.useBrandKit ? await this.brandKit.forPrompt(tenant.businessId) : null;
    const params: VideoParams = { format, aspectRatio: rule.aspect, requestedSeconds: dto.seconds, seconds, style: dto.style as VideoStyle, storyboardId: dto.storyboardId ?? null, sceneOrder: dto.sceneOrder ?? null, useBrandKit: dto.useBrandKit, instructions: dto.instructions ?? null };
    const prompt = buildVideoPrompt({ business: this.bizPrompt(ctx), item: loaded?.prompt ?? null, style: params.style, aspect: rule.aspect, seconds, brand: this.promptBrand(kit), instructions: dto.instructions, storyboard, sceneOrder: dto.sceneOrder ?? null });
    const result = await this.create(
      tenant,
      {
        kind: 'VIDEO', provider: provider.name, model: this.env.VIDEO_MODEL, prompt, params: params as unknown as Prisma.InputJsonValue, requestHash: hash,
        itemType: loaded?.item.type ?? null, itemId: loaded?.item.id ?? null, sourceMediaId: dto.sourceMediaId ?? null, parentId: null,
        brandSnapshot: (kit ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue, requestedUnits: seconds, unitKind: 'VIDEO_SECOND',
      },
      key,
    );
    if (!result.replayed) await this.audit.record({ action: 'creative.video_requested', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CreativeGeneration', entityId: result.generation.id, metadata: { seconds, format } });
    return result;
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  private getFull(businessId: string, id: string) {
    return this.prisma.creativeGeneration.findFirst({ where: { id, businessId }, include: { outputs: { include: { media: true }, orderBy: { index: 'asc' } } } });
  }

  async find(tenant: TenantContext, id: string): Promise<Full> {
    const g = await this.getFull(tenant.businessId, id);
    if (!g) throw new NotFoundException({ code: 'CREATIVE_NOT_FOUND', message: 'Generation not found' });
    return g as Full;
  }

  toDto(g: Full) {
    const price = this.usage.priceFor(g.model);
    return {
      id: g.id,
      kind: g.kind,
      status: g.status,
      retrying: g.status === 'QUEUED' && g.jobAttempts > 0,
      provider: g.provider,
      model: g.model,
      prompt: g.prompt,
      params: g.params,
      itemType: g.itemType,
      itemId: g.itemId,
      sourceMediaId: g.sourceMediaId,
      parentId: g.parentId,
      errorCode: g.errorCode,
      errorMessage: g.errorMessage,
      usage: { requestedUnits: g.requestedUnits, producedUnits: g.producedUnits, unitKind: g.unitKind, inputTokens: g.inputTokens, outputTokens: g.outputTokens, costUsd: Number(g.costUsd.toFixed(6)), costKnown: price.source === 'model', processingMs: g.processingMs },
      job: { attempts: g.jobAttempts, pollCount: g.pollCount, providerStatus: g.providerStatus, queuedAt: g.queuedAt, startedAt: g.startedAt, completedAt: g.completedAt },
      outputs: g.outputs.map((o) => ({
        id: o.id, index: o.index, width: o.width, height: o.height, preservation: o.preservation, upscaled: o.upscaled, selected: o.selected, revisedPrompt: o.revisedPrompt,
        media: this.media.toDto(o.media),
      })),
      createdAt: g.createdAt,
    };
  }

  statusDto(g: CreativeGeneration) {
    return {
      id: g.id, kind: g.kind, status: g.status, retrying: g.status === 'QUEUED' && g.jobAttempts > 0, final: g.status === 'SUCCEEDED' || g.status === 'FAILED', resultAvailable: g.status === 'SUCCEEDED',
      attempt: g.jobAttempts, maxAttempts: this.env.CREATIVE_JOB_ATTEMPTS, providerStatus: g.providerStatus, pollCount: g.pollCount,
      errorCode: g.errorCode, errorMessage: g.errorMessage, producedUnits: g.producedUnits, requestedUnits: g.requestedUnits, queuedAt: g.queuedAt, startedAt: g.startedAt, completedAt: g.completedAt,
    };
  }

  async list(tenant: TenantContext, q: CreativeQueryDto) {
    const where: Prisma.CreativeGenerationWhereInput = { businessId: tenant.businessId, ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status as never } : {}), ...(q.itemId ? { itemId: q.itemId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.creativeGeneration.findMany({ where, orderBy: { createdAt: 'desc' }, include: { outputs: { include: { media: true }, orderBy: { index: 'asc' } } }, ...pageArgs(q) }),
      this.prisma.creativeGeneration.count({ where }),
    ]);
    return toPage(rows.map((g) => this.toDto(g as Full)), total, q);
  }

  async status(tenant: TenantContext, id: string) {
    const g = await this.prisma.creativeGeneration.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!g) throw new NotFoundException({ code: 'CREATIVE_NOT_FOUND', message: 'Generation not found' });
    return this.statusDto(g);
  }

  /** Picks (or unpicks) the favourite among the variations of a generation. One favourite per generation. */
  async select(tenant: TenantContext, outputId: string, selected: boolean) {
    const o = await this.prisma.creativeOutput.findFirst({ where: { id: outputId, businessId: tenant.businessId } });
    if (!o) throw new NotFoundException({ code: 'OUTPUT_NOT_FOUND', message: 'Output not found' });
    await this.prisma.$transaction([
      this.prisma.creativeOutput.updateMany({ where: { generationId: o.generationId }, data: { selected: false } }),
      ...(selected ? [this.prisma.creativeOutput.update({ where: { id: o.id }, data: { selected: true } })] : []),
    ]);
    return this.toDto(await this.find(tenant, o.generationId));
  }

  /** Deletes a finished generation and its files (soft-delete, then the durable storage deletion queue). */
  async remove(tenant: TenantContext, id: string) {
    const g = await this.find(tenant, id);
    if (g.status === 'QUEUED' || g.status === 'RUNNING') throw new ConflictException({ code: 'GENERATION_IN_PROGRESS', message: 'Wait for the generation to finish before deleting it' });
    await this.media.removeGenerated(tenant.businessId, g.outputs.map((o) => o.mediaId), 'creative-delete');
    await this.prisma.creativeGeneration.delete({ where: { id } });
    await this.audit.record({ action: 'creative.deleted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CreativeGeneration', entityId: id });
  }
}
