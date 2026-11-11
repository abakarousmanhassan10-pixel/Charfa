import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AIGeneration, type ContentType } from '@touma/database';
import { assessGrounding, checkContent, checkGrounding, contentSchema, type BusinessContext, type GeneratedContent } from '@touma/ai-engine';
import { FORMAT_RULES, type AiFormat } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import type { GenerationQueryDto } from './ai.dto';
import { KnowledgeService } from '../knowledge/knowledge.service';
import type { StepReport } from './orchestrator.service';

const CONTENT_TYPE: Partial<Record<AiFormat, ContentType>> = {
  INSTAGRAM_CAROUSEL: 'CAROUSEL',
  INSTAGRAM_REEL_SCRIPT: 'VIDEO',
  TIKTOK_VIDEO_SCRIPT: 'VIDEO',
  YOUTUBE_VIDEO: 'VIDEO',
  YOUTUBE_SHORTS_SCRIPT: 'VIDEO',
  INSTAGRAM_STORY: 'IMAGE',
};

type ContentInfo = { id: string; status: string; version: number; approvedVersion: number | null; rejectionReason: string | null; approvedAt: Date | null } | null;

export function generationDto(g: AIGeneration & { content?: ContentInfo }, steps?: StepReport[]) {
  const content = g.content ?? null;
  return {
    id: g.id,
    task: g.task,
    status: g.status,
    /** true while the queue is waiting to retry after a transient provider failure */
    retrying: g.status === 'QUEUED' && g.jobAttempts > 0,
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
    job: { attempts: g.jobAttempts, queuedAt: g.queuedAt, startedAt: g.startedAt, completedAt: g.completedAt },
    quality: g.quality,
    parentId: g.parentId,
    contentId: g.contentId,
    content: content ? { id: content.id, status: content.status, version: content.version, approved: content.status === 'APPROVED' && content.approvedVersion === content.version, rejectionReason: content.rejectionReason, approvedAt: content.approvedAt } : null,
    createdAt: g.createdAt,
    steps: steps ?? ((g.steps as unknown as StepReport[] | null) ?? []),
  };
}

/** Lightweight status for polling: no output payload. */
export function statusDto(g: AIGeneration, maxJobAttempts: number) {
  return {
    id: g.id,
    task: g.task,
    status: g.status,
    retrying: g.status === 'QUEUED' && g.jobAttempts > 0,
    final: g.status === 'SUCCEEDED' || g.status === 'FAILED' || g.status === 'BLOCKED',
    resultAvailable: g.status === 'SUCCEEDED',
    attempt: g.jobAttempts,
    maxAttempts: maxJobAttempts,
    errorCode: g.errorCode,
    errorMessage: g.errorMessage,
    steps: (g.steps as unknown as StepReport[] | null) ?? [],
    queuedAt: g.queuedAt,
    startedAt: g.startedAt,
    completedAt: g.completedAt,
    usage: { inputTokens: g.inputTokens, outputTokens: g.outputTokens, costUsd: Number(g.costUsd.toFixed(6)) },
  };
}

const CONTENT_SELECT = { select: { id: true, status: true, version: true, approvedVersion: true, rejectionReason: true, approvedAt: true } } as const;

@Injectable()
export class AiHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly knowledge: KnowledgeService,
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
      this.prisma.aIGeneration.findMany({ where, orderBy: { createdAt: 'desc' }, include: { content: CONTENT_SELECT }, ...pageArgs(q) }),
      this.prisma.aIGeneration.count({ where }),
    ]);
    return toPage(rows.map((g) => generationDto(g)), total, q);
  }

  async find(tenant: TenantContext, id: string) {
    const g = await this.prisma.aIGeneration.findFirst({ where: { id, businessId: tenant.businessId }, include: { content: CONTENT_SELECT } });
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
      include: { content: CONTENT_SELECT },
    });
    return g ? generationDto(g) : null;
  }

  /**
   * Saves (or updates) a CONTENT generation as a DRAFT content item. Human edits are validated
   * against the same schema and platform limits and are checked against the verified business data:
   * unsupported facts do not block saving (it is the merchant's draft), but they are recorded in the
   * quality report and block approval until the text is corrected or the fact is added to the verified
   * knowledge base. The original AI output is kept unchanged.
   *
   * Changing the text of a draft that is in review, approved or rejected sends it back to DRAFT and
   * clears the approval: a human approves exactly the text that may be published.
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
    const existing = g.contentId ? await this.prisma.content.findUnique({ where: { id: g.contentId } }) : null;
    const previousBody = (existing?.aiMetadata as { body?: unknown } | null)?.body;
    if (existing && JSON.stringify(previousBody) === JSON.stringify(output)) {
      // Nothing changed: keep the version and any approval.
      return { generation: generationDto(g), content: { id: existing.id, status: existing.status, origin: existing.origin, version: existing.version, quality: (existing.aiMetadata as { quality?: unknown })?.quality ?? null } };
    }
    const ctx = (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
    const quality = assessGrounding(output, ctx);
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
      aiMetadata: { generationId: g.id, format, promptVersion: g.promptVersion, model: g.model, body: output, quality } as unknown as Prisma.InputJsonValue,
    };
    const content = existing
      ? await this.prisma.content.update({
          where: { id: existing.id },
          // A new text always needs a new human decision.
          data: { ...data, version: { increment: 1 }, status: 'DRAFT', approvedById: null, approvedAt: null, approvedVersion: null, rejectionReason: null },
        })
      : await this.prisma.content.create({ data: { ...data, businessId: tenant.businessId, status: 'DRAFT', createdById: tenant.userId } });
    const updated = await this.prisma.aIGeneration.update({
      where: { id: g.id },
      data: { contentId: content.id, editedOutput: edited ? (output as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
      include: { content: CONTENT_SELECT },
    });
    await this.audit.record({
      action: 'ai.draft_saved',
      actorId: tenant.userId,
      businessId: tenant.businessId,
      entityType: 'Content',
      entityId: content.id,
      metadata: { generationId: g.id, edited: Boolean(edited), groundingIssues: quality.issues.length, approvalReset: Boolean(existing && existing.status !== 'DRAFT') },
    });
    return { generation: generationDto(updated), content: { id: content.id, status: content.status, origin: content.origin, version: content.version, quality } };
  }

  /** Facts of a draft checked against the CURRENT verified data (used before approval). */
  async regroundContent(tenant: TenantContext, body: GeneratedContent) {
    const ctx = (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
    return checkGrounding(body, ctx);
  }
}
