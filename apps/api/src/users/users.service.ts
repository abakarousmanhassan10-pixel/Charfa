import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { UpdateProfileDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE', business: { deletedAt: null } },
      select: { role: true, business: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...AuthService.toUserResponse(user),
      memberships: memberships.map((m) => ({ role: m.role, business: m.business })),
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { fullName: dto.fullName, locale: dto.locale, timezone: dto.timezone },
    });
    await this.audit.record({
      action: 'user.update_profile',
      actorId: userId,
      entityType: 'User',
      entityId: userId,
      metadata: { fields: Object.keys(dto) },
    });
    return AuthService.toUserResponse(user);
  }
}
