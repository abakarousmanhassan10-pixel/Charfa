import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { checkContent, type GeneratedContent } from '@touma/ai-engine';
import { FORMAT_RULES, type AiFormat } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { AiHistoryService } from './ai-history.service';

/**
 * Human approval of AI content. Nothing AI-written is publishable until a person with `content.approve`
 * has approved the exact text (Content.version) that would be published:
 *
 *   DRAFT ──submit──► IN_REVIEW ──approve──► APPROVED          (editing the text returns to DRAFT)
 *                         └──────reject───► REJECTED (reason)
 *
 * Approval re-checks the text against the business data as it is NOW, so a draft that was edited to
 * contain an unsupported price, or whose facts changed since generation, cannot be approved.
 * Phase 5/7 publishing must call assertPublishable() before scheduling or publishing anything.
 */
@Injectable()
export class AiApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly history: AiHistoryService,
  ) {}

  private async load(tenant: TenantContext, generationId: string) {
    const g = await this.prisma.aIGeneration.findFirst({ where: { id: generationId, businessId: tenant.businessId } });
    if (!g) throw new NotFoundException({ code: 'GENERATION_NOT_FOUND', message: 'Generation not found' });
    if (!g.contentId) throw new BadRequestException({ code: 'NO_DRAFT', message: 'Save this generation as a draft first' });
    const content = await this.prisma.content.findFirst({ where: { id: g.contentId, businessId: tenant.businessId, deletedAt: null } });
    if (!content) throw new NotFoundException({ code: 'CONTENT_NOT_FOUND', message: 'Draft not found' });
    return { g, content };
  }

  private async respond(tenant: TenantContext, generationId: string) {
    return this.history.get(tenant, generationId);
  }

  async submitForReview(tenant: TenantContext, generationId: string) {
    const { content } = await this.load(tenant, generationId);
    if (content.status !== 'DRAFT' && content.status !== 'REJECTED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${content.status} draft cannot be submitted for review` });
    await this.prisma.content.update({ where: { id: content.id }, data: { status: 'IN_REVIEW', rejectionReason: null } });
    await this.audit.record({ action: 'ai.content_submitted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Content', entityId: content.id, metadata: { version: content.version } });
    return this.respond(tenant, generationId);
  }

  async approve(tenant: TenantContext, generationId: string) {
    const { g, content } = await this.load(tenant, generationId);
    if (content.status !== 'IN_REVIEW') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a draft that was submitted for review can be approved' });
    const body = (content.aiMetadata as { body?: GeneratedContent } | null)?.body;
    if (!body) throw new BadRequestException({ code: 'NO_DRAFT', message: 'The draft has no content to approve' });
    const format = g.format as AiFormat;
    const issues = [
      ...(await this.history.regroundContent(tenant, body)),
      ...checkContent(body, { format, platform: FORMAT_RULES[format].platform, language: g.language as never }).filter((i) => !i.startsWith('Content')),
    ];
    if (issues.length) {
      await this.audit.record({ action: 'ai.approval_blocked', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Content', entityId: content.id, metadata: { issues: issues.slice(0, 10) } });
      throw new UnprocessableEntityException({ code: 'APPROVAL_BLOCKED', message: 'This text contains information that is not in the verified business data', issues });
    }
    await this.prisma.content.update({ where: { id: content.id }, data: { status: 'APPROVED', approvedById: tenant.userId, approvedAt: new Date(), approvedVersion: content.version, rejectionReason: null } });
    await this.audit.record({ action: 'ai.content_approved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Content', entityId: content.id, metadata: { version: content.version, generationId } });
    return this.respond(tenant, generationId);
  }

  async reject(tenant: TenantContext, generationId: string, reason: string) {
    const { content } = await this.load(tenant, generationId);
    if (content.status !== 'IN_REVIEW') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a draft in review can be rejected' });
    await this.prisma.content.update({ where: { id: content.id }, data: { status: 'REJECTED', rejectionReason: reason, approvedById: null, approvedAt: null, approvedVersion: null } });
    await this.audit.record({ action: 'ai.content_rejected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Content', entityId: content.id, metadata: { version: content.version } });
    return this.respond(tenant, generationId);
  }

  /**
   * The publication gate. Throws unless this content may be published: AI-written or AI-assisted content
   * needs an approval that matches its current version. Publishing code must call this first.
   */
  async assertPublishable(businessId: string, contentId: string) {
    const c = await this.prisma.content.findFirst({ where: { id: contentId, businessId, deletedAt: null } });
    if (!c) throw new NotFoundException({ code: 'CONTENT_NOT_FOUND', message: 'Content not found' });
    if (c.origin === 'HUMAN') return c;
    const approved = c.status === 'APPROVED' && c.approvedById !== null && c.approvedVersion === c.version;
    if (!approved) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'AI-generated content must be approved by a person before it can be published' });
    return c;
  }
}
