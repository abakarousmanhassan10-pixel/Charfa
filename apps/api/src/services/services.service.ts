import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { moneyOut, toDecimal } from '../common/money';
import { pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateServiceDto, ServiceQueryDto, UpdateServiceDto } from './services.dto';

const INCLUDE = { category: { select: { id: true, name: true } } } satisfies Prisma.ServiceInclude;
type ServiceRow = Prisma.ServiceGetPayload<{ include: typeof INCLUDE }>;

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly categories: CategoriesService,
  ) {}

  private toDto(s: ServiceRow) {
    const { businessId: _b, deletedAt: _d, price, ...rest } = s;
    return { ...rest, price: moneyOut(price) };
  }

  private async find(tenant: TenantContext, id: string) {
    const s = await this.prisma.service.findFirst({ where: { id, businessId: tenant.businessId, deletedAt: null }, include: INCLUDE });
    if (!s) throw new NotFoundException({ code: 'SERVICE_NOT_FOUND', message: 'Service not found' });
    return s;
  }

  async list(tenant: TenantContext, q: ServiceQueryDto) {
    const where: Prisma.ServiceWhereInput = {
      businessId: tenant.businessId,
      deletedAt: null,
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.availability ? { availability: q.availability as never } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId === 'none' ? null : q.categoryId } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const orderBy: Prisma.ServiceOrderByWithRelationInput[] = [{ [q.sort]: q.sort === 'price' ? { sort: q.order, nulls: 'last' } : q.order }, { id: 'asc' }];
    const [items, total] = await Promise.all([
      this.prisma.service.findMany({ where, include: INCLUDE, orderBy, ...pageArgs(q) }),
      this.prisma.service.count({ where }),
    ]);
    return toPage(items.map((s) => this.toDto(s)), total, q);
  }

  async get(tenant: TenantContext, id: string) {
    return this.toDto(await this.find(tenant, id));
  }

  async create(tenant: TenantContext, dto: CreateServiceDto) {
    await this.categories.assertBelongs(tenant.businessId, 'SERVICE', dto.categoryId);
    const business = await this.prisma.business.findUniqueOrThrow({ where: { id: tenant.businessId }, select: { currency: true } });
    const service = await this.prisma.service.create({
      data: {
        businessId: tenant.businessId,
        name: dto.name,
        description: dto.description ?? null,
        categoryId: dto.categoryId ?? null,
        price: toDecimal(dto.price) ?? null,
        currency: dto.currency ?? business.currency,
        durationMinutes: dto.durationMinutes ?? null,
        availability: (dto.availability as never) ?? 'AVAILABLE',
        availabilityNotes: dto.availabilityNotes ?? null,
        bookingInfo: dto.bookingInfo ?? null,
        bookingUrl: dto.bookingUrl ?? null,
        status: (dto.status as never) ?? 'DRAFT',
        features: dto.features ?? [],
        benefits: dto.benefits ?? [],
        targetAudience: dto.targetAudience ?? null,
      },
      include: INCLUDE,
    });
    await this.audit.record({ action: 'service.create', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Service', entityId: service.id });
    return this.toDto(service);
  }

  async update(tenant: TenantContext, id: string, dto: UpdateServiceDto) {
    await this.find(tenant, id);
    const fields = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (fields.length === 0) throw new BadRequestException({ code: 'NO_CHANGES', message: 'Nothing to update' });
    if (dto.name === null) throw new BadRequestException({ code: 'VALIDATION', message: ['name cannot be empty'] });
    await this.categories.assertBelongs(tenant.businessId, 'SERVICE', dto.categoryId);
    const service = await this.prisma.service.update({
      where: { id },
      data: { ...dto, price: toDecimal(dto.price), availability: dto.availability as never, status: dto.status as never },
      include: INCLUDE,
    });
    await this.audit.record({ action: 'service.update', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Service', entityId: id, metadata: { fields } });
    return this.toDto(service);
  }

  async remove(tenant: TenantContext, id: string) {
    await this.find(tenant, id);
    await this.prisma.service.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
    await this.audit.record({ action: 'service.delete', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Service', entityId: id });
  }
}
