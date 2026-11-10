import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { MediaService } from '../media/media.service';
import { assertDiscount, moneyOut, toDecimal } from '../common/money';
import { pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateProductDto, ProductQueryDto, UpdateProductDto } from './products.dto';

const INCLUDE = {
  category: { select: { id: true, name: true } },
  media: { orderBy: { position: 'asc' }, include: { media: true } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof INCLUDE }>;

const MAX_PRODUCTS = 10_000;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly categories: CategoriesService,
    private readonly media: MediaService,
  ) {}

  private toDto(p: ProductRow) {
    const { businessId: _b, deletedAt: _d, media, price, discountPrice, ...rest } = p;
    return {
      ...rest,
      price: moneyOut(price),
      discountPrice: moneyOut(discountPrice),
      media: media.filter((m) => !m.media.deletedAt && m.media.status === 'READY').map((m) => ({ ...this.media.toDto(m.media), position: m.position })),
    };
  }

  private async find(tenant: TenantContext, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, businessId: tenant.businessId, deletedAt: null }, include: INCLUDE });
    if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    return p;
  }

  private conflict(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictException({ code: 'SKU_TAKEN', message: 'Another product already uses this SKU' });
    }
    throw err;
  }

  async list(tenant: TenantContext, q: ProductQueryDto) {
    const where: Prisma.ProductWhereInput = {
      businessId: tenant.businessId,
      deletedAt: null,
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.availability ? { availability: q.availability as never } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId === 'none' ? null : q.categoryId } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { sku: { contains: q.q, mode: 'insensitive' } },
              { description: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = [{ [q.sort]: q.sort === 'price' ? { sort: q.order, nulls: 'last' } : q.order }, { id: 'asc' }];
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: INCLUDE, orderBy, ...pageArgs(q) }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(items.map((p) => this.toDto(p)), total, q);
  }

  async get(tenant: TenantContext, id: string) {
    return this.toDto(await this.find(tenant, id));
  }

  async create(tenant: TenantContext, dto: CreateProductDto) {
    if ((await this.prisma.product.count({ where: { businessId: tenant.businessId, deletedAt: null } })) >= MAX_PRODUCTS) {
      throw new BadRequestException({ code: 'PRODUCT_LIMIT', message: `Maximum ${MAX_PRODUCTS} products` });
    }
    await this.categories.assertBelongs(tenant.businessId, 'PRODUCT', dto.categoryId);
    const price = toDecimal(dto.price) ?? null;
    const discountPrice = toDecimal(dto.discountPrice) ?? null;
    assertDiscount(price, discountPrice);
    const business = await this.prisma.business.findUniqueOrThrow({ where: { id: tenant.businessId }, select: { currency: true } });
    const product = await this.prisma.product
      .create({
        data: {
          businessId: tenant.businessId,
          name: dto.name,
          description: dto.description ?? null,
          categoryId: dto.categoryId ?? null,
          price,
          discountPrice,
          currency: dto.currency ?? business.currency,
          sku: dto.sku ?? null,
          stockQuantity: dto.stockQuantity ?? null,
          availability: (dto.availability as never) ?? 'IN_STOCK',
          status: (dto.status as never) ?? 'DRAFT',
          features: dto.features ?? [],
          benefits: dto.benefits ?? [],
          targetAudience: dto.targetAudience ?? null,
          url: dto.url ?? null,
        },
        include: INCLUDE,
      })
      .catch((e) => this.conflict(e));
    await this.audit.record({ action: 'product.create', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Product', entityId: product.id });
    return this.toDto(product);
  }

  async update(tenant: TenantContext, id: string, dto: UpdateProductDto) {
    const current = await this.find(tenant, id);
    const fields = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (fields.length === 0) throw new BadRequestException({ code: 'NO_CHANGES', message: 'Nothing to update' });
    if (dto.name === null) throw new BadRequestException({ code: 'VALIDATION', message: ['name cannot be empty'] });
    await this.categories.assertBelongs(tenant.businessId, 'PRODUCT', dto.categoryId);
    const price = dto.price !== undefined ? toDecimal(dto.price)! : current.price;
    const discountPrice = dto.discountPrice !== undefined ? toDecimal(dto.discountPrice)! : current.discountPrice;
    assertDiscount(price, discountPrice);
    const product = await this.prisma.product
      .update({
        where: { id },
        data: {
          ...dto,
          price: dto.price !== undefined ? price : undefined,
          discountPrice: dto.discountPrice !== undefined ? discountPrice : undefined,
          availability: dto.availability as never,
          status: dto.status as never,
        },
        include: INCLUDE,
      })
      .catch((e) => this.conflict(e));
    await this.audit.record({ action: 'product.update', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Product', entityId: id, metadata: { fields } });
    return this.toDto(product);
  }

  /** Soft delete. The SKU is released so it can be reused by a new product. */
  async remove(tenant: TenantContext, id: string) {
    const p = await this.find(tenant, id);
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date(), sku: null, status: 'ARCHIVED' } });
    await this.audit.record({ action: 'product.delete', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Product', entityId: id, metadata: { sku: p.sku } });
  }

  async setMedia(tenant: TenantContext, id: string, mediaIds: string[]) {
    await this.find(tenant, id);
    if (new Set(mediaIds).size !== mediaIds.length) throw new BadRequestException({ code: 'VALIDATION', message: ['mediaIds must be unique'] });
    await this.media.assertUsable(tenant.businessId, mediaIds);
    await this.prisma.$transaction([
      this.prisma.productMedia.deleteMany({ where: { productId: id } }),
      this.prisma.productMedia.createMany({ data: mediaIds.map((mediaId, position) => ({ productId: id, mediaId, position })) }),
    ]);
    await this.audit.record({ action: 'product.media_update', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Product', entityId: id, metadata: { count: mediaIds.length } });
    return this.get(tenant, id);
  }
}
