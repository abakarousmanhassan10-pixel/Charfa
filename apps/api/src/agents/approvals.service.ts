import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RunsService } from '../runs/runs.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { checkDraft } from './agent-runner';
import { contentHash } from './tool-registry';

const conflict = (code: string, message: string) => new ConflictException({ code, message });
const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Approval not found' });

type Row = NonNullable<Awaited<ReturnType<PrismaService['agentApproval']['findFirst']>>>;

/**
 * The approval queue for what agents prepare. An approval is: one exact content version (its hash) + one channel + one use. It is valid only while the
 * content is unchanged: any edit supersedes it and a new approval is needed; approving needs the hash the reviewer saw; publishing consumes it.
 * No agent and no browser event can approve: this is a human decision through a permission-checked API (agents.approve).
 */
@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService, private readonly runs: RunsService, private readonly audit: AuditService) {}

  private async view(a: Row) {
    const c = await this.prisma.content.findFirst({ where: { id: a.contentId, businessId: a.businessId, deletedAt: null }, select: { title: true, caption: true, hashtags: true, callToAction: true, targetPlatforms: true, version: true, status: true } });
    const current = c ? contentHash({ title: c.title, body: c.caption, hashtags: c.hashtags, platform: a.channel }) : null;
    return {
      id: a.id, runId: a.runId, stepKey: a.stepKey, agentId: a.agentId, contentId: a.contentId, channel: a.channel, status: a.status, contentHash: a.contentHash, createdAt: a.createdAt, expiresAt: a.expiresAt, decidedAt: a.decidedAt, consumedAt: a.consumedAt,
      /** false = the content was edited after this approval was requested: it can no longer be approved or used. */
      upToDate: current === a.contentHash,
      content: c ? { title: c.title, body: c.caption, hashtags: c.hashtags, callToAction: c.callToAction, version: c.version, checks: checkDraft({ title: c.title ?? '', body: c.caption ?? '', callToAction: c.callToAction ?? undefined }) } : null,
    };
  }

  async list(t: TenantContext, status?: string) {
    const rows = await this.prisma.agentApproval.findMany({ where: { businessId: t.businessId, ...(status ? { status: status as never } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  private async find(t: TenantContext, id: string) {
    const a = await this.prisma.agentApproval.findFirst({ where: { id, businessId: t.businessId } });
    if (!a) throw notFound();
    return a;
  }

  async get(t: TenantContext, id: string) {
    return this.view(await this.find(t, id));
  }

  /** The reviewer approves the version they saw (`expectedHash`). A changed content, a used, rejected or expired approval is refused. */
  async approve(t: TenantContext, id: string, expectedHash: string) {
    const a = await this.find(t, id);
    if (a.status !== 'PENDING') throw conflict('APPROVAL_NOT_PENDING', `This approval is ${a.status.toLowerCase()}`);
    if (a.expiresAt < new Date()) { await this.prisma.agentApproval.updateMany({ where: { id: a.id, status: 'PENDING' }, data: { status: 'EXPIRED' } }); throw conflict('APPROVAL_EXPIRED', 'This approval expired: ask for a new one'); }
    const v = await this.view(a);
    if (!v.upToDate) {
      await this.prisma.agentApproval.updateMany({ where: { id: a.id, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
      throw conflict('CONTENT_CHANGED', 'The content was changed after the approval was requested: review the new version');
    }
    if (expectedHash !== a.contentHash) throw conflict('CONTENT_CHANGED', 'You approved a different version than the one now waiting: review it again');
    const now = new Date();
    const res = await this.prisma.agentApproval.updateMany({ where: { id: a.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedById: t.userId, decidedAt: now } });
    if (!res.count) throw conflict('APPROVAL_NOT_PENDING', 'This approval was just decided');
    // Mirrors the content approval of the publication engine: bound to the exact content version.
    await this.prisma.content.updateMany({ where: { id: a.contentId, businessId: a.businessId }, data: { status: 'APPROVED', approvedById: t.userId, approvedAt: now, approvedVersion: v.content?.version ?? null } });
    await this.audit.record({ action: 'agents.approval_approved', actorId: t.userId, businessId: t.businessId, entityType: 'AgentApproval', entityId: a.id, metadata: { runId: a.runId, channel: a.channel } });
    await this.releaseStep(t, a);
    return this.get(t, a.id);
  }

  async reject(t: TenantContext, id: string) {
    const a = await this.find(t, id);
    const res = await this.prisma.agentApproval.updateMany({ where: { id: a.id, status: 'PENDING' }, data: { status: 'REJECTED', decidedById: t.userId, decidedAt: new Date() } });
    if (!res.count) throw conflict('APPROVAL_NOT_PENDING', 'This approval is not pending');
    await this.prisma.content.updateMany({ where: { id: a.contentId, businessId: a.businessId }, data: { status: 'REJECTED' } });
    await this.audit.record({ action: 'agents.approval_rejected', actorId: t.userId, businessId: t.businessId, entityType: 'AgentApproval', entityId: a.id, metadata: { runId: a.runId } });
    await this.runs.reject(t, a.runId, a.stepKey).catch(() => undefined);
    return this.get(t, a.id);
  }

  /**
   * The reviewer edits the draft. The old approval is superseded and a NEW one is created for the new version: nothing approved earlier can be used for it.
   */
  async modify(t: TenantContext, id: string, patch: { title?: string; body?: string; hashtags?: string[] }) {
    const a = await this.find(t, id);
    if (!['PENDING', 'APPROVED'].includes(a.status)) throw conflict('APPROVAL_NOT_MODIFIABLE', `This approval is ${a.status.toLowerCase()}`);
    const c = await this.prisma.content.findFirst({ where: { id: a.contentId, businessId: a.businessId, deletedAt: null } });
    if (!c) throw notFound();
    const next = { title: patch.title ?? c.title ?? '', body: patch.body ?? c.caption ?? '', hashtags: patch.hashtags ?? c.hashtags };
    const checks = checkDraft({ title: next.title, body: next.body });
    if (!checks.passed) throw conflict('DRAFT_CHECKS_FAILED', `The edited draft did not pass the checks: ${checks.issues.join(', ')}`);
    const hash = contentHash({ title: next.title, body: next.body, hashtags: next.hashtags, platform: a.channel });
    if (hash === a.contentHash) return this.get(t, a.id);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.content.update({ where: { id: c.id }, data: { title: next.title, caption: next.body, hashtags: next.hashtags, status: 'IN_REVIEW', approvedById: null, approvedAt: null, approvedVersion: null, version: { increment: 1 } } });
      await tx.agentApproval.updateMany({ where: { runId: a.runId, stepKey: a.stepKey, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'SUPERSEDED' } });
      return tx.agentApproval.create({ data: { businessId: a.businessId, runId: a.runId, stepKey: a.stepKey, agentId: a.agentId, contentId: a.contentId, channel: a.channel, contentHash: hash, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    });
    // The step decision taken for the old version no longer holds.
    await this.prisma.agentRunStep.updateMany({ where: { runId: a.runId, key: a.stepKey, status: 'PENDING', approvalDecision: 'APPROVED' }, data: { approvalDecision: null, decidedById: null, decidedAt: null, status: 'WAITING_APPROVAL' } });
    await this.audit.record({ action: 'agents.approval_superseded', actorId: t.userId, businessId: t.businessId, entityType: 'AgentApproval', entityId: a.id, metadata: { newApprovalId: created.id } });
    return this.view(created);
  }

  /** Lets the held publication step of the run proceed (the step waits for the human decision of the run engine). */
  private async releaseStep(t: TenantContext, a: Row) {
    try {
      await this.runs.approve(t, a.runId, a.stepKey);
    } catch {
      // The run has not reached the step yet: record the decision so the engine does not hold it.
      await this.prisma.agentRunStep.updateMany({ where: { runId: a.runId, key: a.stepKey, businessId: t.businessId, status: { in: ['PENDING', 'WAITING_APPROVAL'] } }, data: { approvalDecision: 'APPROVED', decidedById: t.userId, decidedAt: new Date(), status: 'PENDING' } });
    }
  }
}
