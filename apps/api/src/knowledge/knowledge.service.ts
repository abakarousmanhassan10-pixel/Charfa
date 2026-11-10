import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type KnowledgeCategory } from '@touma/database';
import { KNOWLEDGE_CATEGORIES } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { moneyOut } from '../common/money';
import { pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateKnowledgeDto, KnowledgeQueryDto, UpdateKnowledgeDto } from './knowledge.dto';

const SELECT = {
  id: true,
  category: true,
  source: true,
  title: true,
  body: true,
  verified: true,
  verifiedAt: true,
  verifiedBy: { select: { id: true, fullName: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeEntrySelect;

/** Knowledge an AI agent needs to answer customers. Missing ones are surfaced, never guessed. */
const ESSENTIAL: KnowledgeCategory[] = ['COMPANY', 'DELIVERY_POLICY', 'RETURN_POLICY', 'CUSTOMER_SUPPORT'];
const CONTEXT_LIMIT = 300;

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext, q: KnowledgeQueryDto) {
    const where: Prisma.KnowledgeEntryWhereInput = {
      businessId: tenant.businessId,
      deletedAt: null,
      ...(q.category ? { category: q.category as KnowledgeCategory } : {}),
      ...(q.verified ? { verified: q.verified === 'true' } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { body: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.knowledgeEntry.findMany({ where, select: SELECT, orderBy: [{ category: 'asc' }, { updatedAt: 'desc' }], ...pageArgs(q) }),
      this.prisma.knowledgeEntry.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  async summary(tenant: TenantContext) {
    const rows = await this.prisma.knowledgeEntry.groupBy({
      by: ['category', 'verified'],
      where: { businessId: tenant.businessId, deletedAt: null },
      _count: { _all: true },
    });
    return KNOWLEDGE_CATEGORIES.map((category) => ({
      category,
      verified: rows.find((r) => r.category === category && r.verified)?._count._all ?? 0,
      unverified: rows.find((r) => r.category === category && !r.verified)?._count._all ?? 0,
    }));
  }

  private async find(tenant: TenantContext, id: string) {
    const e = await this.prisma.knowledgeEntry.findFirst({ where: { id, businessId: tenant.businessId, deletedAt: null }, select: SELECT });
    if (!e) throw new NotFoundException({ code: 'KNOWLEDGE_NOT_FOUND', message: 'Knowledge entry not found' });
    return e;
  }

  get(tenant: TenantContext, id: string) {
    return this.find(tenant, id);
  }

  async create(tenant: TenantContext, dto: CreateKnowledgeDto) {
    const count = await this.prisma.knowledgeEntry.count({ where: { businessId: tenant.businessId, deletedAt: null } });
    if (count >= 2000) throw new BadRequestException({ code: 'KNOWLEDGE_LIMIT', message: 'Maximum 2000 entries' });
    const entry = await this.prisma.knowledgeEntry.create({
      data: {
        businessId: tenant.businessId,
        source: 'MANUAL',
        category: dto.category as KnowledgeCategory,
        title: dto.title,
        body: dto.body,
        createdById: tenant.userId,
      },
      select: SELECT,
    });
    await this.audit.record({ action: 'knowledge.create', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'KnowledgeEntry', entityId: entry.id });
    return entry;
  }

  /** Any edit invalidates the previous verification: a changed fact must be re-approved. */
  async update(tenant: TenantContext, id: string, dto: UpdateKnowledgeDto) {
    await this.find(tenant, id);
    const fields = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (fields.length === 0) throw new BadRequestException({ code: 'NO_CHANGES', message: 'Nothing to update' });
    const entry = await this.prisma.knowledgeEntry.update({
      where: { id },
      data: { ...dto, category: dto.category as KnowledgeCategory | undefined, verified: false, verifiedAt: null, verifiedById: null },
      select: SELECT,
    });
    await this.audit.record({ action: 'knowledge.update', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'KnowledgeEntry', entityId: id, metadata: { fields, verificationReset: true } });
    return entry;
  }

  async setVerified(tenant: TenantContext, id: string, verified: boolean) {
    await this.find(tenant, id);
    const entry = await this.prisma.knowledgeEntry.update({
      where: { id },
      data: verified
        ? { verified: true, verifiedAt: new Date(), verifiedById: tenant.userId }
        : { verified: false, verifiedAt: null, verifiedById: null },
      select: SELECT,
    });
    await this.audit.record({ action: verified ? 'knowledge.verify' : 'knowledge.unverify', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'KnowledgeEntry', entityId: id });
    return entry;
  }

  async remove(tenant: TenantContext, id: string) {
    await this.find(tenant, id);
    await this.prisma.knowledgeEntry.update({ where: { id }, data: { deletedAt: new Date(), verified: false } });
    await this.audit.record({ action: 'knowledge.delete', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'KnowledgeEntry', entityId: id });
  }

  /**
   * The ONLY entry point through which AI agents (Phase 3) obtain business facts.
   * - Scoped strictly by the verified TenantContext: every query filters on its businessId.
   * - Includes only VERIFIED knowledge entries and ACTIVE catalog items (catalog data is entered by the
   *   business itself and is authoritative).
   * - Unknown values stay explicit (null / "not tracked") and missing essentials are listed so agents
   *   can say "I don't know" instead of inventing prices, stock or policies.
   */
  async buildAgentContext(tenant: TenantContext) {
    const businessId = tenant.businessId;
    const [business, products, services, entries] = await Promise.all([
      this.prisma.business.findFirstOrThrow({
        where: { id: businessId, deletedAt: null },
        select: {
          name: true, type: true, description: true, industry: true, website: true, country: true, city: true, address: true,
          contactEmail: true, contactPhone: true, timezone: true, currency: true, defaultLocale: true, brandVoice: true,
          targetAudience: true, objectives: true,
        },
      }),
      this.prisma.product.findMany({
        where: { businessId, deletedAt: null, status: 'ACTIVE' },
        select: {
          id: true, name: true, description: true, sku: true, price: true, discountPrice: true, currency: true, stockQuantity: true,
          availability: true, features: true, benefits: true, targetAudience: true, url: true, category: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
        take: CONTEXT_LIMIT,
      }),
      this.prisma.service.findMany({
        where: { businessId, deletedAt: null, status: 'ACTIVE' },
        select: {
          id: true, name: true, description: true, price: true, currency: true, durationMinutes: true, availability: true,
          availabilityNotes: true, bookingInfo: true, bookingUrl: true, features: true, benefits: true, targetAudience: true,
          category: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
        take: CONTEXT_LIMIT,
      }),
      this.prisma.knowledgeEntry.findMany({
        where: { businessId, deletedAt: null, verified: true },
        select: { id: true, category: true, title: true, body: true, verifiedAt: true },
        orderBy: [{ category: 'asc' }, { updatedAt: 'desc' }],
        take: CONTEXT_LIMIT,
      }),
    ]);

    const covered = new Set(entries.map((e) => e.category));
    return {
      businessId,
      generatedAt: new Date().toISOString(),
      business,
      products: products.map(({ category, price, discountPrice, stockQuantity, ...p }) => ({
        ...p,
        category: category?.name ?? null,
        price: moneyOut(price),
        discountPrice: moneyOut(discountPrice),
        stock: stockQuantity === null ? 'not tracked' : stockQuantity,
      })),
      services: services.map(({ category, price, ...s }) => ({ ...s, category: category?.name ?? null, price: moneyOut(price) })),
      knowledge: entries,
      missingInformation: [
        ...ESSENTIAL.filter((c) => !covered.has(c)).map((c) => `No verified ${c.toLowerCase().replace(/_/g, ' ')} information`),
        ...products.filter((p) => p.price === null).map((p) => `Price not set for product "${p.name}"`),
        ...services.filter((s) => s.price === null).map((s) => `Price not set for service "${s.name}"`),
      ],
    };
  }
}
