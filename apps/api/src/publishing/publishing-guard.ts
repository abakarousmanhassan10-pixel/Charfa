import { Injectable, Module } from '@nestjs/common';
import { CONSENT_VERSION, resolveEntitlement, utcToZoned } from '@touma/shared';
import { FounderService } from '../billing/founder.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export type GuardResult = { ok: true } | { ok: false; code: string; message: string; /** true: nothing is wrong with the entry; it waits and the person can fix the cause */ blocked: boolean };

/**
 * The publishing policy's part of the publication gate (N21). The gate calls it before the hand-off and again immediately before the platform request,
 * so a consent revoked, a pause, an emergency stop, an expired subscription or an expired approval stops the post even if it was scheduled earlier.
 * It only ever refuses: it cannot make an entry publishable.
 */
@Injectable()
export class PublishingGuard {
  constructor(private readonly prisma: PrismaService, private readonly founders: FounderService, @InjectEnv() private readonly env: AppEnv) {}

  async check(businessId: string, entry: { id: string; platform: string | null; authorizedAccountId: string | null; authorizedVersion: number | null; scheduledAt: Date }, now = new Date()): Promise<GuardResult> {
    const no = (code: string, message: string, blocked = true): GuardResult => ({ ok: false, code, message, blocked });
    // The subscription is checked for every publication, whoever scheduled it.
    if (this.env.BILLING_ENFORCEMENT_ENABLED) {
      const [sub, founder] = await Promise.all([this.prisma.subscription.findUnique({ where: { businessId } }), this.founders.isFounder(businessId)]);
      if (!resolveEntitlement({ now, isFounder: founder, graceDays: this.env.BILLING_GRACE_DAYS, subscription: sub }).hasAccess) return no('SUBSCRIPTION_REQUIRED', 'The subscription does not allow publishing right now. Nothing was published.');
    }
    const decision = entry.authorizedVersion == null ? null : await this.prisma.publishingDecision.findUnique({ where: { calendarEventId_contentVersion: { calendarEventId: entry.id, contentVersion: entry.authorizedVersion } } });
    const policy = entry.authorizedAccountId ? await this.prisma.publishingPolicy.findUnique({ where: { socialAccountId: entry.authorizedAccountId } }) : null;
    if (decision?.automated) {
      // Emergency stop: no new outward action by the automation.
      const stop = await this.prisma.agentControl.findFirst({ where: { stopped: true, OR: [{ scope: 'GLOBAL', scopeId: '' }, { scope: 'TENANT', scopeId: businessId }] } });
      if (stop) return no('AUTOMATION_STOPPED', 'The automation was stopped by an administrator. Nothing was published.');
      if (!policy || policy.businessId !== businessId) return no('AUTOMATION_NOT_ALLOWED', 'There is no publishing policy for this account.');
      if (policy.consentRevokedAt || !policy.consentGrantedAt || policy.consentVersion !== CONSENT_VERSION) return no('CONSENT_REVOKED', 'The consent to automatic publishing was revoked or is not current. Nothing was published.');
      if (policy.mode === 'MANUAL' || !policy.automationEnabled) return no('AUTOMATION_DISABLED', 'Automatic publishing is switched off for this account.');
      if (policy.pausedAt) return no('AUTOMATION_PAUSED', 'Automatic publishing is paused for this account.');
    }
    if (decision?.validUntil && decision.validUntil < now) return no('APPROVAL_EXPIRED', 'The approval expired before the post could be published. Approve it again.', false);
    if (policy?.automationEnabled && policy.mode !== 'MANUAL') {
      // The daily limit of the policy, counted in the policy's timezone, over posts that were sent or are being sent.
      const local = utcToZoned(now, policy.timezone).date;
      const since = new Date(now.getTime() - 36 * 3_600_000);
      const recent = await this.prisma.publication.findMany({ where: { businessId, socialAccountId: policy.socialAccountId, status: { in: ['PUBLISHED', 'PUBLISHING', 'AWAITING_PROVIDER', 'QUEUED'] }, createdAt: { gte: since }, calendarEventId: { not: entry.id } }, select: { createdAt: true } });
      if (recent.filter((p) => utcToZoned(p.createdAt, policy.timezone).date === local).length >= policy.maximumPostsPerDay) return no('POLICY_DAILY_LIMIT', `The daily limit of ${policy.maximumPostsPerDay} posts for this account was reached. The post waits.`);
    }
    return { ok: true };
  }
}

@Module({ providers: [PublishingGuard, FounderService], exports: [PublishingGuard] })
export class PublishingGuardModule {}
