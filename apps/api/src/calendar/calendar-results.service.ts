import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Where publication outcomes are written back to the calendar. Called by the publisher (never by the calendar itself).
 * "Published" is only ever recorded from a platform confirmation (or an explicit, audited manual confirmation).
 * Every method is idempotent.
 */
@Injectable()
export class CalendarResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async recordPublished(entryId: string, r: { publishedAt?: Date; externalUrl?: string | null; publicationId?: string; manual?: boolean }) {
    const e = await this.prisma.calendarEvent.findUnique({ where: { id: entryId }, select: { id: true, businessId: true, contentId: true, title: true, platform: true, authorizedById: true } });
    if (!e?.contentId) return { ok: false as const, reason: 'NOT_FOUND' };
    // One transaction: the content and its calendar entry change together.
    const res = await this.prisma.$transaction(async (tx) => {
      const r = await tx.content.updateMany({ where: { id: e.contentId!, status: { in: ['PUBLISHING', 'SCHEDULED', 'FAILED'] } }, data: { status: 'PUBLISHED' } });
      if (r.count) await tx.calendarEvent.update({ where: { id: e.id }, data: { dispatchState: 'DISPATCHED', status: 'DONE', lastError: null } });
      return r;
    });
    if (res.count) {
      await this.audit.record({ action: 'calendar.published', actorId: null, businessId: e.businessId, entityType: 'CalendarEvent', entityId: e.id, metadata: { publishedAt: (r.publishedAt ?? new Date()).toISOString(), externalUrl: r.externalUrl, publicationId: r.publicationId, manual: Boolean(r.manual) } });
      await this.notifications.notify({
        businessId: e.businessId, permission: 'publication.schedule', userIds: e.authorizedById ? [e.authorizedById] : [], type: 'social.published', title: `Published: ${e.title}`,
        data: { entryId: e.id, entryTitle: e.title, platform: e.platform, url: r.externalUrl ?? null, manual: Boolean(r.manual) }, dedupeKey: `published:${e.id}`,
      });
    }
    return { ok: true as const, changed: res.count > 0 };
  }

  /** A final failure: the entry becomes FAILED and the people who can retry it are told. */
  async recordFailed(entryId: string, f: { code: string; message: string }) {
    const e = await this.prisma.calendarEvent.findUnique({ where: { id: entryId }, select: { id: true, businessId: true, title: true, contentId: true, authorizedById: true, platform: true, scheduledAt: true } });
    if (!e) return { ok: false as const };
    const res = await this.prisma.calendarEvent.updateMany({ where: { id: e.id, dispatchState: { in: ['QUEUED', 'DISPATCHING', 'DISPATCHED'] } }, data: { dispatchState: 'FAILED', lastError: `${f.code}: ${f.message}`.slice(0, 500), lockedUntil: null } });
    if (!res.count) return { ok: true as const };
    if (e.contentId) await this.prisma.content.updateMany({ where: { id: e.contentId, status: { in: ['SCHEDULED', 'PUBLISHING'] } }, data: { status: 'FAILED' } });
    await this.audit.record({ action: 'calendar.dispatch_failed', actorId: null, businessId: e.businessId, entityType: 'CalendarEvent', entityId: e.id, metadata: { code: f.code, message: f.message.slice(0, 300) } });
    await this.notifications.notify({
      businessId: e.businessId, permission: 'publication.schedule', userIds: e.authorizedById ? [e.authorizedById] : [], type: 'calendar.failed', title: `Publication failed: ${e.title}`, body: f.message.slice(0, 300),
      data: { entryId: e.id, entryTitle: e.title, platform: e.platform, code: f.code }, dedupeKey: `failed:${e.id}:${e.scheduledAt.getTime()}:${f.code}`,
    });
    return { ok: true as const };
  }

  /** A failed publication is being retried: the entry goes back to "publishing". */
  async reopen(entryId: string) {
    const e = await this.prisma.calendarEvent.findUnique({ where: { id: entryId }, select: { id: true, contentId: true } });
    if (!e?.contentId) return false;
    const res = await this.prisma.content.updateMany({ where: { id: e.contentId, status: 'FAILED' }, data: { status: 'PUBLISHING' } });
    if (res.count) await this.prisma.calendarEvent.update({ where: { id: e.id }, data: { dispatchState: 'DISPATCHED', lastError: null } });
    return res.count > 0;
  }
}
