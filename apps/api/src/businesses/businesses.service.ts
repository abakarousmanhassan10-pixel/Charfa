import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Business, type BusinessRole } from '@touma/database';
import { canManageRole, roleHasPermission, ROLE_PERMISSIONS } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateBusinessDto, UpdateBusinessDto } from './dto/business.dto';
import { businessSlug } from './slug';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  slug: true,
  type: true,
  description: true,
  website: true,
  industry: true,
  country: true,
  defaultLocale: true,
  timezone: true,
  currency: true,
  brandVoice: true,
  targetAudience: true,
  objectives: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BusinessSelect;

type PublicBusiness = Pick<Business, keyof typeof PUBLIC_FIELDS>;

export function withAccess(business: PublicBusiness, role: BusinessRole) {
  return { ...business, role, permissions: [...ROLE_PERMISSIONS[role]] };
}

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async create(userId: string, dto: CreateBusinessDto) {
    const owned = await this.prisma.membership.count({
      where: { userId, role: 'OWNER', status: 'ACTIVE', business: { deletedAt: null } },
    });
    if (owned >= this.env.MAX_OWNED_BUSINESSES) {
      throw new ForbiddenException({
        code: 'BUSINESS_LIMIT_REACHED',
        message: `You can own at most ${this.env.MAX_OWNED_BUSINESSES} businesses`,
      });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const business = await this.prisma.$transaction(async (tx) => {
          const created = await tx.business.create({
            data: {
              name: dto.name,
              slug: businessSlug(dto.name),
              type: dto.type as Business['type'],
              description: dto.description,
              website: dto.website,
              industry: dto.industry,
              country: dto.country,
              defaultLocale: dto.defaultLocale ?? 'en',
              timezone: dto.timezone ?? 'UTC',
              currency: dto.currency ?? 'USD',
              brandVoice: dto.brandVoice,
              targetAudience: dto.targetAudience,
              objectives: dto.objectives,
            },
            select: PUBLIC_FIELDS,
          });
          await tx.membership.create({
            data: { userId, businessId: created.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
          });
          return created;
        });
        await this.audit.record({
          action: 'business.create',
          actorId: userId,
          businessId: business.id,
          entityType: 'Business',
          entityId: business.id,
        });
        return withAccess(business, 'OWNER');
      } catch (err) {
        const slugClash =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 2;
        if (!slugClash) throw err;
      }
    }
    throw new ConflictException({ code: 'SLUG_CONFLICT', message: 'Please try again' });
  }

  async listForUser(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE', business: { deletedAt: null } },
      select: { role: true, business: { select: PUBLIC_FIELDS } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => withAccess(m.business, m.role));
  }

  async get(tenant: TenantContext) {
    const business = await this.prisma.business.findFirstOrThrow({
      where: { id: tenant.businessId, deletedAt: null },
      select: PUBLIC_FIELDS,
    });
    return withAccess(business, tenant.role);
  }

  async update(tenant: TenantContext, dto: UpdateBusinessDto) {
    const changed = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (changed.length === 0) throw new BadRequestException({ code: 'NO_CHANGES', message: 'Nothing to update' });
    const required = ['name', 'type', 'defaultLocale', 'timezone', 'currency'] as const;
    const nulled = required.filter((k) => (dto as Record<string, unknown>)[k] === null);
    if (nulled.length) {
      throw new BadRequestException({ code: 'VALIDATION', message: nulled.map((k) => `${k} cannot be empty`) });
    }
    const business = await this.prisma.business.update({
      where: { id: tenant.businessId },
      data: { ...dto, type: dto.type as Business['type'] | undefined },
      select: PUBLIC_FIELDS,
    });
    await this.audit.record({
      action: 'business.update',
      actorId: tenant.userId,
      businessId: tenant.businessId,
      entityType: 'Business',
      entityId: tenant.businessId,
      metadata: { fields: changed },
    });
    return withAccess(business, tenant.role);
  }

  async softDelete(tenant: TenantContext, confirmName: string) {
    const business = await this.prisma.business.findFirstOrThrow({ where: { id: tenant.businessId, deletedAt: null } });
    if (confirmName !== business.name) {
      throw new BadRequestException({ code: 'CONFIRMATION_MISMATCH', message: 'Business name does not match' });
    }
    await this.prisma.business.update({ where: { id: business.id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      action: 'business.delete',
      actorId: tenant.userId,
      businessId: business.id,
      entityType: 'Business',
      entityId: business.id,
      metadata: { mode: 'soft' },
    });
  }

  /**
   * Dashboard summary built only from stored records. Nothing is estimated or zero-filled:
   * with no connected accounts or content, the lists and counts are empty.
   */
  async dashboard(tenant: TenantContext) {
    const businessId = tenant.businessId;
    const now = new Date();
    const [accounts, contentByStatus, upcoming, members] = await Promise.all([
      this.prisma.socialAccount.findMany({
        where: { businessId, deletedAt: null },
        select: { id: true, platform: true, status: true, displayName: true, username: true, lastSyncedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.content.groupBy({
        by: ['status'],
        where: { businessId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.publication.findMany({
        where: { businessId, status: { in: ['PENDING', 'QUEUED'] }, scheduledAt: { gte: now } },
        select: {
          id: true,
          platform: true,
          status: true,
          scheduledAt: true,
          timezone: true,
          content: { select: { id: true, title: true, type: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 5,
      }),
      this.prisma.membership.count({ where: { businessId, status: 'ACTIVE' } }),
    ]);
    const content = Object.fromEntries(contentByStatus.map((c) => [c.status, c._count._all]));
    return {
      socialAccounts: accounts,
      content: { total: contentByStatus.reduce((sum, c) => sum + c._count._all, 0), byStatus: content },
      upcomingPublications: upcoming,
      members,
    };
  }

  // ─── Members ────────────────────────────────────────────────────────────────

  listMembers(tenant: TenantContext) {
    return this.prisma.membership.findMany({
      where: { businessId: tenant.businessId, status: { in: ['ACTIVE', 'INVITED'] } },
      select: {
        id: true,
        role: true,
        status: true,
        joinedAt: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Loads a membership strictly inside the caller's tenant. Ids from other tenants are 404. */
  private async findMember(tenant: TenantContext, membershipId: string) {
    const member = await this.prisma.membership.findFirst({
      where: { id: membershipId, businessId: tenant.businessId, status: 'ACTIVE' },
    });
    if (!member) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found' });
    return member;
  }

  private async assertNotLastOwner(businessId: string, member: { role: BusinessRole }) {
    if (member.role !== 'OWNER') return;
    const owners = await this.prisma.membership.count({ where: { businessId, role: 'OWNER', status: 'ACTIVE' } });
    if (owners <= 1) {
      throw new BadRequestException({ code: 'LAST_OWNER', message: 'A business must keep at least one owner' });
    }
  }

  async updateMemberRole(tenant: TenantContext, membershipId: string, role: BusinessRole) {
    const member = await this.findMember(tenant, membershipId);
    if (member.id === tenant.membershipId) {
      throw new ForbiddenException({ code: 'CANNOT_CHANGE_OWN_ROLE', message: 'You cannot change your own role' });
    }
    if (!canManageRole(tenant.role, member.role) || !canManageRole(tenant.role, role)) {
      throw new ForbiddenException({ code: 'ROLE_HIERARCHY', message: 'You cannot manage this role' });
    }
    if (member.role === role) return this.listMembers(tenant);
    if (role !== 'OWNER') await this.assertNotLastOwner(tenant.businessId, member);
    await this.prisma.membership.update({ where: { id: member.id }, data: { role } });
    await this.audit.record({
      action: 'membership.role_change',
      actorId: tenant.userId,
      businessId: tenant.businessId,
      entityType: 'Membership',
      entityId: member.id,
      metadata: { from: member.role, to: role, targetUserId: member.userId },
    });
    return this.listMembers(tenant);
  }

  async removeMember(tenant: TenantContext, membershipId: string) {
    const member = await this.findMember(tenant, membershipId);
    const self = member.id === tenant.membershipId;
    if (!self && (!roleHasPermission(tenant.role, 'members.manage') || !canManageRole(tenant.role, member.role))) {
      throw new ForbiddenException({ code: 'ROLE_HIERARCHY', message: 'You cannot remove this member' });
    }
    await this.assertNotLastOwner(tenant.businessId, member);
    await this.prisma.membership.update({ where: { id: member.id }, data: { status: 'REVOKED' } });
    await this.audit.record({
      action: self ? 'membership.leave' : 'membership.remove',
      actorId: tenant.userId,
      businessId: tenant.businessId,
      entityType: 'Membership',
      entityId: member.id,
      metadata: { targetUserId: member.userId, role: member.role },
    });
  }
}
