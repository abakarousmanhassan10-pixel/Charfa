import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Customer, type LeadStatus } from '@touma/database';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CustomersQueryDto, NoteDto, UpdateCustomerDto } from './sales.dto';

/** Customer profiles, lead status, internal notes and erasure. Every query is scoped by the business of the signed-in member. */
@Injectable()
export class SalesCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  dto(c: Customer & { _count?: { conversations: number } }) {
    return {
      id: c.id, name: c.name, email: c.email, phone: c.phone, language: c.language, source: c.source, leadStatus: c.leadStatus, purchaseIntent: c.purchaseIntent, lastIntent: c.lastIntent, interests: c.interests,
      consent: c.consentAt !== null, assignedToId: c.assignedToId, followUpAt: c.followUpAt?.toISOString() ?? null, firstSeenAt: c.firstSeenAt.toISOString(), lastSeenAt: c.lastSeenAt.toISOString(),
      anonymized: c.anonymizedAt !== null, conversations: c._count?.conversations ?? undefined,
    };
  }

  async list(tenant: TenantContext, q: CustomersQueryDto) {
    const where: Prisma.CustomerWhereInput = {
      businessId: tenant.businessId, ...(q.leadStatus ? { leadStatus: q.leadStatus as LeadStatus } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { lastSeenAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { _count: { select: { conversations: true } } } }),
      this.prisma.customer.count({ where }),
    ]);
    return { items: rows.map((r) => this.dto(r)), total, page: q.page, pageSize: q.pageSize, pageCount: Math.max(1, Math.ceil(total / q.pageSize)) };
  }

  private async find(tenant: TenantContext, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, businessId: tenant.businessId }, include: { _count: { select: { conversations: true } } } });
    if (!c) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
    return c;
  }

  async get(tenant: TenantContext, id: string) {
    const c = await this.find(tenant, id);
    const [conversations, notes] = await Promise.all([
      this.prisma.conversation.findMany({ where: { customerId: id, businessId: tenant.businessId, isTest: false }, orderBy: { lastMessageAt: 'desc' }, take: 20, select: { id: true, status: true, aiMode: true, intent: true, purchaseIntent: true, lastMessageAt: true, createdAt: true } }),
      this.prisma.customerNote.findMany({ where: { customerId: id, businessId: tenant.businessId }, orderBy: { createdAt: 'desc' }, take: 50, include: { author: { select: { fullName: true } } } }),
    ]);
    return {
      ...this.dto(c),
      conversationList: conversations.map((x) => ({ ...x, lastMessageAt: x.lastMessageAt?.toISOString() ?? null, createdAt: x.createdAt.toISOString() })),
      notes: notes.map((n) => ({ id: n.id, body: n.body, authorName: n.author?.fullName ?? null, conversationId: n.conversationId, createdAt: n.createdAt.toISOString() })),
    };
  }

  async update(tenant: TenantContext, id: string, dto: UpdateCustomerDto) {
    const c = await this.find(tenant, id);
    if (c.anonymizedAt) throw new BadRequestException({ code: 'CUSTOMER_ERASED', message: 'This customer was erased' });
    let followUpAt: Date | null | undefined;
    if (dto.followUpAt !== undefined) {
      followUpAt = dto.followUpAt === null ? null : new Date(dto.followUpAt);
      if (followUpAt && Number.isNaN(followUpAt.getTime())) throw new BadRequestException({ code: 'INVALID_DATE', message: 'followUpAt must be a valid date' });
    }
    if (dto.assignedToId) {
      const m = await this.prisma.membership.findFirst({ where: { businessId: tenant.businessId, userId: dto.assignedToId, status: 'ACTIVE' } });
      if (!m) throw new BadRequestException({ code: 'ASSIGNEE_NOT_MEMBER', message: 'The assignee must be an active member of this business' });
    }
    const updated = await this.prisma.customer.update({
      where: { id },
      data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.email !== undefined ? { email: dto.email } : {}), ...(dto.phone !== undefined ? { phone: dto.phone } : {}), ...(dto.leadStatus ? { leadStatus: dto.leadStatus as LeadStatus } : {}), ...(followUpAt !== undefined ? { followUpAt } : {}), ...(dto.assignedToId !== undefined ? { assignedToId: dto.assignedToId } : {}) },
      include: { _count: { select: { conversations: true } } },
    });
    await this.audit.record({ action: 'sales.customer_updated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Customer', entityId: id, metadata: { fields: Object.keys(dto), leadStatus: dto.leadStatus } });
    return this.dto(updated);
  }

  async addNote(tenant: TenantContext, id: string, dto: NoteDto) {
    await this.find(tenant, id);
    if (dto.conversationId) {
      const conv = await this.prisma.conversation.findFirst({ where: { id: dto.conversationId, businessId: tenant.businessId, customerId: id } });
      if (!conv) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found for this customer' });
    }
    const n = await this.prisma.customerNote.create({ data: { businessId: tenant.businessId, customerId: id, conversationId: dto.conversationId ?? null, authorId: tenant.userId, body: dto.body } });
    await this.audit.record({ action: 'sales.note_added', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Customer', entityId: id, metadata: { noteId: n.id } });
    return { id: n.id, body: n.body, conversationId: n.conversationId, createdAt: n.createdAt.toISOString() };
  }

  async deleteNote(tenant: TenantContext, customerId: string, noteId: string) {
    const n = await this.prisma.customerNote.findFirst({ where: { id: noteId, customerId, businessId: tenant.businessId } });
    if (!n) throw new NotFoundException({ code: 'NOTE_NOT_FOUND', message: 'Note not found' });
    await this.prisma.customerNote.delete({ where: { id: noteId } });
    return { deleted: true };
  }

  /** Privacy: removes the person's data (contact details, interests, notes, their message texts) and keeps only anonymous statistics. */
  async erase(tenant: TenantContext, id: string) {
    const c = await this.find(tenant, id);
    await this.prisma.$transaction([
      this.prisma.customer.update({ where: { id }, data: { name: null, email: null, phone: null, interests: [], consentAt: null, anonymizedAt: new Date(), assignedToId: null, followUpAt: null } }),
      this.prisma.customerNote.deleteMany({ where: { customerId: id } }),
      this.prisma.message.updateMany({ where: { businessId: tenant.businessId, authorType: 'CUSTOMER', conversation: { customerId: id } }, data: { body: '[erased]', aiMetadata: Prisma.DbNull } }),
      this.prisma.conversation.updateMany({ where: { customerId: id }, data: { customerName: null, publicTokenHash: null } }),
    ]);
    await this.audit.record({ action: 'sales.customer_erased', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Customer', entityId: id, metadata: { wasAnonymized: c.anonymizedAt !== null } });
    return { id, anonymized: true };
  }
}
