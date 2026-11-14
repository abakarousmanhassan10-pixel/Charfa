import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type MemoryKind } from '@touma/database';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

export const MEMORY_KINDS = ['BRAND', 'PRODUCT_FACT', 'CAMPAIGN_HISTORY', 'AUDIENCE', 'METRIC', 'PREFERENCE', 'DECISION', 'EVALUATION'] as const;
export const PROVENANCE = ['MERCHANT', 'CATALOG', 'AGENT', 'PLATFORM_REAL', 'PLATFORM_SIMULATED'] as const;
type Provenance = (typeof PROVENANCE)[number];

/** Who may be the source of each kind. A metric can only come from a platform (real or simulated), never from a person or an agent. */
const ALLOWED: Record<MemoryKind, readonly Provenance[]> = {
  BRAND: ['MERCHANT', 'CATALOG'],
  PRODUCT_FACT: ['CATALOG', 'MERCHANT'],
  CAMPAIGN_HISTORY: ['AGENT', 'MERCHANT'],
  AUDIENCE: ['AGENT', 'MERCHANT'],
  METRIC: ['PLATFORM_REAL', 'PLATFORM_SIMULATED'],
  PREFERENCE: ['MERCHANT'],
  DECISION: ['MERCHANT', 'AGENT'],
  EVALUATION: ['AGENT'],
};
/** Default retention in days, shorter for data that goes stale quickly. */
export const RETENTION_DAYS: Record<MemoryKind, number> = { BRAND: 730, PRODUCT_FACT: 365, CAMPAIGN_HISTORY: 365, AUDIENCE: 180, METRIC: 180, PREFERENCE: 730, DECISION: 365, EVALUATION: 90 };
/** Preferences an approved improvement may set, with their allowed range. Nothing else can change agent behavior. */
export const PREFERENCE_KEYS: Record<string, { min: number; max: number }> = { 'creative.maxCaptionChars': { min: 100, max: 900 } };

const KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:\+?\d[\s.-]?){8,}/;
const MAX_BYTES = 4_000;

/** Rejects anything that looks like personal contact data: memory keeps minimized business facts, not customer details. */
export function assertMinimized(value: unknown) {
  const text = JSON.stringify(value) ?? '';
  if (Buffer.byteLength(text) > MAX_BYTES) throw new BadRequestException({ code: 'MEMORY_TOO_LARGE', message: `A memory entry is limited to ${MAX_BYTES} bytes` });
  if (EMAIL.test(text) || PHONE.test(text.replace(/"[0-9a-f]{20,}"/gi, ''))) throw new BadRequestException({ code: 'SENSITIVE_DATA', message: 'Memory does not store e-mail addresses or phone numbers' });
}

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async put(tenant: Pick<TenantContext, 'businessId' | 'userId'>, i: { kind: string; key: string; value: unknown; provenance: string; sourceRef?: string; retentionDays?: number }) {
    if (!(MEMORY_KINDS as readonly string[]).includes(i.kind)) throw new BadRequestException({ code: 'INVALID_KIND', message: 'Unknown memory kind' });
    const kind = i.kind as MemoryKind;
    if (!KEY_RE.test(i.key)) throw new BadRequestException({ code: 'INVALID_KEY', message: 'Key: letters, digits and . _ : - (max 80)' });
    if (!(PROVENANCE as readonly string[]).includes(i.provenance) || !ALLOWED[kind].includes(i.provenance as Provenance)) throw new BadRequestException({ code: 'INVALID_PROVENANCE', message: `${kind} memory can only come from: ${ALLOWED[kind].join(', ')}` });
    if (i.value === null || typeof i.value !== 'object' || Array.isArray(i.value)) throw new BadRequestException({ code: 'INVALID_VALUE', message: 'value must be an object' });
    if (kind === 'PREFERENCE') {
      const range = PREFERENCE_KEYS[i.key];
      const v = (i.value as { value?: unknown }).value;
      if (!range || typeof v !== 'number' || !Number.isInteger(v) || v < range.min || v > range.max) throw new BadRequestException({ code: 'INVALID_PREFERENCE', message: `Allowed preferences: ${Object.entries(PREFERENCE_KEYS).map(([k, r]) => `${k} (${r.min}-${r.max})`).join(', ')}` });
    }
    assertMinimized(i.value);
    const days = Math.min(Math.max(Math.trunc(i.retentionDays ?? RETENTION_DAYS[kind]), 1), RETENTION_DAYS[kind]);
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const data = { value: i.value as Prisma.InputJsonValue, provenance: i.provenance, sourceRef: i.sourceRef?.slice(0, 80) ?? null, retentionDays: days, expiresAt };
    const row = await this.prisma.merchantMemory.upsert({ where: { businessId_kind_key: { businessId: tenant.businessId, kind, key: i.key } }, create: { businessId: tenant.businessId, kind, key: i.key, ...data }, update: data });
    await this.audit.record({ action: 'intelligence.memory_written', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MerchantMemory', entityId: row.id, metadata: { kind, provenance: i.provenance } });
    return this.dto(row);
  }

  /** Unexpired entries of this business only. */
  async list(tenant: Pick<TenantContext, 'businessId'>, kind?: string) {
    if (kind && !(MEMORY_KINDS as readonly string[]).includes(kind)) throw new BadRequestException({ code: 'INVALID_KIND', message: 'Unknown memory kind' });
    const rows = await this.prisma.merchantMemory.findMany({ where: { businessId: tenant.businessId, expiresAt: { gt: new Date() }, ...(kind ? { kind: kind as MemoryKind } : {}) }, orderBy: [{ kind: 'asc' }, { key: 'asc' }], take: 200 });
    return { items: rows.map((r) => this.dto(r)) };
  }

  async preference(businessId: string, key: string): Promise<number | null> {
    const r = await this.prisma.merchantMemory.findUnique({ where: { businessId_kind_key: { businessId, kind: 'PREFERENCE', key } } });
    const v = (r?.value as { value?: unknown } | undefined)?.value;
    return r && r.expiresAt > new Date() && typeof v === 'number' ? v : null;
  }

  /** Deletes memory on request: one entry, one kind, or everything for this business. */
  async forget(tenant: TenantContext, o: { kind?: string; key?: string }) {
    if (o.key && !o.kind) throw new BadRequestException({ code: 'KIND_REQUIRED', message: 'kind is required with key' });
    const where: Prisma.MerchantMemoryWhereInput = { businessId: tenant.businessId, ...(o.kind ? { kind: o.kind as MemoryKind } : {}), ...(o.key ? { key: o.key } : {}) };
    const res = await this.prisma.merchantMemory.deleteMany({ where });
    if (o.key && res.count === 0) throw new NotFoundException({ code: 'MEMORY_NOT_FOUND', message: 'No such memory entry' });
    await this.audit.record({ action: 'intelligence.memory_deleted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MerchantMemory', entityId: tenant.businessId, metadata: { kind: o.kind ?? 'ALL', deleted: res.count } });
    return { deleted: res.count };
  }

  /** Retention: removes expired entries for every business (run by a scheduled job). */
  async purgeExpired() {
    return (await this.prisma.merchantMemory.deleteMany({ where: { expiresAt: { lte: new Date() } } })).count;
  }

  private dto(r: { id: string; kind: string; key: string; value: unknown; provenance: string; sourceRef: string | null; retentionDays: number; expiresAt: Date; updatedAt: Date }) {
    return { id: r.id, kind: r.kind, key: r.key, value: r.value, provenance: r.provenance, sourceRef: r.sourceRef, retentionDays: r.retentionDays, expiresAt: r.expiresAt, updatedAt: r.updatedAt };
  }
}
