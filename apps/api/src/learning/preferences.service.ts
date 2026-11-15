import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PreferenceOrigin } from '@touma/database';
import { effectivePreferences, isInferable, validateDeclared, type PrefRow } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

type Actor = Pick<TenantContext, 'businessId' | 'userId'>;
const HYPOTHESIS_TARGET: Record<string, string> = { slot: 'inferred.bestSlot', kind: 'inferred.bestKind', length: 'inferred.captionLength', hook: 'inferred.hook', topic: 'inferred.topic' };

/**
 * What TOUMA remembers about a client. Declared values (the client's own words) are the only ones a person writes; inferred ones and hypotheses are written by the
 * learning run, with their evidence, and only under a valid consent. Every change leaves a revision, so it can be audited, exported, rolled back or erased.
 * Everything is keyed by the business: another client's rows are unreachable.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  rows(businessId: string): Promise<Array<PrefRow & { id: string; version: number; confidence: string | null; updatedAt: Date }>> {
    return this.prisma.clientPreference.findMany({ where: { businessId }, orderBy: [{ origin: 'asc' }, { key: 'asc' }] }) as never;
  }

  async list(businessId: string) {
    const rows = await this.rows(businessId);
    return {
      declared: rows.filter((r) => r.origin === 'DECLARED'),
      inferred: rows.filter((r) => r.origin === 'INFERRED'),
      hypotheses: rows.filter((r) => r.origin === 'HYPOTHESIS'),
      effective: effectivePreferences(rows),
      note: 'A declared value always wins over what the system inferred. Hypotheses are never used until you confirm them.',
    };
  }

  async effective(businessId: string) { return effectivePreferences(await this.rows(businessId)); }

  private async revise(tx: Prisma.TransactionClient | PrismaService, businessId: string, key: string, origin: PreferenceOrigin, version: number, value: unknown, action: string, actorId?: string | null, reason?: string | null, runId?: string | null) {
    await tx.preferenceRevision.create({ data: { businessId, key, origin, version, value: value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue), action, actorId: actorId ?? null, reason: reason ?? null, runId: runId ?? null } });
  }

  /** The client states or corrects a preference. It replaces the earlier declared value (kept in the revisions) and wins over anything inferred. */
  async setDeclared(t: Actor, key: string, value: unknown, reason?: string) {
    const v = validateDeclared(key, value);
    if (!v.ok) throw new ConflictException({ code: 'INVALID_PREFERENCE', message: v.error });
    await this.prisma.$transaction(async (tx) => {
      const cur = await tx.clientPreference.findUnique({ where: { businessId_key_origin: { businessId: t.businessId, key, origin: 'DECLARED' } } });
      const version = (cur?.version ?? 0) + 1;
      await tx.clientPreference.upsert({ where: { businessId_key_origin: { businessId: t.businessId, key, origin: 'DECLARED' } }, create: { businessId: t.businessId, key, origin: 'DECLARED', value: v.value as Prisma.InputJsonValue, version, updatedById: t.userId }, update: { value: v.value as Prisma.InputJsonValue, version, status: 'ACTIVE', updatedById: t.userId } });
      await this.revise(tx, t.businessId, key, 'DECLARED', version, v.value, cur ? 'CORRECT' : 'SET', t.userId, reason);
    });
    await this.supersedeConflicting(t.businessId, t.userId);
    await this.audit.record({ action: 'learning.preference_declared', actorId: t.userId, businessId: t.businessId, entityType: 'ClientPreference', metadata: { key } });
    return this.list(t.businessId);
  }

  /** Inferred observations that contradict a declared value stop counting at once (kept as SUPERSEDED, with a revision). */
  async supersedeConflicting(businessId: string, actorId?: string | null) {
    const eff = await this.effective(businessId);
    const kinds = (eff['content.preferredTypes']?.origin === 'DECLARED' ? (eff['content.preferredTypes']!.value as string[]) : []);
    const inferred = await this.prisma.clientPreference.findMany({ where: { businessId, origin: 'INFERRED', status: 'ACTIVE' } });
    for (const r of inferred) {
      const conflict = r.key === 'inferred.bestKind' && kinds.length > 0 && !kinds.includes((r.value as { kind?: string }).kind ?? '');
      if (!conflict) continue;
      await this.prisma.clientPreference.update({ where: { id: r.id }, data: { status: 'SUPERSEDED' } });
      await this.revise(this.prisma, businessId, r.key, 'INFERRED', r.version, r.value, 'SUPERSEDE', actorId, 'Contradicts a declared preference');
    }
  }

  /** The learning run records an observation (never overwrites a rejected or superseded one) or a hypothesis to confirm. */
  async learn(businessId: string, runId: string, key: string, origin: 'INFERRED' | 'HYPOTHESIS', value: Record<string, unknown>, evidence: Record<string, unknown>, confidence: string) {
    if (!isInferable(key)) throw new ConflictException({ code: 'INVALID_PREFERENCE', message: 'Not a system-owned key' });
    const cur = await this.prisma.clientPreference.findUnique({ where: { businessId_key_origin: { businessId, key, origin } } });
    if (cur && cur.status !== 'ACTIVE') return false; // the client refused it, or a declared value replaced it
    const version = (cur?.version ?? 0) + 1;
    const adopted = (cur?.evidence as { adopted?: boolean } | null)?.adopted === true;
    await this.prisma.$transaction(async (tx) => {
      await tx.clientPreference.upsert({ where: { businessId_key_origin: { businessId, key, origin } }, create: { businessId, key, origin, value: value as Prisma.InputJsonValue, evidence: evidence as Prisma.InputJsonValue, confidence, version }, update: { value: value as Prisma.InputJsonValue, evidence: { ...evidence, ...(adopted ? { adopted: true } : {}) } as Prisma.InputJsonValue, confidence, version } });
      await this.revise(tx, businessId, key, origin, version, value, 'LEARN', null, null, runId);
    });
    return true;
  }

  /** The client confirms a hypothesis: it becomes an observation they have seen and accepted (still not a declared value). */
  async confirm(t: Actor, key: string) {
    const h = await this.prisma.clientPreference.findUnique({ where: { businessId_key_origin: { businessId: t.businessId, key, origin: 'HYPOTHESIS' } } });
    if (!h || h.status !== 'ACTIVE') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Hypothesis not found' });
    const v = h.value as { dimension?: string; label?: string };
    const target = HYPOTHESIS_TARGET[v.dimension ?? ''];
    if (!target) throw new ConflictException({ code: 'INVALID_PREFERENCE', message: 'Nothing to confirm' });
    await this.prisma.$transaction(async (tx) => {
      const value = v.dimension === 'slot' ? { bucket: v.label } : v.dimension === 'kind' ? { kind: v.label } : v.dimension === 'length' ? { length: v.label } : v.dimension === 'hook' ? { hook: v.label } : { topic: v.label };
      const cur = await tx.clientPreference.findUnique({ where: { businessId_key_origin: { businessId: t.businessId, key: target, origin: 'INFERRED' } } });
      const version = (cur?.version ?? 0) + 1;
      await tx.clientPreference.upsert({ where: { businessId_key_origin: { businessId: t.businessId, key: target, origin: 'INFERRED' } }, create: { businessId: t.businessId, key: target, origin: 'INFERRED', value, evidence: { confirmedBy: t.userId, from: key }, confidence: 'LOW', version }, update: { value, evidence: { confirmedBy: t.userId, from: key }, status: 'ACTIVE', version } });
      await this.revise(tx, t.businessId, target, 'INFERRED', version, value, 'CONFIRM', t.userId);
      await tx.clientPreference.delete({ where: { id: h.id } });
    });
    return this.list(t.businessId);
  }

  /** The client refuses an observation or a hypothesis: it stops counting and is never inferred again. */
  async reject(t: Actor, key: string, origin: 'INFERRED' | 'HYPOTHESIS') {
    const r = await this.prisma.clientPreference.findUnique({ where: { businessId_key_origin: { businessId: t.businessId, key, origin } } });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Preference not found' });
    await this.prisma.clientPreference.update({ where: { id: r.id }, data: { status: 'REJECTED' } });
    await this.revise(this.prisma, t.businessId, key, origin, r.version, r.value, 'REJECT', t.userId);
    return this.list(t.businessId);
  }

  async revisions(businessId: string, key?: string) {
    return this.prisma.preferenceRevision.findMany({ where: { businessId, ...(key ? { key } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Everything TOUMA holds about this client's preferences, as data they can keep. */
  async export(businessId: string) {
    const [prefs, revisions, profile] = await Promise.all([this.rows(businessId), this.prisma.preferenceRevision.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }), this.prisma.learningProfile.findUnique({ where: { businessId } })]);
    return { exportedAt: new Date().toISOString(), businessId, learning: profile && { consentVersion: profile.consentVersion, consentGrantedAt: profile.consentGrantedAt, consentRevokedAt: profile.consentRevokedAt, enabled: profile.enabled, autoPlan: profile.autoPlan }, preferences: prefs, revisions };
  }

  /** Erases one preference (every origin) or all of them, with their history. Only the fact of the erasure is audited, never the values. */
  async erase(t: Actor, key?: string) {
    const where = { businessId: t.businessId, ...(key ? { key } : {}) };
    const [a, b] = await this.prisma.$transaction([this.prisma.clientPreference.deleteMany({ where }), this.prisma.preferenceRevision.deleteMany({ where })]);
    await this.audit.record({ action: 'learning.preferences_erased', actorId: t.userId, businessId: t.businessId, entityType: 'ClientPreference', metadata: { scope: key ?? 'ALL', preferences: a.count, revisions: b.count } });
    return { erased: a.count, revisions: b.count };
  }
}
