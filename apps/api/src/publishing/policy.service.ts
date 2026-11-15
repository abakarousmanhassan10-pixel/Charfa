import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { AUTOMATION_PLATFORMS, CONSENT_VERSION, DEFAULT_HOURS, PLATFORM_AUTOMATION, platformFacts, validatePolicyDraft, type HoursWindow, type PublishingMode } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import { CalendarService } from '../calendar/calendar.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

const conflict = (code: string, message: string) => new ConflictException({ code, message });
const bad = (message: string, errors?: string[]) => new BadRequestException({ code: 'VALIDATION_ERROR', message, ...(errors ? { errors } : {}) });

export interface PolicyInput { mode?: PublishingMode; maximumPostsPerDay?: number; timezone?: string; allowedContentTypes?: string[]; allowedPublishingHours?: HoursWindow[]; requiresPlatformConfirmation?: boolean; automationEnabled?: boolean }

/**
 * Publishing policy of each connected account (N21). MANUAL is the default and the fallback: a person schedules every post. HYBRID and AUTO exist only after
 * an explicit, versioned consent of an authorized person, can be changed, paused or revoked at any time, and are enforced again by the publication gate.
 */
@Injectable()
export class PublishingPolicyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly billing: BillingService, private readonly calendar: CalendarService) {}

  async event(businessId: string, type: string, o: { accountId?: string | null; entryId?: string | null; actorId?: string | null; data?: Record<string, unknown> } = {}) {
    await this.prisma.publishingEvent.create({ data: { businessId, type, socialAccountId: o.accountId ?? null, calendarEventId: o.entryId ?? null, actorId: o.actorId ?? null, data: (o.data ?? {}) as Prisma.InputJsonObject } });
  }

  private async account(t: TenantContext, accountId: string) {
    const a = await this.prisma.socialAccount.findFirst({ where: { id: accountId, businessId: t.businessId, deletedAt: null } });
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });
    return a;
  }

  view(a: { id: string; platform: string; displayName: string | null; username: string | null; status: string; scopes: string[] }, p: Awaited<ReturnType<PublishingPolicyService['find']>>) {
    const facts = platformFacts(a.platform);
    const consentValid = !!p && !!p.consentGrantedAt && !p.consentRevokedAt && p.consentVersion === CONSENT_VERSION;
    return {
      account: { id: a.id, platform: a.platform, name: a.displayName ?? a.username ?? a.platform, status: a.status },
      supported: AUTOMATION_PLATFORMS.includes(a.platform as never),
      platform: facts && { adapter: facts.adapter, perPostConfirmation: facts.perPostConfirmation, contentKinds: facts.contentKinds, limitations: facts.limitations, consent: facts.consent },
      policy: p && { id: p.id, mode: p.mode, consentVersion: p.consentVersion, consentGrantedAt: p.consentGrantedAt, consentRevokedAt: p.consentRevokedAt, authorizedScopes: p.authorizedScopes, allowedContentTypes: p.allowedContentTypes, maximumPostsPerDay: p.maximumPostsPerDay, timezone: p.timezone, allowedPublishingHours: p.allowedPublishingHours, requiresPlatformConfirmation: p.requiresPlatformConfirmation, automationEnabled: p.automationEnabled, pausedAt: p.pausedAt },
      effectiveMode: p && consentValid && p.automationEnabled && !p.pausedAt && a.status === 'CONNECTED' ? p.mode : 'MANUAL',
      consentRequired: !consentValid,
      currentConsentVersion: CONSENT_VERSION,
    };
  }

  find(accountId: string) { return this.prisma.publishingPolicy.findUnique({ where: { socialAccountId: accountId } }); }

  async list(t: TenantContext) {
    const accounts = await this.prisma.socialAccount.findMany({ where: { businessId: t.businessId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    const policies = await this.prisma.publishingPolicy.findMany({ where: { businessId: t.businessId } });
    return accounts.map((a) => this.view(a, policies.find((p) => p.socialAccountId === a.id) ?? null));
  }

  async get(t: TenantContext, accountId: string) {
    const a = await this.account(t, accountId);
    return this.view(a, await this.find(a.id));
  }

  /** Records the person's consent to the current consent text. It does not switch automation on. */
  async grantConsent(t: TenantContext, accountId: string, version: string) {
    const a = await this.account(t, accountId);
    if (version !== CONSENT_VERSION) throw conflict('CONSENT_VERSION_MISMATCH', 'The consent text changed: read the current version and accept it again');
    if (!AUTOMATION_PLATFORMS.includes(a.platform as never)) throw conflict('PLATFORM_NOT_SUPPORTED', `Automatic publishing is not available for ${a.platform}`);
    if (a.status !== 'CONNECTED') throw conflict('ACCOUNT_NOT_CONNECTED', 'Reconnect this account first');
    await this.billing.assertAccess(t.businessId);
    const facts = platformFacts(a.platform)!;
    const bt = await this.calendar.businessTime(t.businessId);
    const now = new Date();
    const data = { consentVersion: CONSENT_VERSION, consentGrantedAt: now, consentGrantedById: t.userId, consentRevokedAt: null, authorizedScopes: a.scopes, updatedById: t.userId };
    const p = await this.prisma.publishingPolicy.upsert({
      where: { socialAccountId: a.id },
      create: { businessId: t.businessId, socialAccountId: a.id, platform: a.platform, mode: 'MANUAL', allowedContentTypes: [...facts.contentKinds], timezone: bt.timezone, allowedPublishingHours: DEFAULT_HOURS as unknown as Prisma.InputJsonValue, requiresPlatformConfirmation: facts.perPostConfirmation, ...data },
      update: data,
    });
    await this.audit.record({ action: 'publishing.consent_granted', actorId: t.userId, businessId: t.businessId, entityType: 'PublishingPolicy', entityId: p.id, metadata: { accountId: a.id, platform: a.platform, version: CONSENT_VERSION } });
    await this.event(t.businessId, 'CONSENT_GRANTED', { accountId: a.id, actorId: t.userId, data: { version: CONSENT_VERSION, platform: a.platform, scopes: a.scopes } });
    return this.get(t, a.id);
  }

  /** Changes the mode and limits. AUTO/HYBRID need a current consent, a connected account and an active subscription. */
  async update(t: TenantContext, accountId: string, input: PolicyInput) {
    const a = await this.account(t, accountId);
    const cur = await this.find(a.id);
    if (!cur) throw conflict('CONSENT_REQUIRED', 'Accept the consent for this account before configuring automatic publishing');
    const next = {
      mode: input.mode ?? cur.mode,
      maximumPostsPerDay: input.maximumPostsPerDay ?? cur.maximumPostsPerDay,
      timezone: input.timezone ?? cur.timezone,
      allowedContentTypes: input.allowedContentTypes ?? cur.allowedContentTypes,
      allowedPublishingHours: (input.allowedPublishingHours ?? cur.allowedPublishingHours) as unknown as HoursWindow[],
    };
    const errors = validatePolicyDraft(next);
    if (errors.length) throw bad(`Invalid settings: ${errors.join(', ')}`, errors);
    const facts = platformFacts(a.platform)!;
    const unsupported = next.allowedContentTypes.filter((k) => !facts.contentKinds.includes(k as never));
    if (unsupported.length) throw bad(`${a.platform} cannot publish ${unsupported.join(', ')} through its official API`);
    let automationEnabled = input.automationEnabled ?? cur.automationEnabled;
    if (next.mode === 'MANUAL') automationEnabled = false;
    else if (automationEnabled || input.mode) {
      if (!cur.consentGrantedAt || cur.consentRevokedAt || cur.consentVersion !== CONSENT_VERSION) throw conflict('CONSENT_REQUIRED', 'A current consent is required before AUTO or HYBRID can be used');
      if (a.status !== 'CONNECTED') throw conflict('ACCOUNT_NOT_CONNECTED', 'Reconnect this account first');
      const missing = ((a.metadata as { criticalMissing?: string[] } | null)?.criticalMissing ?? []);
      if (a.status === 'CONNECTED' && missing.length) throw conflict('PERMISSION_MISSING', `The platform did not grant: ${missing.join(', ')}`);
      await this.billing.assertAccess(t.businessId);
      if (input.mode && !input.automationEnabled && input.automationEnabled !== false) automationEnabled = true;
    }
    const p = await this.prisma.publishingPolicy.update({
      where: { id: cur.id },
      data: { ...next, allowedPublishingHours: next.allowedPublishingHours as unknown as Prisma.InputJsonValue, requiresPlatformConfirmation: input.requiresPlatformConfirmation ?? (cur.requiresPlatformConfirmation || facts.perPostConfirmation), automationEnabled, updatedById: t.userId, ...(automationEnabled ? { pausedAt: null, pausedById: null } : {}) },
    });
    if (next.mode !== cur.mode || automationEnabled !== cur.automationEnabled) {
      await this.audit.record({ action: 'publishing.policy_changed', actorId: t.userId, businessId: t.businessId, entityType: 'PublishingPolicy', entityId: p.id, metadata: { from: cur.mode, to: next.mode, automationEnabled } });
      await this.event(t.businessId, 'POLICY_CHANGED', { accountId: a.id, actorId: t.userId, data: { from: cur.mode, to: next.mode, automationEnabled } });
    }
    if (!automationEnabled) await this.withdrawAutomated(t, a.id, 'AUTOMATION_DISABLED');
    return this.get(t, a.id);
  }

  /** Revokes the consent at once: back to MANUAL, and automatic schedules that were not handed to the publisher yet are withdrawn. */
  async revokeConsent(t: TenantContext, accountId: string) {
    const a = await this.account(t, accountId);
    const cur = await this.find(a.id);
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No policy for this account' });
    await this.prisma.publishingPolicy.update({ where: { id: cur.id }, data: { consentRevokedAt: new Date(), mode: 'MANUAL', automationEnabled: false, updatedById: t.userId } });
    const withdrawn = await this.withdrawAutomated(t, a.id, 'CONSENT_REVOKED');
    await this.audit.record({ action: 'publishing.consent_revoked', actorId: t.userId, businessId: t.businessId, entityType: 'PublishingPolicy', entityId: cur.id, metadata: { accountId: a.id, withdrawn } });
    await this.event(t.businessId, 'CONSENT_REVOKED', { accountId: a.id, actorId: t.userId, data: { withdrawn } });
    return this.get(t, a.id);
  }

  async pause(t: TenantContext, accountId: string) {
    const a = await this.account(t, accountId);
    const cur = await this.find(a.id);
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No policy for this account' });
    await this.prisma.publishingPolicy.update({ where: { id: cur.id }, data: { pausedAt: new Date(), pausedById: t.userId } });
    await this.audit.record({ action: 'publishing.paused', actorId: t.userId, businessId: t.businessId, entityType: 'PublishingPolicy', entityId: cur.id });
    await this.event(t.businessId, 'PAUSED', { accountId: a.id, actorId: t.userId });
    return this.get(t, a.id);
  }

  async resume(t: TenantContext, accountId: string) {
    const a = await this.account(t, accountId);
    const cur = await this.find(a.id);
    if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No policy for this account' });
    if (cur.consentRevokedAt || cur.consentVersion !== CONSENT_VERSION) throw conflict('CONSENT_REQUIRED', 'A current consent is required');
    await this.billing.assertAccess(t.businessId);
    await this.prisma.publishingPolicy.update({ where: { id: cur.id }, data: { pausedAt: null, pausedById: null } });
    await this.event(t.businessId, 'RESUMED', { accountId: a.id, actorId: t.userId });
    return this.get(t, a.id);
  }

  /** Automatic schedules not yet handed to the publisher go back to APPROVED (a person can schedule them again). Already dispatched posts are the gate's business. */
  async withdrawAutomated(t: TenantContext, accountId: string, reason: string): Promise<number> {
    const rows = await this.prisma.publishingDecision.findMany({ where: { businessId: t.businessId, socialAccountId: accountId, automated: true, action: 'AUTO_SCHEDULED' } });
    let n = 0;
    for (const d of rows) {
      try {
        await this.calendar.unschedule(t, d.calendarEventId);
        await this.prisma.publishingDecision.update({ where: { id: d.id }, data: { action: 'WITHDRAWN' } });
        await this.event(t.businessId, 'WITHDRAWN', { accountId, entryId: d.calendarEventId, actorId: t.userId, data: { reason } });
        n++;
      } catch { /* already handed to the publisher or changed: the gate decides before the platform request */ }
    }
    return n;
  }

  facts() { return PLATFORM_AUTOMATION; }
}
