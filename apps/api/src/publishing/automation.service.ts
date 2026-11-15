import { ConflictException, HttpException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { checkGrounding, type BusinessContext } from '@touma/ai-engine';
import { Prisma, type PublishingPolicy } from '@touma/database';
import { checkTikTokSettings, classifyPublication, CONSENT_VERSION, localDayRange, roleHasPermission, utcToZoned, type Classification, type ContentKind, type HoursWindow } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { CalendarService } from '../calendar/calendar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PublishingPolicyService } from './policy.service';

const REEVALUABLE = ['BLOCKED', 'QUEUED', 'DEFERRED', 'AWAITING_PLATFORM_CONFIRMATION'];
const STALE_PROCESSING_MS = 5 * 60_000;
const errCode = (e: unknown): { code: string; message: string } => {
  if (e instanceof HttpException) { const r = e.getResponse() as { code?: string; message?: string }; return { code: r.code ?? 'ERROR', message: String(r.message ?? e.message).slice(0, 300) }; }
  return { code: 'ERROR', message: (e as Error).message.slice(0, 300) };
};

/**
 * The automatic publishing pipeline (N21): classify -> check the policy, quotas and platform rules -> hand the post to the SAME calendar approval and
 * authorization flow a person uses (so every existing guarantee applies: versioned approval, snapshot hash, publication gate before every attempt).
 * The policy never publishes anything itself and never lowers a rule: it can only take the steps a person with the consent on file would take.
 */
@Injectable()
export class PublishingAutomationService {
  private readonly logger = new Logger('PublishingAutomation');
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly policies: PublishingPolicyService,
    private readonly knowledge: KnowledgeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  private entry(businessId: string, id: string) {
    return this.prisma.calendarEvent.findFirst({ where: { id, businessId, deletedAt: null }, include: { content: { include: { media: { select: { mediaId: true, position: true }, orderBy: { position: 'asc' } } } } } });
  }

  /** The person whose consent the policy runs under, and only while they are still allowed to approve and schedule. */
  private async grantor(policy: PublishingPolicy): Promise<TenantContext | null> {
    if (!policy.consentGrantedById) return null;
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: policy.consentGrantedById, businessId: policy.businessId } } });
    if (!m || m.status !== 'ACTIVE' || !roleHasPermission(m.role, 'publication.schedule') || !roleHasPermission(m.role, 'content.approve')) return null;
    return { businessId: policy.businessId, membershipId: m.id, role: m.role, userId: m.userId };
  }

  private async postsThatDay(businessId: string, accountId: string, platform: string, at: Date, tz: string, exceptEntryId: string) {
    const { start, end } = localDayRange(utcToZoned(at, tz).date, tz);
    return this.prisma.calendarEvent.count({ where: { businessId, platform: platform as never, id: { not: exceptEntryId }, deletedAt: null, scheduledAt: { gte: start, lt: end }, OR: [{ authorizedAccountId: accountId }, { socialAccountId: accountId }], content: { status: { in: ['SCHEDULED', 'PUBLISHING', 'PUBLISHED'] } } } });
  }

  /** Why this post would or would not be published, without changing anything. */
  async classify(businessId: string, entryId: string, policy: PublishingPolicy | null, accountId: string | null): Promise<{ classification: Classification; policyActive: boolean }> {
    const e = await this.entry(businessId, entryId);
    if (!e || !e.content) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
    const c = e.content;
    const tz = policy?.timezone ?? e.timezone;
    const account = accountId ? await this.prisma.socialAccount.findFirst({ where: { id: accountId, businessId, deletedAt: null }, select: { status: true } }) : null;
    const active = !!policy && account?.status === 'CONNECTED' && policy.automationEnabled && !policy.pausedAt && !policy.consentRevokedAt && !!policy.consentGrantedAt && policy.consentVersion === CONSENT_VERSION && policy.mode !== 'MANUAL';
    let groundingIssues = 0;
    if (c.origin !== 'HUMAN') {
      const ctx = (await this.knowledge.buildAgentContext({ businessId } as TenantContext)) as unknown as BusinessContext;
      groundingIssues = checkGrounding({ title: c.title, caption: c.caption, hashtags: c.hashtags, callToAction: c.callToAction }, ctx).length;
    }
    const tiktok = e.platform === 'TIKTOK' ? checkTikTokSettings((c.platformOptions as { tiktok?: unknown } | null)?.tiktok, c.type as never) : null;
    const tiktokConfirmed = !!tiktok?.ok && !!((c.platformOptions as { tiktok?: { confirmedById?: string } } | null)?.tiktok?.confirmedById);
    const needsConfirmation = (policy?.requiresPlatformConfirmation ?? false) || (e.platform === 'TIKTOK' && !tiktokConfirmed);
    const classification = classifyPublication({
      mode: active ? policy!.mode : 'MANUAL', platform: e.platform ?? 'UNKNOWN', contentKind: c.type as ContentKind, title: c.title, caption: c.caption, hashtags: c.hashtags, callToAction: c.callToAction, groundingIssues,
      allowedContentTypes: policy?.allowedContentTypes ?? [c.type], scheduledAt: e.scheduledAt, timezone: tz, hours: ((policy?.allowedPublishingHours as unknown as HoursWindow[] | undefined) ?? [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' }]),
      postsThatDay: accountId ? await this.postsThatDay(businessId, accountId, e.platform ?? '', e.scheduledAt, tz, e.id) : 0, maxPostsPerDay: policy?.maximumPostsPerDay ?? 1000, platformConfirmationMissing: needsConfirmation,
    });
    return { classification, policyActive: active };
  }

  /**
   * Evaluates one entry once per content version. Safe to call twice and from several workers: the decision row (unique per entry and version) is claimed
   * before anything happens, so nothing is submitted, approved or scheduled twice.
   */
  async process(t: TenantContext, entryId: string) {
    const e0 = await this.entry(t.businessId, entryId);
    if (!e0 || !e0.content) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
    const version = e0.content.version;
    const claimed = await this.claim(t.businessId, e0.id, e0.content.id, version, e0.platform);
    if (!claimed) return this.decisionOf(t.businessId, e0.id, version);
    try {
      return await this.run(t, e0.id, version);
    } catch (e) {
      const err = errCode(e);
      await this.finish(claimed, 'DEFERRED', { reasons: [{ code: err.code, severity: 'soft', message: err.message }] });
      this.logger.warn(`entry ${entryId} deferred: ${err.code}`);
      return this.decisionOf(t.businessId, e0.id, version);
    }
  }

  private async claim(businessId: string, entryId: string, contentId: string, version: number, platform: string | null): Promise<string | null> {
    try {
      const d = await this.prisma.publishingDecision.create({ data: { businessId, calendarEventId: entryId, contentId, contentVersion: version, platform: platform as never, mode: 'MANUAL', risk: 'REVIEW_REQUIRED', reasons: [], action: 'PROCESSING' } });
      return d.id;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    // Someone else decided or is deciding. Only an undecided or fixable state, or a crashed attempt, can be taken over.
    const stale = new Date(Date.now() - STALE_PROCESSING_MS);
    const res = await this.prisma.publishingDecision.updateMany({ where: { calendarEventId: entryId, contentVersion: version, OR: [{ action: { in: REEVALUABLE } }, { action: 'PROCESSING', updatedAt: { lt: stale } }] }, data: { action: 'PROCESSING' } });
    if (!res.count) return null;
    return (await this.prisma.publishingDecision.findUniqueOrThrow({ where: { calendarEventId_contentVersion: { calendarEventId: entryId, contentVersion: version } } })).id;
  }

  private decisionOf(businessId: string, entryId: string, version: number) {
    return this.prisma.publishingDecision.findFirstOrThrow({ where: { businessId, calendarEventId: entryId, contentVersion: version } });
  }

  private finish(id: string, action: string, o: { mode?: PublishingPolicy['mode']; risk?: 'LOW_RISK' | 'REVIEW_REQUIRED' | 'BLOCKED'; reasons?: unknown[]; policyId?: string | null; accountId?: string | null; automated?: boolean; snapshotHash?: string | null; approvedById?: string | null; validUntil?: Date | null } = {}) {
    return this.prisma.publishingDecision.update({
      where: { id },
      data: { action, ...(o.mode ? { mode: o.mode } : {}), ...(o.risk ? { risk: o.risk } : {}), ...(o.reasons ? { reasons: o.reasons as Prisma.InputJsonArray } : {}), policyId: o.policyId ?? undefined, socialAccountId: o.accountId ?? undefined, automated: o.automated ?? false, snapshotHash: o.snapshotHash ?? undefined, approvedById: o.approvedById ?? undefined, approvedAt: o.approvedById ? new Date() : undefined, validUntil: o.validUntil ?? undefined },
    });
  }

  private async run(t: TenantContext, entryId: string, version: number) {
    const e = (await this.entry(t.businessId, entryId))!;
    const c = e.content!;
    const dec = await this.decisionOf(t.businessId, entryId, version);
    const accountId = await this.calendar.targetAccountId(this.prisma, e as never);
    const policy = accountId ? await this.policies.find(accountId) : null;
    const { classification, policyActive } = await this.classify(t.businessId, entryId, policy, accountId);
    const base = { mode: policyActive ? policy!.mode : ('MANUAL' as const), risk: classification.risk, reasons: classification.reasons, policyId: policy?.id ?? null, accountId };
    const log = (type: string, data: Record<string, unknown> = {}) => this.policies.event(t.businessId, type, { accountId, entryId, actorId: t.userId, data: { version, risk: classification.risk, reasons: classification.reasons.map((r) => r.code), ...data } });

    if (classification.risk === 'BLOCKED') {
      await this.finish(dec.id, 'BLOCKED', base);
      await log('BLOCKED');
      return this.decisionOf(t.businessId, entryId, version);
    }
    const status = c.status;
    const grantorEarly = policyActive ? await this.grantor(policy!) : null;
    // Resume after a crash: the policy had already taken some of the steps under the same consent. Nothing is repeated.
    if (grantorEarly && classification.risk === 'LOW_RISK' && ((status === 'SCHEDULED' && e.authorizedById === grantorEarly.userId) || (status === 'APPROVED' && c.approvedById === grantorEarly.userId))) {
      if (status === 'APPROVED') await this.calendar.authorize(grantorEarly, entryId, false);
      const fresh = (await this.entry(t.businessId, entryId))!;
      const validUntil = new Date(e.scheduledAt.getTime() + this.env.AUTOPUBLISH_APPROVAL_GRACE_MINUTES * 60_000);
      await this.finish(dec.id, 'AUTO_SCHEDULED', { ...base, automated: true, snapshotHash: fresh.authorizedHash, approvedById: grantorEarly.userId, validUntil });
      await log('AUTO_SCHEDULED', { resumed: true, validUntil: validUntil.toISOString() });
      return this.decisionOf(t.businessId, entryId, version);
    }
    if (!['DRAFT', 'REJECTED', 'IN_REVIEW'].includes(status)) {
      await this.finish(dec.id, 'DEFERRED', { ...base, reasons: [...classification.reasons, { code: 'ALREADY_IN_FLOW', severity: 'soft', message: `The entry is already ${status}` }] });
      return this.decisionOf(t.businessId, entryId, version);
    }
    const grantor = policyActive ? await this.grantor(policy!) : null;
    const lowRisk = classification.risk === 'LOW_RISK' && policyActive && !!grantor && status !== 'IN_REVIEW';
    const platformConfirmation = classification.reasons.some((r) => r.code === 'PLATFORM_CONFIRMATION');
    if (platformConfirmation) {
      // The platform needs a person's choices for this post (for example TikTok's posting settings): automation stops and asks. Nothing is submitted.
      await this.finish(dec.id, 'AWAITING_PLATFORM_CONFIRMATION', { ...base, risk: 'REVIEW_REQUIRED' });
      await log('AWAITING_PLATFORM_CONFIRMATION');
      await this.notifyApprovers(t.businessId, entryId, e.title);
      return this.decisionOf(t.businessId, entryId, version);
    }
    if (status !== 'IN_REVIEW') await this.calendar.submit(lowRisk ? grantor! : t, entryId);
    if (!lowRisk) {
      await this.finish(dec.id, 'SENT_TO_REVIEW', { ...base, risk: 'REVIEW_REQUIRED' });
      await log('SENT_TO_REVIEW');
      return this.decisionOf(t.businessId, entryId, version);
    }
    // LOW_RISK under an active policy: take the same steps the consenting person would take, as that person.
    await this.calendar.approve(grantor!, entryId, `Approved by the publishing policy (${policy!.mode}) under the consent of ${grantor!.userId}`);
    const authorized = (await this.calendar.authorize(grantor!, entryId, false)) as unknown as { authorizedHash?: string };
    const fresh = (await this.entry(t.businessId, entryId))!;
    const validUntil = new Date(e.scheduledAt.getTime() + this.env.AUTOPUBLISH_APPROVAL_GRACE_MINUTES * 60_000);
    await this.finish(dec.id, 'AUTO_SCHEDULED', { ...base, automated: true, snapshotHash: fresh.authorizedHash ?? authorized.authorizedHash ?? null, approvedById: grantor!.userId, validUntil });
    await this.audit.record({ action: 'publishing.auto_scheduled', actorId: grantor!.userId, businessId: t.businessId, entityType: 'CalendarEvent', entityId: entryId, metadata: { version, accountId, mode: policy!.mode } });
    await log('AUTO_SCHEDULED', { scheduledAt: e.scheduledAt.toISOString(), validUntil: validUntil.toISOString() });
    return this.decisionOf(t.businessId, entryId, version);
  }

  private async notifyApprovers(businessId: string, entryId: string, title: string) {
    await this.notifications.notify({ businessId, permission: 'content.approve', type: 'publishing.confirmation_needed', title: `Confirmation needed: ${title}`, data: { entryId }, dedupeKey: `publishing-confirm:${entryId}` });
  }

  /** A person approves what the policy sent to review: same approval and authorization as always, tied to this exact version, account, time and a validity window. */
  async approveReview(t: TenantContext, entryId: string) {
    if (!roleHasPermission(t.role, 'content.approve') || !roleHasPermission(t.role, 'publication.schedule')) throw new HttpException({ code: 'FORBIDDEN', message: 'Approving and scheduling a publication needs both permissions' }, 403);
    const e = await this.entry(t.businessId, entryId);
    if (!e?.content) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
    const dec = await this.prisma.publishingDecision.findFirst({ where: { businessId: t.businessId, calendarEventId: entryId, contentVersion: e.content.version } });
    if (!dec || !['SENT_TO_REVIEW', 'AWAITING_PLATFORM_CONFIRMATION'].includes(dec.action)) throw new ConflictException({ code: 'NOT_AWAITING_REVIEW', message: 'This version is not waiting for a review (it may have been edited: review the new version)' });
    const accountId = await this.calendar.targetAccountId(this.prisma, e as never);
    const policy = accountId ? await this.policies.find(accountId) : null;
    // The post is classified again now: an approval can never lift a BLOCKED verdict, and the rules may have changed since the post was prepared.
    const { classification } = await this.classify(t.businessId, entryId, policy, accountId);
    if (classification.risk === 'BLOCKED') {
      await this.finish(dec.id, 'BLOCKED', { risk: 'BLOCKED', reasons: classification.reasons });
      throw new UnprocessableEntityException({ code: 'BLOCKED', message: 'This post cannot be published', reasons: classification.reasons });
    }
    const claim = await this.prisma.publishingDecision.updateMany({ where: { id: dec.id, action: { in: ['SENT_TO_REVIEW', 'AWAITING_PLATFORM_CONFIRMATION'] } }, data: { action: 'PROCESSING' } });
    if (!claim.count) throw new ConflictException({ code: 'NOT_AWAITING_REVIEW', message: 'This post was just decided by someone else' });
    try {
      await this.calendar.approve(t, entryId);
      await this.calendar.authorize(t, entryId, false);
    } catch (err) {
      await this.finish(dec.id, dec.action, { risk: 'REVIEW_REQUIRED', reasons: classification.reasons });
      throw err;
    }
    const fresh = (await this.entry(t.businessId, entryId))!;
    const validUntil = new Date(e.scheduledAt.getTime() + this.env.AUTOPUBLISH_APPROVAL_GRACE_MINUTES * 60_000);
    await this.finish(dec.id, 'HUMAN_APPROVED', { risk: 'REVIEW_REQUIRED', reasons: classification.reasons, automated: false, snapshotHash: fresh.authorizedHash, approvedById: t.userId, validUntil });
    await this.policies.event(t.businessId, 'HUMAN_APPROVED', { accountId, entryId, actorId: t.userId, data: { action: 'PUBLISH', platform: e.platform, accountId, version: e.content.version, scheduledAt: e.scheduledAt.toISOString(), validUntil: validUntil.toISOString(), policyId: policy?.id ?? null, mode: policy?.mode ?? 'MANUAL' } });
    return this.decisionOf(t.businessId, entryId, e.content.version);
  }

  async rejectReview(t: TenantContext, entryId: string, reason: string) {
    const e = await this.entry(t.businessId, entryId);
    if (!e?.content) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
    const dec = await this.prisma.publishingDecision.findFirst({ where: { businessId: t.businessId, calendarEventId: entryId, contentVersion: e.content.version, action: { in: ['SENT_TO_REVIEW', 'AWAITING_PLATFORM_CONFIRMATION'] } } });
    if (!dec) throw new ConflictException({ code: 'NOT_AWAITING_REVIEW', message: 'This version is not waiting for a review' });
    await this.calendar.reject(t, entryId, reason);
    await this.prisma.publishingDecision.update({ where: { id: dec.id }, data: { action: 'REJECTED' } });
    await this.policies.event(t.businessId, 'REJECTED', { accountId: dec.socialAccountId, entryId, actorId: t.userId, data: { reason } });
    return this.decisionOf(t.businessId, entryId, e.content.version);
  }

  /** Marks entries for the background pass (the worker processes them). Idempotent. */
  async enqueue(businessId: string, entryId: string) {
    const e = await this.entry(businessId, entryId);
    if (!e?.content) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Entry not found' });
    try {
      await this.prisma.publishingDecision.create({ data: { businessId, calendarEventId: entryId, contentId: e.content.id, contentVersion: e.content.version, platform: e.platform, mode: 'MANUAL', risk: 'REVIEW_REQUIRED', reasons: [], action: 'QUEUED' } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    return this.decisionOf(businessId, entryId, e.content.version);
  }

  /**
   * One background pass: decisions queued for the policy are processed, posts waiting for a review whose time has passed are marked expired (a late post is never
   * sent on an old approval) and crashed attempts are recovered. Safe to run from several processes at once.
   */
  async tick(now = new Date()) {
    let processed = 0; let expired = 0;
    const queued = await this.prisma.publishingDecision.findMany({ where: { OR: [{ action: 'QUEUED' }, { action: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] }, take: 50, orderBy: { createdAt: 'asc' } });
    for (const d of queued) {
      try {
        const e = await this.entry(d.businessId, d.calendarEventId);
        const policy = e ? await this.accountPolicy(e) : null;
        const t = policy ? await this.grantor(policy) : null;
        const m = t ?? (await this.anyApprover(d.businessId));
        if (!m) continue;
        await this.process(m, d.calendarEventId);
        processed++;
      } catch (err) { this.logger.warn(`queued decision ${d.id}: ${errCode(err).code}`); }
    }
    const waiting = await this.prisma.publishingDecision.findMany({ where: { action: { in: ['SENT_TO_REVIEW', 'AWAITING_PLATFORM_CONFIRMATION'] } }, take: 200 });
    for (const d of waiting) {
      const e = await this.prisma.calendarEvent.findFirst({ where: { id: d.calendarEventId, businessId: d.businessId }, select: { scheduledAt: true } });
      if (e && e.scheduledAt < now) {
        const res = await this.prisma.publishingDecision.updateMany({ where: { id: d.id, action: d.action }, data: { action: 'EXPIRED' } });
        if (res.count) { expired++; await this.policies.event(d.businessId, 'REVIEW_EXPIRED', { accountId: d.socialAccountId, entryId: d.calendarEventId, data: { version: d.contentVersion } }); }
      }
    }
    if (processed || expired) this.logger.log(`pass: ${processed} processed, ${expired} review(s) expired`);
    return { processed, expired };
  }

  private async accountPolicy(e: { id: string; businessId: string; socialAccountId: string | null; platform: string | null }) {
    const accountId = e.socialAccountId ?? (await this.prisma.socialAccount.findFirst({ where: { businessId: e.businessId, platform: e.platform as never, status: 'CONNECTED', deletedAt: null }, select: { id: true } }))?.id;
    return accountId ? this.policies.find(accountId) : null;
  }

  private async anyApprover(businessId: string): Promise<TenantContext | null> {
    const m = await this.prisma.membership.findFirst({ where: { businessId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } }, orderBy: { createdAt: 'asc' } });
    return m ? { businessId, membershipId: m.id, role: m.role, userId: m.userId } : null;
  }
}
