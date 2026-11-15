import { ConflictException, Injectable } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

/** Version of the consent text for the learning loop. A new version needs a new acceptance. */
export const LEARNING_CONSENT_VERSION = '2026-12-v1';

@Injectable()
export class LearningProfileService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @InjectEnv() private readonly env: AppEnv) {}

  async get(businessId: string) {
    const p = await this.prisma.learningProfile.findUnique({ where: { businessId } });
    const valid = !!p && !!p.consentGrantedAt && !p.consentRevokedAt && p.consentVersion === LEARNING_CONSENT_VERSION;
    return { currentConsentVersion: LEARNING_CONSENT_VERSION, consentValid: valid, consentRequired: !valid, enabled: valid && !!p?.enabled, autoPlan: valid && !!p?.autoPlan, maxRunsPerDay: p?.maxRunsPerDay ?? this.env.LEARNING_MAX_RUNS_PER_DAY, lastRunAt: p?.lastRunAt ?? null, consentGrantedAt: p?.consentGrantedAt ?? null, consentRevokedAt: p?.consentRevokedAt ?? null, analyticsProvider: this.env.ANALYTICS_PROVIDER, simulated: this.env.ANALYTICS_PROVIDER === 'mock' };
  }

  async consent(t: TenantContext, version: string) {
    if (version !== LEARNING_CONSENT_VERSION) throw new ConflictException({ code: 'CONSENT_VERSION_MISMATCH', message: 'The consent text changed: read the current version and accept it again' });
    const data = { consentVersion: LEARNING_CONSENT_VERSION, consentGrantedAt: new Date(), consentGrantedById: t.userId, consentRevokedAt: null, updatedById: t.userId };
    await this.prisma.learningProfile.upsert({ where: { businessId: t.businessId }, create: { businessId: t.businessId, enabled: true, maxRunsPerDay: this.env.LEARNING_MAX_RUNS_PER_DAY, ...data }, update: { ...data, enabled: true } });
    await this.audit.record({ action: 'learning.consent_granted', actorId: t.userId, businessId: t.businessId, entityType: 'LearningProfile', metadata: { version } });
    return this.get(t.businessId);
  }

  /** Withdraws the consent: the loop stops at once and what the system inferred or suspected about the client is erased. Declared preferences stay (they are the client's). */
  async revoke(t: TenantContext) {
    const p = await this.prisma.learningProfile.findUnique({ where: { businessId: t.businessId } });
    if (!p) return this.get(t.businessId);
    await this.prisma.learningProfile.update({ where: { businessId: t.businessId }, data: { consentRevokedAt: new Date(), enabled: false, autoPlan: false, updatedById: t.userId } });
    const gone = await this.prisma.clientPreference.deleteMany({ where: { businessId: t.businessId, origin: { in: ['INFERRED', 'HYPOTHESIS'] } } });
    await this.prisma.preferenceRevision.deleteMany({ where: { businessId: t.businessId, origin: { in: ['INFERRED', 'HYPOTHESIS'] } } });
    await this.audit.record({ action: 'learning.consent_revoked', actorId: t.userId, businessId: t.businessId, entityType: 'LearningProfile', metadata: { erasedInferences: gone.count } });
    return this.get(t.businessId);
  }

  async update(t: TenantContext, o: { enabled?: boolean; autoPlan?: boolean; maxRunsPerDay?: number }) {
    const g = await this.get(t.businessId);
    if (!g.consentValid) throw new ConflictException({ code: 'CONSENT_REQUIRED', message: 'Accept the learning consent first' });
    const max = Math.min(o.maxRunsPerDay ?? g.maxRunsPerDay, this.env.LEARNING_MAX_RUNS_PER_DAY);
    await this.prisma.learningProfile.update({ where: { businessId: t.businessId }, data: { ...(o.enabled !== undefined ? { enabled: o.enabled } : {}), ...(o.autoPlan !== undefined ? { autoPlan: o.autoPlan } : {}), maxRunsPerDay: max, updatedById: t.userId } });
    await this.audit.record({ action: 'learning.settings_changed', actorId: t.userId, businessId: t.businessId, entityType: 'LearningProfile', metadata: { ...o } });
    return this.get(t.businessId);
  }

  async assertActive(businessId: string) {
    const g = await this.get(businessId);
    if (!g.consentValid) throw new ConflictException({ code: 'CONSENT_REQUIRED', message: 'The learning consent is missing, revoked or outdated' });
    if (!g.enabled) throw new ConflictException({ code: 'LEARNING_DISABLED', message: 'Learning is switched off for this business' });
    return g;
  }
}
