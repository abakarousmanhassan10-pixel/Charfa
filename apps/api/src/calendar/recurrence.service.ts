import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ContentPillar, SocialPlatform } from '@touma/database';
import { CALENDAR_LIMITS, addDays, diffDays, isValidDate, todayIn, weekdayOf, zonedToUtc } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { CalendarService } from './calendar.service';
import type { CreateRecurrenceDto } from './calendar.dto';
import { SchedulingService } from './scheduling.service';

/**
 * Recurring schedules ("every Monday and Thursday at 09:00"). Occurrences are computed from LOCAL wall-clock time in
 * the business timezone, so 09:00 stays 09:00 across daylight-saving changes, and are materialised as ordinary DRAFT
 * calendar entries. Each occurrence still needs its own approval and authorization.
 */
@Injectable()
export class RecurrenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly scheduling: SchedulingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Local dates (YYYY-MM-DD) matched by a rule between its start and end. */
  static occurrenceDates(r: { frequency: string; weekdays: number[]; startDate: string; endDate: string }) {
    const out: string[] = [];
    const days = diffDays(r.startDate, r.endDate);
    for (let i = 0; i <= days; i++) {
      const date = addDays(r.startDate, i);
      if (r.frequency === 'DAILY' || r.weekdays.includes(weekdayOf(date))) out.push(date);
    }
    return out;
  }

  async create(tenant: TenantContext, dto: CreateRecurrenceDto) {
    const bt = await this.calendar.businessTime(tenant.businessId);
    if (!isValidDate(dto.startDate) || !isValidDate(dto.endDate)) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'startDate and endDate must be valid dates' });
    const span = diffDays(dto.startDate, dto.endDate);
    if (span < 0) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'endDate must not be before startDate' });
    if (span > CALENDAR_LIMITS.recurrenceMaxDays) throw new BadRequestException({ code: 'RANGE_TOO_LARGE', message: `A recurring schedule can cover at most ${CALENDAR_LIMITS.recurrenceMaxDays} days` });
    if (dto.frequency === 'WEEKLY' && !dto.weekdays?.length) throw new BadRequestException({ code: 'WEEKDAYS_REQUIRED', message: 'Choose at least one weekday' });
    const weekdays = dto.frequency === 'WEEKLY' ? [...new Set(dto.weekdays)].sort() : [];
    const dates = RecurrenceService.occurrenceDates({ frequency: dto.frequency, weekdays, startDate: dto.startDate, endDate: dto.endDate });
    if (dates.length > CALENDAR_LIMITS.recurrenceMaxOccurrences) throw new UnprocessableEntityException({ code: 'TOO_MANY_OCCURRENCES', message: `This schedule would create ${dates.length} entries; the limit is ${CALENDAR_LIMITS.recurrenceMaxOccurrences}` });
    const platform = dto.platform as SocialPlatform;
    const minAt = Date.now() + CALENDAR_LIMITS.minLeadMinutes * 60_000;
    const slots = dates.map((date) => ({ date, z: zonedToUtc(date, dto.localTime, bt.timezone) })).filter((s) => s.z.utc.getTime() > minAt);
    if (!slots.length) throw new UnprocessableEntityException({ code: 'NO_FUTURE_OCCURRENCES', message: 'All occurrences of this schedule are in the past' });

    const out = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, platform);
      const same = await tx.recurrenceRule.findFirst({ where: { businessId: tenant.businessId, active: true, platform, title: dto.title, frequency: dto.frequency as never, localTime: dto.localTime, startDate: dto.startDate, endDate: dto.endDate, weekdays: { equals: weekdays } } });
      if (same) throw new ConflictException({ code: 'DUPLICATE_RECURRENCE', message: 'This recurring schedule already exists', recurrenceId: same.id });
      const rule = await tx.recurrenceRule.create({ data: { businessId: tenant.businessId, platform, title: dto.title, brief: dto.brief ?? null, pillar: (dto.pillar as ContentPillar) ?? null, frequency: dto.frequency as never, weekdays, localTime: dto.localTime, timezone: bt.timezone, startDate: dto.startDate, endDate: dto.endDate, createdById: tenant.userId } });
      let conflicts = 0;
      for (const s of slots) {
        const c = await this.scheduling.detect(tx, { businessId: tenant.businessId, platform, scheduledAt: s.z.utc, timezone: bt.timezone });
        if (c.some((x) => x.code === 'SLOT_TOO_CLOSE' || x.code === 'DAILY_LIMIT')) conflicts++;
        await this.calendar.insertEntry(tx, tenant, bt, {
          title: dto.title, platform, at: s.z.utc, source: 'MANUAL', timeNote: s.z.shifted ? 'This local time does not exist on that day (clock change); it was moved forward.' : null, pillar: (dto.pillar as ContentPillar) ?? null,
          brief: dto.brief, language: bt.locale, recurrenceId: rule.id, occurrenceDate: s.date,
        });
      }
      return { rule, created: slots.length, conflicts };
    });
    await this.audit.record({ action: 'calendar.recurrence_created', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'RecurrenceRule', entityId: out.rule.id, metadata: { created: out.created, platform } });
    if (out.conflicts) await this.notifications.notify({ businessId: tenant.businessId, permission: 'publication.schedule', type: 'calendar.conflict', title: `Recurring schedule "${dto.title}" has conflicts`, data: { recurrenceId: out.rule.id, entryTitle: dto.title, count: out.conflicts }, dedupeKey: `recurrence-conflict:${out.rule.id}` });
    return { id: out.rule.id, created: out.created, skippedPast: dates.length - slots.length, conflicts: out.conflicts };
  }

  async list(tenant: TenantContext) {
    const rules = await this.prisma.recurrenceRule.findMany({ where: { businessId: tenant.businessId, active: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    const today = todayIn((await this.calendar.businessTime(tenant.businessId)).timezone);
    const counts = await this.prisma.calendarEvent.groupBy({ by: ['recurrenceId'], where: { businessId: tenant.businessId, recurrenceId: { in: rules.map((r) => r.id) }, deletedAt: null, status: { not: 'CANCELLED' } }, _count: true });
    const n = new Map(counts.map((c) => [c.recurrenceId, c._count]));
    return { today, items: rules.map((r) => ({ id: r.id, title: r.title, platform: r.platform, pillar: r.pillar, frequency: r.frequency, weekdays: r.weekdays, localTime: r.localTime, timezone: r.timezone, startDate: r.startDate, endDate: r.endDate, entries: n.get(r.id) ?? 0 })) };
  }

  /** Stops the schedule and cancels occurrences that nobody has approved yet. Approved and scheduled ones are kept (cancel them individually). */
  async remove(tenant: TenantContext, id: string) {
    const rule = await this.prisma.recurrenceRule.findFirst({ where: { id, businessId: tenant.businessId, active: true } });
    if (!rule) throw new NotFoundException({ code: 'RECURRENCE_NOT_FOUND', message: 'Recurring schedule not found' });
    const result = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, rule.platform);
      await tx.recurrenceRule.update({ where: { id }, data: { active: false } });
      const open = await tx.calendarEvent.findMany({ where: { businessId: tenant.businessId, recurrenceId: id, deletedAt: null, status: { not: 'CANCELLED' }, scheduledAt: { gt: new Date() }, content: { status: { in: ['DRAFT', 'IN_REVIEW', 'REJECTED'] } } }, select: { id: true, contentId: true } });
      for (const e of open) {
        await tx.content.update({ where: { id: e.contentId! }, data: { status: 'CANCELLED' } });
        await tx.calendarEvent.update({ where: { id: e.id }, data: { status: 'CANCELLED', placementKey: null } });
      }
      const kept = await tx.calendarEvent.count({ where: { businessId: tenant.businessId, recurrenceId: id, deletedAt: null, status: { not: 'CANCELLED' }, scheduledAt: { gt: new Date() } } });
      return { cancelled: open.length, kept };
    });
    await this.audit.record({ action: 'calendar.recurrence_removed', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'RecurrenceRule', entityId: id, metadata: result });
    return result;
  }
}
