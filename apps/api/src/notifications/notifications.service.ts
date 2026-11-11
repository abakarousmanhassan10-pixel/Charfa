import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { roleHasPermission, type Permission } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface NotifyInput {
  businessId: string;
  /** Who receives it: every active member whose role has this permission (plus any explicit extra users). */
  permission?: Permission;
  userIds?: string[];
  type: string;
  /** English fallback; the web app renders localized text from `type` and `data`. */
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** The same key for the same user is delivered once (retries and repeated checks are harmless). */
  dedupeKey?: string;
}

/** In-app notifications. Delivery never breaks the operation that triggered it. */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');
  constructor(private readonly prisma: PrismaService) {}

  async notify(input: NotifyInput): Promise<number> {
    try {
      const ids = new Set(input.userIds ?? []);
      if (input.permission) {
        const members = await this.prisma.membership.findMany({ where: { businessId: input.businessId, status: 'ACTIVE' }, select: { userId: true, role: true } });
        for (const m of members) if (roleHasPermission(m.role, input.permission)) ids.add(m.userId);
      }
      if (!ids.size) return 0;
      const res = await this.prisma.notification.createMany({
        data: [...ids].map((userId) => ({
          userId,
          businessId: input.businessId,
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 1000),
          data: (input.data ?? {}) as Prisma.InputJsonValue,
          dedupeKey: input.dedupeKey ?? null,
        })),
        skipDuplicates: true,
      });
      return res.count;
    } catch (err) {
      this.logger.error(`could not create notification ${input.type}: ${(err as Error).message}`);
      return 0;
    }
  }

  async list(userId: string, q: { businessId?: string; unread?: boolean; page: number; pageSize: number }) {
    const where: Prisma.NotificationWhereInput = { userId, ...(q.businessId ? { businessId: q.businessId } : {}), ...(q.unread ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null, ...(q.businessId ? { businessId: q.businessId } : {}) } }),
    ]);
    return { items, total, unread, page: q.page, pageSize: q.pageSize };
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (!res.count && !(await this.prisma.notification.count({ where: { id, userId } }))) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' });
    return { ok: true };
  }

  async markAllRead(userId: string, businessId?: string) {
    const res = await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(businessId ? { businessId } : {}) }, data: { readAt: new Date() } });
    return { updated: res.count };
  }
}
