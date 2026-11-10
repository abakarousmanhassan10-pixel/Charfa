import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AIGeneration, type ContentType } from '@touma/database';
import { checkContent, contentSchema, type GeneratedContent } from '@touma/ai-engine';
import { FORMAT_RULES, type AiFormat } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import type { GenerationQueryDto } from './ai.dto';
import type { StepReport } from './orchestrator.service';

const CONTENT_TYPE: Partial<Record<AiFormat, ContentType>> = {
  INSTAGRAM_CAROUSEL: 'CAROUSEL',
  INSTAGRAM_REEL_SCRIPT: 'VIDEO',
  TIKTOK_VIDEO_SCRIPT: 'VIDEO',
  YOUTUBE_VIDEO: 'VIDEO',
  YOUTUBE_SHORTS_SCRIPT: 'VIDEO',
  INSTAGRAM_STORY: 'IMAGE',
};

export function generationDto(g: AIGeneration, steps?: StepReport[]) {
  return {
    id: g.id,
    task: g.task,
    status: g.status,
    itemType: g.itemType,
    itemId: g.itemId,
    platform: g.platform,
    format: g.format,
    language: g.language,
    tone: g.tone,
    purpose: g.purpose,
    instructions: g.instructions,
    output: g.editedOutput ?? g.output,
    originalOutput: g.output,
    edited: g.editedOutput !== null,
    errorCode: g.errorCode,
    errorMessage: g.errorMessage,
    provider: g.provider,
    model: g.model,
    promptVersion: g.promptVersion,
    injectionFlags: g.injectionFlags,
    usage: { inputTokens: g.inputTokens, outputTokens: g.outputTokens, costUsd: Number(g.costUsd.toFixed(6)), latencyMs: g.latencyMs, attempts: g.attempts },
    parentId: g.parentId,
    contentId: g.contentId,
    createdAt: g.createdAt,
    ...(steps ? { steps } : {}),
  };
}

@Injectable()
export class AiHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext, q: GenerationQueryDto) {
    const where: Prisma.AIGenerationWhereInput = {
      businessId: tenant.businessId,
      ...(q.task ? { task: q.task as never } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.itemId ? { itemId: q.itemId } : {}),
      ...(q.q ? { OR: [{ instructions: { contains: q.q, mode: 'insensitive' } }, { format: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.aIGeneration.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.aIGeneration.count({ where }),
    ]);
    return toPage(rows.map((g) => generationDto(g)), total, q);
  }

  async find(tenant: TenantContext, id: string) {
    const g = await this.prisma.aIGeneration.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!g) throw new NotFoundException({ code: 'GENERATION_NOT_FOUND', message: 'Generation not found' });
    return g;
  }

  async get(tenant: TenantContext, id: string) {
    return generationDto(await this.find(tenant, id));
  }

  async latest(tenant: TenantContext, task: 'BUSINESS_ANALYSIS' | 'PRODUCT_ANALYSIS' | 'MARKETING_STRATEGY', itemId?: string) {
    const g = await this.prisma.aIGeneration.findFirst({
      where: { businessId: tenant.businessId, task, status: 'SUCCEEDED', ...(itemId ? { itemId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return g ? generationDto(g) : null;
  }

  /**
   * Saves (or updates) a CONTENT generation as a DRAFT content item. Human edits are validated
   * against the same schema and platform limits; the original AI output is kept unchanged.
   * Nothing is published: drafts go through review/approval in later phases.
   */
  async saveDraft(tenant: TenantContext, id: string, edited?: Record<string, unknown>) {
    const g = await this.find(tenant, id);
    if (g.task !== 'CONTENT' || g.status !== 'SUCCEEDED') throw new BadRequestException({ code: 'NOT_DRAFTABLE', message: 'Only successful content generations can be saved as drafts' });
    const format = g.format as AiFormat;
    let output = g.output as unknown as GeneratedContent;
    if (edited) {
      const parsed = contentSchema.safeParse(edited);
      if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION', message: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
      const issues = checkContent(parsed.data, { format, platform: FORMAT_RULES[format].platform, language: g.language as never }).filter((i) => !i.startsWith('Content'));
      if (issues.length) throw new BadRequestException({ code: 'VALIDATION', message: issues });
      output = parsed.data;
    }
    const data = {
      type: CONTENT_TYPE[format] ?? 'TEXT',
      title: output.title ?? output.hook ?? null,
      caption: output.caption ?? output.description ?? null,
      language: g.language,
      hashtags: output.hashtags,
      callToAction: output.callToAction,
      targetPlatforms: output.platform ? [output.platform] : [],
      origin: edited ? ('AI_ASSISTED' as const) : ('AI_GENERATED' as const),
      productId: g.itemType === 'PRODUCT' ? g.itemId : null,
      serviceId: g.itemType === 'SERVICE' ? g.itemId : null,
      aiMetadata: { generationId: g.id, format, promptVersion: g.promptVersion, model: g.model, body: output } as Prisma.InputJsonValue,
    };
    const content = g.contentId
      ? await this.prisma.content.update({ where: { id: g.contentId }, data: { ...data, version: { increment: 1 } } })
      : await this.prisma.content.create({ data: { ...data, businessId: tenant.businessId, status: 'DRAFT', createdById: tenant.userId } });
    const updated = await this.prisma.aIGeneration.update({
      where: { id: g.id },
      data: { contentId: content.id, editedOutput: edited ? (output as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    await this.audit.record({ action: 'ai.draft_saved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Content', entityId: content.id, metadata: { generationId: g.id, edited: Boolean(edited) } });
    return { generation: generationDto(updated), content: { id: content.id, status: content.status, origin: content.origin, version: content.version } };
  }
}
