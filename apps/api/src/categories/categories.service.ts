import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type BusinessType, type CategoryKind } from '@touma/database';
import { defaultCategories, slugify } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Creates industry default categories; idempotent (existing slugs are skipped). */
  async seedDefaults(
    db: Prisma.TransactionClient | PrismaService,
    business: { id: string; type: BusinessType; defaultLocale: string },
    kinds: CategoryKind[] = ['PRODUCT', 'SERVICE'],
  ) {
    const data = kinds.flatMap((kind) =>
      defaultCategories(business.type, kind, business.defaultLocale).map((c) => ({ ...c, kind, businessId: business.id, isDefault: true })),
    );
    const res = await db.category.createMany({ data, skipDuplicates: true });
    return res.count;
  }

  async list(tenant: TenantContext, kind: CategoryKind) {
    const rows = await this.prisma.category.findMany({
      where: { businessId: tenant.businessId, kind },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: kind === 'PRODUCT' ? { products: { where: { deletedAt: null } } } : { services: { where: { deletedAt: null } } },
        },
      },
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      itemCount: (_count as { products?: number; services?: number }).products ?? (_count as { services?: number }).services ?? 0,
    }));
  }

  private async find(tenant: TenantContext, kind: CategoryKind, id: string) {
    const c = await this.prisma.category.findFirst({ where: { id, businessId: tenant.businessId, kind } });
    if (!c) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
    return c;
  }

  /** Used by product/service services: a categoryId must belong to the same business and kind. */
  async assertBelongs(businessId: string, kind: CategoryKind, id: string | null | undefined) {
    if (!id) return;
    const count = await this.prisma.category.count({ where: { id, businessId, kind } });
    if (count !== 1) throw new BadRequestException({ code: 'INVALID_CATEGORY', message: 'Category does not exist in this business' });
  }

  private async uniqueSlug(businessId: string, kind: CategoryKind, name: string, excludeId?: string) {
    const base = slugify(name);
    const taken = await this.prisma.category.findMany({
      where: { businessId, kind, slug: { startsWith: base }, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { slug: true },
    });
    const set = new Set(taken.map((t) => t.slug));
    if (!set.has(base)) return base;
    for (let i = 2; i < 1000; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
    throw new ConflictException({ code: 'CATEGORY_EXISTS', message: 'Too many similar categories' });
  }

  private async assertNameFree(businessId: string, kind: CategoryKind, name: string, excludeId?: string) {
    const clash = await this.prisma.category.count({
      where: { businessId, kind, name: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (clash) throw new ConflictException({ code: 'CATEGORY_EXISTS', message: 'A category with this name already exists' });
  }

  async create(tenant: TenantContext, kind: CategoryKind, dto: CreateCategoryDto) {
    const count = await this.prisma.category.count({ where: { businessId: tenant.businessId, kind } });
    if (count >= 200) throw new BadRequestException({ code: 'CATEGORY_LIMIT', message: 'Maximum 200 categories' });
    await this.assertNameFree(tenant.businessId, kind, dto.name);
    const category = await this.prisma.category.create({
      data: {
        businessId: tenant.businessId,
        kind,
        name: dto.name,
        slug: await this.uniqueSlug(tenant.businessId, kind, dto.name),
        description: dto.description ?? null,
        sortOrder: dto.sortOrder ?? count,
      },
    });
    await this.audit.record({ action: 'category.create', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Category', entityId: category.id });
    return { ...category, itemCount: 0 };
  }

  async update(tenant: TenantContext, kind: CategoryKind, id: string, dto: UpdateCategoryDto) {
    await this.find(tenant, kind, id);
    if (dto.name !== undefined) await this.assertNameFree(tenant.businessId, kind, dto.name, id);
    const category = await this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        sortOrder: dto.sortOrder,
        ...(dto.name !== undefined ? { slug: await this.uniqueSlug(tenant.businessId, kind, dto.name, id) } : {}),
      },
    });
    await this.audit.record({ action: 'category.update', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Category', entityId: id });
    return category;
  }

  /** Deleting a category keeps its items; they simply become uncategorised. */
  async remove(tenant: TenantContext, kind: CategoryKind, id: string) {
    await this.find(tenant, kind, id);
    await this.prisma.category.delete({ where: { id } });
    await this.audit.record({ action: 'category.delete', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Category', entityId: id });
  }

  async restoreDefaults(tenant: TenantContext, kind: CategoryKind) {
    const business = await this.prisma.business.findUniqueOrThrow({ where: { id: tenant.businessId } });
    const created = await this.seedDefaults(this.prisma, business, [kind]);
    return { created, categories: await this.list(tenant, kind) };
  }
}
