import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BusinessRole } from '@touma/database';
import { canManageRole } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256 } from '../common/crypto/token-cipher';
import type { RequestMeta } from '../common/request-meta';
import { emails, EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const MAX_PENDING = 50;
const MAX_SENDS = 5;
const RESEND_COOLDOWN_MS = 60_000;

/**
 * Email invitations. The emailed token (stored only as a hash) proves control of the invited
 * address; acceptance requires being signed in with that same address. Roles follow the hierarchy:
 * nobody can invite at or above their own rank (owners may invite owners).
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  private pendingWhere(businessId: string) {
    return { businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } };
  }

  private dto(i: { id: string; email: string; role: BusinessRole; expiresAt: Date; createdAt: Date; sendCount: number; lastSentAt: Date; invitedBy?: { fullName: string } | null }) {
    return { id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt, sendCount: i.sendCount, lastSentAt: i.lastSentAt, invitedBy: i.invitedBy?.fullName ?? null };
  }

  list(tenant: TenantContext) {
    return this.prisma.invitation
      .findMany({ where: this.pendingWhere(tenant.businessId), include: { invitedBy: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' } })
      .then((rows) => rows.map((r) => this.dto(r)));
  }

  private async sendEmail(invitationId: string, token: string) {
    const inv = await this.prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      include: { business: { select: { name: true, defaultLocale: true } }, invitedBy: { select: { fullName: true } } },
    });
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email }, select: { locale: true } });
    await this.email.send(
      emails.invitation(inv.email, existing?.locale ?? inv.business.defaultLocale, this.email.link('/invitations/accept', token), inv.business.name, inv.invitedBy?.fullName ?? 'TOUMA', inv.role),
    );
  }

  async create(tenant: TenantContext, email: string, role: BusinessRole, meta: RequestMeta) {
    const inviter = await this.prisma.user.findUniqueOrThrow({ where: { id: tenant.userId } });
    if (!inviter.emailVerifiedAt) throw new ForbiddenException({ code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address before inviting people' });
    if (!canManageRole(tenant.role, role)) throw new ForbiddenException({ code: 'ROLE_HIERARCHY', message: 'You cannot invite someone with this role' });
    const member = await this.prisma.membership.findFirst({ where: { businessId: tenant.businessId, status: 'ACTIVE', user: { email } } });
    if (member) throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'This person is already a member' });
    if ((await this.prisma.invitation.count({ where: this.pendingWhere(tenant.businessId) })) >= MAX_PENDING) {
      throw new BadRequestException({ code: 'INVITATION_LIMIT', message: `At most ${MAX_PENDING} pending invitations` });
    }
    const token = randomToken(32);
    const [, invitation] = await this.prisma.$transaction([
      // Only one live invitation per address: older ones stop working.
      this.prisma.invitation.updateMany({ where: { ...this.pendingWhere(tenant.businessId), email }, data: { revokedAt: new Date() } }),
      this.prisma.invitation.create({
        data: { businessId: tenant.businessId, email, role, tokenHash: sha256(token), invitedById: tenant.userId, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
        include: { invitedBy: { select: { fullName: true } } },
      }),
    ]);
    await this.sendEmail(invitation.id, token).catch((err) => this.logger.error(`Invitation email failed: ${(err as Error).message}`));
    await this.audit.record({ action: 'invitation.create', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Invitation', entityId: invitation.id, ...meta, metadata: { email, role } });
    return this.dto(invitation);
  }

  private async findPending(tenant: TenantContext, id: string) {
    const inv = await this.prisma.invitation.findFirst({ where: { id, ...this.pendingWhere(tenant.businessId) } });
    if (!inv) throw new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' });
    if (!canManageRole(tenant.role, inv.role)) throw new ForbiddenException({ code: 'ROLE_HIERARCHY', message: 'You cannot manage this invitation' });
    return inv;
  }

  /** New token (the previous link stops working), new expiry, limited number of sends. */
  async resend(tenant: TenantContext, id: string) {
    const inv = await this.findPending(tenant, id);
    if (inv.sendCount >= MAX_SENDS) throw new BadRequestException({ code: 'RESEND_LIMIT', message: 'This invitation was sent too many times' });
    if (Date.now() - inv.lastSentAt.getTime() < RESEND_COOLDOWN_MS) throw new HttpException({ code: 'TOO_SOON', message: 'Please wait a minute before resending' }, HttpStatus.TOO_MANY_REQUESTS);
    const token = randomToken(32);
    const updated = await this.prisma.invitation.update({
      where: { id },
      data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), sendCount: { increment: 1 }, lastSentAt: new Date() },
      include: { invitedBy: { select: { fullName: true } } },
    });
    await this.sendEmail(id, token);
    await this.audit.record({ action: 'invitation.resend', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Invitation', entityId: id });
    return this.dto(updated);
  }

  async revoke(tenant: TenantContext, id: string) {
    await this.findPending(tenant, id);
    await this.prisma.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record({ action: 'invitation.revoke', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Invitation', entityId: id });
  }

  private async byToken(token: string) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { business: { select: { id: true, name: true, deletedAt: true } } } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date() || inv.business.deletedAt) return null;
    return inv;
  }

  /** Public: what the token holder needs to decide (no ids, nothing else about the business). */
  async lookup(token: string) {
    const inv = await this.byToken(token);
    if (!inv) throw new NotFoundException({ code: 'INVITATION_INVALID', message: 'This invitation is invalid or has expired' });
    return { businessName: inv.business.name, role: inv.role, email: inv.email, expiresAt: inv.expiresAt };
  }

  async accept(userId: string, token: string, meta: RequestMeta) {
    const inv = await this.byToken(token);
    if (!inv) throw new NotFoundException({ code: 'INVITATION_INVALID', message: 'This invitation is invalid or has expired' });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
      await this.audit.record({ action: 'invitation.email_mismatch', actorId: userId, businessId: inv.businessId, entityType: 'Invitation', entityId: inv.id, ...meta });
      throw new ForbiddenException({ code: 'INVITATION_EMAIL_MISMATCH', message: `This invitation was sent to another email address. Sign in as ${inv.email} to accept it.` });
    }
    const existing = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId, businessId: inv.businessId } } });
    if (existing?.status === 'ACTIVE') throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'You are already a member of this business' });

    await this.prisma.$transaction(async (tx) => {
      // Atomic single use: a concurrent acceptance of the same token loses.
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date(), acceptedById: userId },
      });
      if (claimed.count !== 1) throw new NotFoundException({ code: 'INVITATION_INVALID', message: 'This invitation is invalid or has expired' });
      // The role comes from the invitation record only, never from the request.
      if (existing) await tx.membership.update({ where: { id: existing.id }, data: { status: 'ACTIVE', role: inv.role, joinedAt: new Date(), invitedById: inv.invitedById } });
      else await tx.membership.create({ data: { userId, businessId: inv.businessId, role: inv.role, status: 'ACTIVE', joinedAt: new Date(), invitedById: inv.invitedById } });
      if (!user.emailVerifiedAt) await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    });
    await this.audit.record({ action: 'invitation.accept', actorId: userId, businessId: inv.businessId, entityType: 'Invitation', entityId: inv.id, ...meta, metadata: { role: inv.role } });
    return { businessId: inv.businessId, businessName: inv.business.name, role: inv.role };
  }
}
