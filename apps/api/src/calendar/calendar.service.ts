import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { checkGrounding, type BusinessContext } from '@touma/ai-engine';
import { Prisma, type CalendarEvent, type Content, type SocialPlatform } from '@touma/database';
import {
  AI_LANGUAGES, CALENDAR_LIMITS, PLATFORM_RULES, addDays, diffDays, isValidDate, localDayRange, roleHasPermission, todayIn, utcToZoned, zonedToUtc,
  type AiPlatform, type ContentPillar, type TimeSource,
  checkTikTokSettings,
} from '@touma/shared';
import { Inject } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateEntryDto, RangeQueryDto, UpdateEntryDto } from './calendar.dto';
import { PUBLISHING_GATEWAY, type PublishingGateway } from './publishing';
import { SchedulingService, type Conflict } from './scheduling.service';

type EventWithContent = CalendarEvent & { content: (Content & { media: Array<{ mediaId: string; position: number }> }) | null };
const EVENT_INCLUDE = { content: { include: { media: { select: { mediaId: true, position: true }, orderBy: { position: 'asc' as const } } } } } satisfies Prisma.CalendarEventInclude;

export interface BusinessTime {
  timezone: string;
  locale: string;
}

export interface ResolvedTime {
  at: Date;
  source: TimeSource;
  note: string | null;
}

export interface EntryInput {
  title: string;
  platform: SocialPlatform;
  at: Date;
  source: TimeSource;
  timeNote?: string | null;
  pillar?: ContentPillar | null;
  brief?: string | null;
  occasion?: string | null;
  contentType?: string;
  caption?: string | null;
  hashtags?: string[];
  callToAction?: string | null;
  language: string;
  origin?: 'HUMAN' | 'AI_ASSISTED';
  productId?: string | null;
  serviceId?: string | null;
  mediaIds?: string[];
  planId?: string | null;
  recurrenceId?: string | null;
  occurrenceDate?: string | null;
  aiMetadata?: Prisma.InputJsonValue;
}

const FINAL_STATUSES = ['PUBLISHING', 'PUBLISHED', 'CANCELLED'];
const TEXT_FIELDS = ['caption', 'hashtags', 'callToAction', 'title'] as const;

/**
 * Calendar entries and their approval workflow.
 *
 *   DRAFT ─submit─► IN_REVIEW ─approve─► APPROVED ─authorize─► SCHEDULED ─(Phase 6 publisher)─► PUBLISHED | FAILED
 *            ▲            └─reject─► REJECTED                       └─unschedule─► APPROVED
 *            └──── any edit of the text returns to DRAFT and clears the approval and the authorization
 *
 * Only `content.approve` may approve, only `publication.schedule` may authorize (schedule) publication. The calendar
 * never publishes: due entries are handed to the publishing interface by the calendar worker.
 */
@Injectable()
export class CalendarService {
  constructor(
    readonly prisma: PrismaService,
    readonly scheduling: SchedulingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly knowledge: KnowledgeService,
    @Inject(PUBLISHING_GATEWAY) private readonly gateway: PublishingGateway,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async businessTime(businessId: string): Promise<BusinessTime> {
    const b = await this.prisma.business.findFirst({ where: { id: businessId, deletedAt: null }, select: { timezone: true, defaultLocale: true } });
    if (!b) throw new NotFoundException({ code: 'BUSINESS_NOT_FOUND', message: 'Business not found' });
    return { timezone: b.timezone, locale: (AI_LANGUAGES as readonly string[]).includes(b.defaultLocale) ? b.defaultLocale : 'en' };
  }

  /** Turns the time fields of a request into a UTC instant, using the business timezone. No time given = recommended time. */
  async resolveTime(
    db: Prisma.TransactionClient | PrismaService,
    p: { businessId: string; platform: SocialPlatform; timezone: string; scheduledAt?: string; localDate?: string; localTime?: string; now?: Date; taken?: Date[] },
  ): Promise<ResolvedTime> {
    const now = p.now ?? new Date();
    if (p.scheduledAt) {
      const at = new Date(p.scheduledAt);
      if (Number.isNaN(at.getTime())) throw new BadRequestException({ code: 'INVALID_TIME', message: 'scheduledAt is not a valid date' });
      return { at, source: 'MANUAL', note: null };
    }
    if (p.localDate && !isValidDate(p.localDate)) throw new BadRequestException({ code: 'INVALID_TIME', message: 'localDate is not a valid date' });
    if (p.localDate && p.localTime) {
      const z = zonedToUtc(p.localDate, p.localTime, p.timezone);
      return { at: z.utc, source: 'MANUAL', note: z.shifted ? 'This local time does not exist on that day (clock change); it was moved forward.' : z.ambiguous ? 'This local time happens twice on that day (clock change); the first one was used.' : null };
    }
    if (p.localTime && !p.localDate) throw new BadRequestException({ code: 'INVALID_TIME', message: 'localTime needs localDate' });
    const date = p.localDate ?? todayIn(p.timezone, now);
    const free = await this.scheduling.firstFreeSlot(db, { businessId: p.businessId, platform: p.platform, date, timezone: p.timezone, notBefore: new Date(now.getTime() + CALENDAR_LIMITS.minLeadMinutes * 60_000), taken: p.taken });
    if (!free) throw new UnprocessableEntityException({ code: 'NO_FREE_SLOT', message: 'No free recommended time in the next 14 days. Choose a time yourself.' });
    return { at: free.at, source: free.rec.source, note: free.rec.note };
  }

  /** Creates the content draft and its calendar entry. The caller holds the scheduling lock for the platform. */
  async insertEntry(tx: Prisma.TransactionClient, tenant: Pick<TenantContext, 'businessId' | 'userId'>, bt: BusinessTime, i: EntryInput) {
    const content = await tx.content.create({
      data: {
        businessId: tenant.businessId,
        type: (i.contentType ?? 'TEXT') as never,
        title: i.title,
        caption: i.caption ?? null,
        language: i.language,
        hashtags: i.hashtags ?? [],
        callToAction: i.callToAction ?? null,
        targetPlatforms: [i.platform],
        status: 'DRAFT',
        origin: i.origin ?? 'HUMAN',
        productId: i.productId ?? null,
        serviceId: i.serviceId ?? null,
        createdById: tenant.userId,
        aiMetadata: i.aiMetadata,
        ...(i.mediaIds?.length ? { media: { create: i.mediaIds.map((mediaId, position) => ({ mediaId, position })) } } : {}),
      },
    });
    const event = await tx.calendarEvent.create({
      data: {
        businessId: tenant.businessId,
        contentId: content.id,
        title: i.title,
        brief: i.brief ?? null,
        occasion: i.occasion ?? null,
        scheduledAt: i.at,
        timezone: bt.timezone,
        platform: i.platform,
        pillar: i.pillar ?? null,
        planId: i.planId ?? null,
        recurrenceId: i.recurrenceId ?? null,
        occurrenceDate: i.occurrenceDate ?? null,
        timeSource: i.source,
        timeNote: i.timeNote ?? null,
        placementKey: `${content.id}:${i.platform}`,
        createdById: tenant.userId,
      },
      include: EVENT_INCLUDE,
    });
    return event as EventWithContent;
  }

  private async assertRefs(businessId: string, dto: { productId?: string; serviceId?: string; mediaIds?: string[] }) {
    if (dto.productId && !(await this.prisma.product.count({ where: { id: dto.productId, businessId, deletedAt: null } }))) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Product not found' });
    if (dto.serviceId && !(await this.prisma.service.count({ where: { id: dto.serviceId, businessId, deletedAt: null } }))) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'Service not found' });
    if (dto.mediaIds?.length) {
      const n = await this.prisma.mediaAsset.count({ where: { id: { in: dto.mediaIds }, businessId, deletedAt: null, status: 'READY' } });
      if (n !== dto.mediaIds.length) throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'A media item was not found or is not ready' });
    }
  }

  private async load(tenant: TenantContext, id: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<EventWithContent> {
    const e = await db.calendarEvent.findFirst({ where: { id, businessId: tenant.businessId, deletedAt: null }, include: EVENT_INCLUDE });
    if (!e) throw new NotFoundException({ code: 'ENTRY_NOT_FOUND', message: 'Calendar entry not found' });
    return e as EventWithContent;
  }

  private can(tenant: TenantContext, p: Parameters<typeof roleHasPermission>[1]) {
    return roleHasPermission(tenant.role, p);
  }

  private requirePermission(tenant: TenantContext, p: Parameters<typeof roleHasPermission>[1], message: string) {
    if (!this.can(tenant, p)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message });
  }

  static status(e: EventWithContent) {
    return e.status === 'CANCELLED' ? 'CANCELLED' : (e.content?.status ?? 'DRAFT');
  }

  toDto(e: EventWithContent, extra: { conflicts?: Conflict[] } = {}) {
    const local = utcToZoned(e.scheduledAt, e.timezone);
    const c = e.content;
    return {
      id: e.id,
      title: e.title,
      brief: e.brief,
      notes: e.notes,
      platform: e.platform,
      pillar: e.pillar,
      occasion: e.occasion,
      status: CalendarService.status(e),
      scheduledAt: e.scheduledAt.toISOString(),
      timezone: e.timezone,
      local: { date: local.date, time: local.time },
      timeSource: e.timeSource,
      timeNote: e.timeNote,
      planId: e.planId,
      recurrenceId: e.recurrenceId,
      socialAccountId: e.socialAccountId,
      authorizedAt: e.authorizedAt?.toISOString() ?? null,
      authorizedById: e.authorizedById,
      dispatchState: e.dispatchState,
      dispatchAttempts: e.dispatchAttempts,
      lastError: e.lastError,
      content: c && {
        id: c.id,
        type: c.type,
        caption: c.caption,
        hashtags: c.hashtags,
        callToAction: c.callToAction,
        language: c.language,
        origin: c.origin,
        version: c.version,
        approvedVersion: c.approvedVersion,
        approvedAt: c.approvedAt?.toISOString() ?? null,
        approvedById: c.approvedById,
        rejectionReason: c.rejectionReason,
        productId: c.productId,
        serviceId: c.serviceId,
        mediaIds: c.media.map((m) => m.mediaId),
        platformOptions: (c.platformOptions ?? null) as Record<string, unknown> | null,
      },
      conflicts: extra.conflicts ?? [],
    };
  }

  private rangeBounds(q: Pick<RangeQueryDto, 'from' | 'to'>, tz: string) {
    if (!isValidDate(q.from) || !isValidDate(q.to)) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'from and to must be valid dates (YYYY-MM-DD)' });
    const days = diffDays(q.from, q.to);
    if (days < 0) throw new BadRequestException({ code: 'INVALID_RANGE', message: 'to must not be before from' });
    if (days + 1 > CALENDAR_LIMITS.rangeMaxDays) throw new BadRequestException({ code: 'RANGE_TOO_LARGE', message: `The range is limited to ${CALENDAR_LIMITS.rangeMaxDays} days` });
    return { start: zonedToUtc(q.from, '00:00', tz).utc, end: zonedToUtc(addDays(q.to, 1), '00:00', tz).utc };
  }

  private async record(tx: Prisma.TransactionClient, tenant: TenantContext, e: EventWithContent, decision: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'AUTHORIZED' | 'REVOKED' | 'CANCELLED', note?: string | null, version?: number) {
    await tx.approvalRecord.create({ data: { businessId: tenant.businessId, contentId: e.contentId!, calendarEventId: e.id, version: version ?? e.content!.version, decision, actorId: tenant.userId, note: note ?? null } });
  }

  private async conflictNotice(tenant: TenantContext, e: { id: string; title: string; scheduledAt: Date }, conflicts: Conflict[]) {
    const soft = conflicts.filter((c) => c.code === 'SLOT_TOO_CLOSE' || c.code === 'DAILY_LIMIT');
    if (!soft.length) return;
    await this.notifications.notify({
      businessId: tenant.businessId,
      permission: 'publication.schedule',
      type: 'calendar.conflict',
      title: `Calendar conflict: ${e.title}`,
      body: soft.map((c) => c.message).join(' '),
      data: { entryId: e.id, entryTitle: e.title, codes: soft.map((c) => c.code) },
      dedupeKey: `conflict:${e.id}:${e.scheduledAt.getTime()}`,
    });
  }

  /** Soft conflicts need an explicit acknowledgement; hard ones never pass. */
  private enforce(conflicts: Conflict[], acknowledge: boolean) {
    if (this.scheduling.hasHard(conflicts)) throw new ConflictException({ code: 'CALENDAR_CONFLICT', message: conflicts.find((c) => c.severity === 'hard')!.message, conflicts });
    if (conflicts.length && !acknowledge) throw new ConflictException({ code: 'CONFLICT_CONFIRMATION_REQUIRED', message: 'This time conflicts with the calendar. Confirm to continue.', conflicts });
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  async list(tenant: TenantContext, q: RangeQueryDto) {
    const bt = await this.businessTime(tenant.businessId);
    const { start, end } = this.rangeBounds(q, bt.timezone);
    const events = await this.prisma.calendarEvent.findMany({
      where: {
        businessId: tenant.businessId,
        deletedAt: null,
        scheduledAt: { gte: start, lt: end },
        ...(q.platform ? { platform: q.platform as SocialPlatform } : {}),
        ...(q.pillar ? { pillar: q.pillar as ContentPillar } : {}),
        ...(q.status ? (q.status === 'CANCELLED' ? { status: 'CANCELLED' } : { status: { not: 'CANCELLED' }, content: { status: q.status as never } }) : {}),
      },
      include: EVENT_INCLUDE,
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: 1000,
    });
    return { timezone: bt.timezone, from: q.from, to: q.to, items: events.map((e) => this.toDto(e as EventWithContent)), conflicts: this.rangeConflicts(events as EventWithContent[]) };
  }

  /** Soft conflicts inside a set of entries (too close, over the daily limit), computed from the entries themselves. */
  rangeConflicts(events: EventWithContent[]) {
    const out: Array<{ entryId: string; code: string; message: string; withEntryId?: string }> = [];
    const active = events.filter((e) => e.platform && CalendarService.status(e) !== 'CANCELLED' && CalendarService.status(e) !== 'REJECTED');
    const byPlatform = new Map<string, EventWithContent[]>();
    for (const e of active) byPlatform.set(e.platform!, [...(byPlatform.get(e.platform!) ?? []), e]);
    for (const [platform, list] of byPlatform) {
      const rule = PLATFORM_RULES[platform as AiPlatform];
      const sorted = [...list].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        if (b.scheduledAt.getTime() - a.scheduledAt.getTime() < rule.minGapMinutes * 60_000) {
          out.push({ entryId: b.id, code: 'SLOT_TOO_CLOSE', message: `Less than ${rule.minGapMinutes / 60} h after another ${platform} post`, withEntryId: a.id });
        }
      }
      const perDay = new Map<string, EventWithContent[]>();
      for (const e of sorted) {
        const d = utcToZoned(e.scheduledAt, e.timezone).date;
        perDay.set(d, [...(perDay.get(d) ?? []), e]);
      }
      for (const day of perDay.values()) day.slice(rule.maxPerDay).forEach((e) => out.push({ entryId: e.id, code: 'DAILY_LIMIT', message: `More than ${rule.maxPerDay} ${platform} post(s) on one day` }));
    }
    return out;
  }

  async conflicts(tenant: TenantContext, q: RangeQueryDto) {
    return { items: (await this.list(tenant, { ...q, status: undefined })).conflicts };
  }

  async get(tenant: TenantContext, id: string) {
    const e = await this.load(tenant, id);
    return this.toDto(e);
  }

  async history(tenant: TenantContext, id: string) {
    await this.load(tenant, id);
    const records = await this.prisma.approvalRecord.findMany({ where: { businessId: tenant.businessId, calendarEventId: id }, orderBy: { createdAt: 'asc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return { items: records.map((r) => ({ id: r.id, decision: r.decision, version: r.version, note: r.note, actorId: r.actorId, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null, createdAt: r.createdAt.toISOString() })) };
  }

  async approvals(tenant: TenantContext, q: { view: 'pending' | 'decided'; page: number; pageSize: number }) {
    const bt = await this.businessTime(tenant.businessId);
    const pendingCount = await this.prisma.calendarEvent.count({ where: { businessId: tenant.businessId, deletedAt: null, status: { not: 'CANCELLED' }, content: { status: 'IN_REVIEW', deletedAt: null } } });
    if (q.view === 'pending') {
      const where: Prisma.CalendarEventWhereInput = { businessId: tenant.businessId, deletedAt: null, status: { not: 'CANCELLED' }, content: { status: 'IN_REVIEW', deletedAt: null } };
      const events = await this.prisma.calendarEvent.findMany({ where, include: EVENT_INCLUDE, orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize });
      return { timezone: bt.timezone, view: q.view, pendingCount, total: pendingCount, page: q.page, pageSize: q.pageSize, items: events.map((e) => this.toDto(e as EventWithContent)) };
    }
    const where: Prisma.ApprovalRecordWhereInput = { businessId: tenant.businessId, decision: { in: ['APPROVED', 'REJECTED', 'AUTHORIZED', 'REVOKED'] } };
    const [records, total] = await Promise.all([
      this.prisma.approvalRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { calendarEvent: { select: { id: true, title: true, platform: true, scheduledAt: true, timezone: true } } } }),
      this.prisma.approvalRecord.count({ where }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(records.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return {
      timezone: bt.timezone, view: q.view, pendingCount, total, page: q.page, pageSize: q.pageSize,
      items: records.map((r) => ({ id: r.id, decision: r.decision, version: r.version, note: r.note, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null, createdAt: r.createdAt.toISOString(), entry: r.calendarEvent && { id: r.calendarEvent.id, title: r.calendarEvent.title, platform: r.calendarEvent.platform, scheduledAt: r.calendarEvent.scheduledAt.toISOString() } })),
    };
  }

  // ─── Creating and editing ───────────────────────────────────────────────────

  async create(tenant: TenantContext, dto: CreateEntryDto) {
    await this.assertRefs(tenant.businessId, dto);
    const bt = await this.businessTime(tenant.businessId);
    const platform = dto.platform as SocialPlatform;
    const e = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, platform);
      const time = await this.resolveTime(tx, { businessId: tenant.businessId, platform, timezone: bt.timezone, scheduledAt: dto.scheduledAt, localDate: dto.localDate, localTime: dto.localTime });
      const conflicts = await this.scheduling.detect(tx, { businessId: tenant.businessId, platform, scheduledAt: time.at, timezone: bt.timezone });
      this.enforce(conflicts.filter((c) => c.code !== 'ACCOUNT_NOT_CONNECTED'), dto.acknowledgeConflicts);
      const created = await this.insertEntry(tx, tenant, bt, {
        title: dto.title, platform, at: time.at, source: time.source, timeNote: time.note, pillar: (dto.pillar as ContentPillar) ?? null, brief: dto.brief, contentType: dto.contentType, caption: dto.caption,
        hashtags: dto.hashtags, callToAction: dto.callToAction, language: dto.language ?? bt.locale, productId: dto.productId, serviceId: dto.serviceId, mediaIds: dto.mediaIds,
      });
      return { created, conflicts };
    });
    await this.audit.record({ action: 'calendar.entry_created', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: e.created.id, metadata: { platform, scheduledAt: e.created.scheduledAt.toISOString(), timeSource: e.created.timeSource } });
    await this.conflictNotice(tenant, e.created, e.conflicts);
    return this.toDto(e.created, { conflicts: e.conflicts });
  }

  async update(tenant: TenantContext, id: string, dto: UpdateEntryDto) {
    await this.assertRefs(tenant.businessId, { mediaIds: dto.mediaIds });
    const result = await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const status = CalendarService.status(e);
      if (FINAL_STATUSES.includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot be edited` });
      const c = e.content!;
      const next = {
        title: dto.title ?? c.title,
        caption: dto.caption === undefined ? c.caption : dto.caption || null,
        hashtags: dto.hashtags ?? c.hashtags,
        callToAction: dto.callToAction === undefined ? c.callToAction : dto.callToAction || null,
      };
      const textChanged = TEXT_FIELDS.some((k) => JSON.stringify(next[k]) !== JSON.stringify((c as never)[k])) || (dto.mediaIds ? JSON.stringify(dto.mediaIds) !== JSON.stringify(c.media.map((m) => m.mediaId)) : false);
      const wasApproved = ['IN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(status);
      if (wasApproved && textChanged && status === 'SCHEDULED') this.requirePermission(tenant, 'publication.schedule', 'Editing scheduled content cancels its authorization, which needs the permission to schedule publications');
      if (textChanged) {
        await tx.content.update({
          where: { id: c.id },
          data: {
            ...next,
            ...(dto.contentType ? { type: dto.contentType as never } : {}),
            version: { increment: 1 },
            ...(wasApproved || status === 'REJECTED' ? { status: 'DRAFT' as const, approvedById: null, approvedAt: null, approvedVersion: null, rejectionReason: null } : {}),
            ...(dto.mediaIds ? { media: { deleteMany: {}, create: dto.mediaIds.map((mediaId, position) => ({ mediaId, position })) } } : {}),
          },
        });
      } else if (dto.contentType) {
        await tx.content.update({ where: { id: c.id }, data: { type: dto.contentType as never } });
      }
      await tx.calendarEvent.update({
        where: { id: e.id },
        data: {
          title: dto.title ?? e.title,
          ...(dto.brief !== undefined ? { brief: dto.brief || null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          ...(dto.pillar ? { pillar: dto.pillar as ContentPillar } : {}),
          ...(textChanged && wasApproved ? { authorizedById: null, authorizedAt: null, authorizedVersion: null, dispatchState: 'NONE' as const, dispatchKey: null, lockedUntil: null } : {}),
        },
      });
      if (textChanged && wasApproved) await tx.approvalRecord.create({ data: { businessId: tenant.businessId, contentId: c.id, calendarEventId: e.id, version: c.version, decision: 'REVOKED', actorId: tenant.userId, note: 'Content was edited; approval and authorization were withdrawn' } });
      return { reverted: textChanged && wasApproved };
    });
    await this.audit.record({ action: 'calendar.entry_updated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { fields: Object.keys(dto), approvalWithdrawn: result.reverted } });
    return this.get(tenant, id);
  }

  /** Link an existing content (for example a saved AI draft) to this entry in place of its own placeholder. */
  async useContent(tenant: TenantContext, id: string, contentId: string) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const status = CalendarService.status(e);
      if (!['DRAFT', 'REJECTED'].includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a draft entry can take another content' });
      const target = await tx.content.findFirst({ where: { id: contentId, businessId: tenant.businessId, deletedAt: null } });
      if (!target) throw new NotFoundException({ code: 'CONTENT_NOT_FOUND', message: 'Content not found' });
      if (target.id === e.contentId) return;
      await this.scheduling.lock(tx, tenant.businessId, e.platform!);
      const taken = await tx.calendarEvent.findFirst({ where: { businessId: tenant.businessId, contentId: target.id, platform: e.platform, deletedAt: null, status: { not: 'CANCELLED' }, id: { not: e.id } } });
      if (taken) throw new ConflictException({ code: 'CALENDAR_CONFLICT', message: 'This content is already planned on this platform.', conflicts: [{ code: 'DUPLICATE_PLACEMENT', severity: 'hard', message: 'This content is already planned on this platform.', withEntryId: taken.id }] });
      const old = e.content!;
      await tx.calendarEvent.update({ where: { id: e.id }, data: { contentId: target.id, title: target.title ?? e.title, placementKey: `${target.id}:${e.platform}` } });
      await tx.content.update({ where: { id: target.id }, data: { targetPlatforms: { set: [...new Set([...target.targetPlatforms, e.platform!])] } } });
      if (old.origin === 'HUMAN' || old.origin === 'AI_ASSISTED') await tx.content.update({ where: { id: old.id }, data: { deletedAt: new Date(), status: 'CANCELLED' } });
    });
    await this.audit.record({ action: 'calendar.content_linked', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { contentId } });
    return this.get(tenant, id);
  }

  // ─── Rescheduling ───────────────────────────────────────────────────────────

  async reschedule(tenant: TenantContext, id: string, dto: { scheduledAt?: string; localDate?: string; localTime?: string; acknowledgeConflicts: boolean }) {
    const first = await this.load(tenant, id);
    const bt = await this.businessTime(tenant.businessId);
    const out = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, first.platform ?? 'NONE');
      const e = await this.load(tenant, id, tx);
      const status = CalendarService.status(e);
      if (['PUBLISHING', 'PUBLISHED', 'CANCELLED'].includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot be moved` });
      if (status === 'SCHEDULED') this.requirePermission(tenant, 'publication.schedule', 'Moving an authorized publication needs the permission to schedule publications');
      if (e.dispatchState === 'DISPATCHING' || e.dispatchState === 'DISPATCHED') throw new ConflictException({ code: 'TOO_LATE', message: 'This entry is already being handed to the publisher' });
      const time = await this.resolveTime(tx, { businessId: tenant.businessId, platform: e.platform!, timezone: bt.timezone, scheduledAt: dto.scheduledAt, localDate: dto.localDate, localTime: dto.localTime });
      const conflicts = await this.scheduling.detect(tx, { businessId: tenant.businessId, platform: e.platform!, scheduledAt: time.at, timezone: bt.timezone, contentId: e.contentId, excludeEventId: e.id });
      this.enforce(conflicts.filter((c) => c.code !== 'ACCOUNT_NOT_CONNECTED'), dto.acknowledgeConflicts);
      if (status === 'SCHEDULED' && time.at.getTime() < Date.now() + CALENDAR_LIMITS.minLeadMinutes * 60_000) throw new ConflictException({ code: 'CALENDAR_CONFLICT', message: 'This time is too close or in the past.', conflicts: [{ code: 'PAST_TIME', severity: 'hard', message: 'This time is too close or in the past.' }] });
      const updated = await tx.calendarEvent.update({
        where: { id: e.id },
        data: { scheduledAt: time.at, timezone: bt.timezone, timeSource: time.source, timeNote: time.note, dispatchState: e.dispatchState === 'BLOCKED' || e.dispatchState === 'QUEUED' ? 'NONE' : e.dispatchState, dispatchKey: null, lockedUntil: null, reminderSentAt: null },
        include: EVENT_INCLUDE,
      });
      return { updated: updated as EventWithContent, from: e.scheduledAt, conflicts };
    });
    await this.audit.record({ action: 'calendar.rescheduled', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { from: out.from.toISOString(), to: out.updated.scheduledAt.toISOString() } });
    await this.conflictNotice(tenant, out.updated, out.conflicts);
    return this.toDto(out.updated, { conflicts: out.conflicts });
  }

  // ─── Approval workflow ──────────────────────────────────────────────────────

  /** TikTok's guidelines: the creator chooses privacy, interactions and disclosure and confirms before anything is posted. Nothing is assumed for them. */
  private assertPlatformReady(e: EventWithContent) {
    if (e.platform !== 'TIKTOK') return;
    const c = e.content!;
    const check = checkTikTokSettings((c.platformOptions as { tiktok?: unknown } | null)?.tiktok, c.type as never);
    if (!check.ok) throw new UnprocessableEntityException({ code: 'TIKTOK_SETTINGS_REQUIRED', message: `Complete the TikTok posting settings first: ${check.errors.map((x) => x.message).join(' ')}`, errors: check.errors });
  }

  /** Saves the person's TikTok posting choices. They are part of the content: changing them withdraws approval and authorization like a text edit. */
  async setTikTokSettings(tenant: TenantContext, id: string, input: unknown) {
    const result = await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      if (e.platform !== 'TIKTOK') throw new ConflictException({ code: 'NOT_TIKTOK', message: 'TikTok settings exist for TikTok entries only' });
      const status = CalendarService.status(e);
      if (FINAL_STATUSES.includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot be edited` });
      const c = e.content!;
      const check = checkTikTokSettings(input, c.type as never);
      if (!check.ok) throw new UnprocessableEntityException({ code: 'TIKTOK_SETTINGS_INVALID', message: check.errors.map((x) => x.message).join(' '), errors: check.errors });
      const value = { ...check.value, confirmedAt: new Date().toISOString(), confirmedById: tenant.userId };
      const wasApproved = ['IN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(status);
      if (status === 'SCHEDULED') this.requirePermission(tenant, 'publication.schedule', 'Editing scheduled content cancels its authorization, which needs the permission to schedule publications');
      const unchanged = JSON.stringify({ ...((c.platformOptions as { tiktok?: object } | null)?.tiktok ?? {}), confirmedAt: 0, confirmedById: 0 }) === JSON.stringify({ ...value, confirmedAt: 0, confirmedById: 0 });
      if (unchanged) return { changed: false, reverted: false };
      await tx.content.update({
        where: { id: c.id },
        data: {
          platformOptions: { ...((c.platformOptions as object | null) ?? {}), tiktok: value } as Prisma.InputJsonValue, version: { increment: 1 },
          ...(wasApproved || status === 'REJECTED' ? { status: 'DRAFT' as const, approvedById: null, approvedAt: null, approvedVersion: null, rejectionReason: null } : {}),
        },
      });
      if (wasApproved) {
        await tx.calendarEvent.update({ where: { id: e.id }, data: { authorizedById: null, authorizedAt: null, authorizedVersion: null, dispatchState: 'NONE', dispatchKey: null, lockedUntil: null } });
        await tx.approvalRecord.create({ data: { businessId: tenant.businessId, contentId: c.id, calendarEventId: e.id, version: c.version, decision: 'REVOKED', actorId: tenant.userId, note: 'TikTok posting settings were changed; approval and authorization were withdrawn' } });
      }
      return { changed: true, reverted: wasApproved };
    });
    await this.audit.record({ action: 'calendar.tiktok_settings_saved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { changed: result.changed, approvalWithdrawn: result.reverted } });
    return this.get(tenant, id);
  }

  async submit(tenant: TenantContext, id: string) {
    const e = await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      const status = CalendarService.status(e);
      if (status !== 'DRAFT' && status !== 'REJECTED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot be submitted for approval` });
      const missing: string[] = [];
      if (!c.caption?.trim()) missing.push('caption');
      if (c.type !== 'TEXT' && !c.media.length) missing.push('media');
      this.assertPlatformReady(e);
      if (missing.length) throw new UnprocessableEntityException({ code: 'CONTENT_INCOMPLETE', message: `Complete the content before submitting it: ${missing.join(', ')}`, missing });
      const res = await tx.content.updateMany({ where: { id: c.id, status: { in: ['DRAFT', 'REJECTED'] } }, data: { status: 'IN_REVIEW', rejectionReason: null } });
      if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This entry was changed by someone else' });
      await this.record(tx, tenant, e, 'SUBMITTED');
      return e;
    });
    await this.audit.record({ action: 'calendar.submitted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { version: e.content!.version } });
    await this.notifications.notify({ businessId: tenant.businessId, permission: 'content.approve', type: 'calendar.approval_requested', title: `Approval needed: ${e.title}`, data: { entryId: e.id, entryTitle: e.title, platform: e.platform, scheduledAt: e.scheduledAt.toISOString() }, dedupeKey: `approval:${e.id}:${e.content!.version}` });
    return this.get(tenant, id);
  }

  async approve(tenant: TenantContext, id: string, note?: string) {
    const e0 = await this.load(tenant, id);
    // AI-written or AI-assisted text is re-checked against the business data as it is now.
    if (e0.content!.origin !== 'HUMAN') {
      const ctx = (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
      const c = e0.content!;
      const issues = checkGrounding({ title: c.title, caption: c.caption, hashtags: c.hashtags, callToAction: c.callToAction }, ctx);
      if (issues.length) {
        await this.audit.record({ action: 'calendar.approval_blocked', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { issues: issues.slice(0, 10) } });
        throw new UnprocessableEntityException({ code: 'APPROVAL_BLOCKED', message: 'This text contains information that is not in the verified business data', issues });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      const res = await tx.content.updateMany({ where: { id: c.id, status: 'IN_REVIEW', version: c.version }, data: { status: 'APPROVED', approvedById: tenant.userId, approvedAt: new Date(), approvedVersion: c.version, rejectionReason: null } });
      if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'Only an entry in review can be approved (it may have been edited or decided already)' });
      await this.record(tx, tenant, e, 'APPROVED', note);
    });
    await this.audit.record({ action: 'calendar.approved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { version: e0.content!.version } });
    return this.get(tenant, id);
  }

  async reject(tenant: TenantContext, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      const res = await tx.content.updateMany({ where: { id: c.id, status: 'IN_REVIEW', version: c.version }, data: { status: 'REJECTED', rejectionReason: reason, approvedById: null, approvedAt: null, approvedVersion: null } });
      if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'Only an entry in review can be rejected' });
      await this.record(tx, tenant, e, 'REJECTED', reason);
    });
    await this.audit.record({ action: 'calendar.rejected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id });
    return this.get(tenant, id);
  }

  /**
   * The explicit business authorization to publish: moves an APPROVED entry to SCHEDULED, bound to the approved
   * version and to this person. Nothing is published unless an entry reached SCHEDULED this way.
   */
  async authorize(tenant: TenantContext, id: string, acknowledge: boolean) {
    const first = await this.load(tenant, id);
    const bt = await this.businessTime(tenant.businessId);
    const out = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, first.platform ?? 'NONE');
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      if (['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'CANCELLED'].includes(c.status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${c.status} entry cannot be scheduled` });
      if (c.status !== 'APPROVED' || c.approvedVersion !== c.version || !c.approvedById) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'This content must be approved (in its current version) before it can be scheduled' });
      this.assertPlatformReady(e);
      const conflicts = await this.scheduling.detect(tx, { businessId: tenant.businessId, platform: e.platform!, scheduledAt: e.scheduledAt, timezone: bt.timezone, contentId: e.contentId, excludeEventId: e.id });
      this.enforce(conflicts.filter((x) => x.code !== 'ACCOUNT_NOT_CONNECTED'), acknowledge);
      if (e.scheduledAt.getTime() < Date.now() + CALENDAR_LIMITS.minLeadMinutes * 60_000) throw new ConflictException({ code: 'CALENDAR_CONFLICT', message: 'This time is too close or in the past. Move the entry first.', conflicts: [{ code: 'PAST_TIME', severity: 'hard', message: 'This time is too close or in the past.' }] });
      const res = await tx.content.updateMany({ where: { id: c.id, status: 'APPROVED', version: c.version, approvedVersion: c.version }, data: { status: 'SCHEDULED' } });
      if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This entry was changed by someone else' });
      const updated = await tx.calendarEvent.update({
        where: { id: e.id },
        data: { authorizedById: tenant.userId, authorizedAt: new Date(), authorizedVersion: c.version, dispatchState: 'NONE', dispatchAttempts: 0, dispatchKey: null, lockedUntil: null, lastError: null, reminderSentAt: null },
        include: EVENT_INCLUDE,
      });
      await this.record(tx, tenant, e, 'AUTHORIZED');
      return { updated: updated as EventWithContent, conflicts };
    });
    await this.audit.record({ action: 'calendar.authorized', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { version: out.updated.authorizedVersion, scheduledAt: out.updated.scheduledAt.toISOString() } });
    await this.conflictNotice(tenant, out.updated, out.conflicts);
    return this.toDto(out.updated, { conflicts: out.conflicts });
  }

  /** Withdraws the authorization: SCHEDULED goes back to APPROVED and will not be handed to the publisher. */
  async unschedule(tenant: TenantContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      if (c.status !== 'SCHEDULED') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a scheduled entry can be unscheduled' });
      if (e.dispatchState === 'DISPATCHING' || e.dispatchState === 'DISPATCHED') throw new ConflictException({ code: 'TOO_LATE', message: 'This entry is already being handed to the publisher' });
      await tx.content.update({ where: { id: c.id }, data: { status: 'APPROVED' } });
      await tx.calendarEvent.update({ where: { id: e.id }, data: { authorizedById: null, authorizedAt: null, authorizedVersion: null, dispatchState: 'NONE', dispatchKey: null, lockedUntil: null } });
      await this.record(tx, tenant, e, 'REVOKED', 'Unscheduled');
    });
    await this.audit.record({ action: 'calendar.unscheduled', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id });
    return this.get(tenant, id);
  }

  async cancel(tenant: TenantContext, id: string, note?: string) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const status = CalendarService.status(e);
      if (FINAL_STATUSES.includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot be cancelled` });
      if (status === 'SCHEDULED') this.requirePermission(tenant, 'publication.schedule', 'Cancelling an authorized publication needs the permission to schedule publications');
      if (e.dispatchState === 'DISPATCHING' || e.dispatchState === 'DISPATCHED') throw new ConflictException({ code: 'TOO_LATE', message: 'This entry is already being handed to the publisher' });
      await tx.content.update({ where: { id: e.contentId! }, data: { status: 'CANCELLED' } });
      await tx.calendarEvent.update({ where: { id: e.id }, data: { status: 'CANCELLED', placementKey: null, dispatchState: 'NONE', dispatchKey: null, lockedUntil: null } });
      await this.record(tx, tenant, e, 'CANCELLED', note);
    });
    await this.audit.record({ action: 'calendar.cancelled', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id });
    return this.get(tenant, id);
  }

  /** A FAILED entry can be authorized again (optionally at a new time). It is a fresh authorization by the person retrying. */
  async retry(tenant: TenantContext, id: string, dto: { scheduledAt?: string; localDate?: string; localTime?: string; acknowledgeConflicts: boolean }) {
    const first = await this.load(tenant, id);
    const bt = await this.businessTime(tenant.businessId);
    const out = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, first.platform ?? 'NONE');
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      if (c.status !== 'FAILED') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a failed entry can be retried' });
      if (c.approvedVersion !== c.version) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'The content changed after approval' });
      const hasTime = dto.scheduledAt || dto.localDate;
      // Without a new time the retry is immediate ("try again now"); with one, the usual rules apply.
      const time = hasTime ? await this.resolveTime(tx, { businessId: tenant.businessId, platform: e.platform!, timezone: bt.timezone, ...dto }) : { at: new Date(), source: 'MANUAL' as TimeSource, note: 'Retry' };
      const conflicts = await this.scheduling.detect(tx, { businessId: tenant.businessId, platform: e.platform!, scheduledAt: time.at, timezone: bt.timezone, contentId: e.contentId, excludeEventId: e.id });
      this.enforce(conflicts.filter((x) => x.code !== 'ACCOUNT_NOT_CONNECTED' && (hasTime || (x.code !== 'PAST_TIME' && x.code !== 'SLOT_TOO_CLOSE' && x.code !== 'DAILY_LIMIT'))), dto.acknowledgeConflicts);
      await tx.content.update({ where: { id: c.id }, data: { status: 'SCHEDULED' } });
      const updated = await tx.calendarEvent.update({
        where: { id: e.id },
        data: { scheduledAt: time.at, timeSource: time.source, timeNote: time.note, authorizedById: tenant.userId, authorizedAt: new Date(), authorizedVersion: c.version, dispatchState: 'NONE', dispatchAttempts: 0, dispatchKey: null, lockedUntil: null, lastError: null, reminderSentAt: null },
        include: EVENT_INCLUDE,
      });
      await this.record(tx, tenant, e, 'AUTHORIZED', 'Retry after failure');
      return { updated: updated as EventWithContent, conflicts };
    });
    await this.audit.record({ action: 'calendar.retried', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id });
    return this.toDto(out.updated, { conflicts: out.conflicts });
  }

  async remove(tenant: TenantContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.load(tenant, id, tx);
      const status = CalendarService.status(e);
      if (!['DRAFT', 'REJECTED', 'CANCELLED', 'FAILED'].includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot be deleted. Cancel it first.` });
      const now = new Date();
      await tx.calendarEvent.update({ where: { id: e.id }, data: { deletedAt: now, placementKey: null, dispatchKey: null } });
      if (e.contentId && e.content!.origin !== 'AI_GENERATED') await tx.content.update({ where: { id: e.contentId }, data: { deletedAt: now } });
    });
    await this.audit.record({ action: 'calendar.entry_deleted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id });
    return { deleted: true };
  }


  /** Chooses which connected account an entry publishes to (when a business has several for a platform). */
  async setAccount(tenant: TenantContext, id: string, socialAccountId: string | null) {
    const e = await this.load(tenant, id);
    const status = CalendarService.status(e);
    if (FINAL_STATUSES.includes(status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${status} entry cannot change account` });
    if (status === 'SCHEDULED') this.requirePermission(tenant, 'publication.schedule', 'Changing the account of an authorized publication needs the permission to schedule publications');
    if (socialAccountId) {
      const acc = await this.prisma.socialAccount.findFirst({ where: { id: socialAccountId, businessId: tenant.businessId, platform: e.platform ?? undefined, deletedAt: null, status: { not: 'DISCONNECTED' } } });
      if (!acc) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'That account is not connected for this platform' });
    }
    await this.prisma.calendarEvent.update({ where: { id }, data: { socialAccountId } });
    await this.audit.record({ action: 'calendar.account_set', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { socialAccountId } });
    return this.get(tenant, id);
  }

  /**
   * Publish immediately: the explicit authorization and the due time are the same moment. The content must already be approved in its
   * current version. The scheduler hands it to the publisher on its next tick (the controller triggers one straight away).
   */
  async publishNow(tenant: TenantContext, id: string) {
    if (!(await this.gateway.isAvailable())) throw new ServiceUnavailableException({ code: 'PUBLISHER_NOT_AVAILABLE', message: 'No social platform is configured for publishing on this server' });
    const first = await this.load(tenant, id);
    const out = await this.prisma.$transaction(async (tx) => {
      await this.scheduling.lock(tx, tenant.businessId, first.platform ?? 'NONE');
      const e = await this.load(tenant, id, tx);
      const c = e.content!;
      if (['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'CANCELLED'].includes(c.status)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${c.status} entry cannot be published now` });
      if (c.status !== 'APPROVED' || c.approvedVersion !== c.version || !c.approvedById) throw new ConflictException({ code: 'APPROVAL_REQUIRED', message: 'This content must be approved (in its current version) before it can be published' });
      this.assertPlatformReady(e);
      const res = await tx.content.updateMany({ where: { id: c.id, status: 'APPROVED', version: c.version, approvedVersion: c.version }, data: { status: 'SCHEDULED' } });
      if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This entry was changed by someone else' });
      const updated = await tx.calendarEvent.update({
        where: { id: e.id },
        data: { scheduledAt: new Date(), timeSource: 'MANUAL', timeNote: 'Publish now', authorizedById: tenant.userId, authorizedAt: new Date(), authorizedVersion: c.version, dispatchState: 'NONE', dispatchAttempts: 0, dispatchKey: null, lockedUntil: null, lastError: null, reminderSentAt: new Date() },
        include: EVENT_INCLUDE,
      });
      await this.record(tx, tenant, e, 'AUTHORIZED', 'Publish now');
      return updated as EventWithContent;
    });
    await this.audit.record({ action: 'calendar.authorized', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'CalendarEvent', entityId: id, metadata: { version: out.authorizedVersion, publishNow: true } });
    return this.toDto(out);
  }

  async recommendations(tenant: TenantContext, platform: SocialPlatform, date: string) {
    if (!isValidDate(date)) throw new BadRequestException({ code: 'INVALID_TIME', message: 'date must be a valid date (YYYY-MM-DD)' });
    const bt = await this.businessTime(tenant.businessId);
    return this.scheduling.recommend({ businessId: tenant.businessId, platform, date, timezone: bt.timezone, notBefore: new Date() });
  }

  /** Overview for the calendar home: counts by status for the next 30 days, pending approvals, upcoming, problems. */
  async overview(tenant: TenantContext) {
    const bt = await this.businessTime(tenant.businessId);
    const today = todayIn(bt.timezone);
    const { start } = localDayRange(today, bt.timezone);
    const end = localDayRange(addDays(today, 29), bt.timezone).end;
    const events = (await this.prisma.calendarEvent.findMany({ where: { businessId: tenant.businessId, deletedAt: null, scheduledAt: { gte: start, lt: end } }, include: EVENT_INCLUDE, orderBy: { scheduledAt: 'asc' }, take: 1000 })) as EventWithContent[];
    const byStatus: Record<string, number> = {};
    const byPillar: Record<string, number> = {};
    for (const e of events) {
      const s = CalendarService.status(e);
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      if (e.pillar && s !== 'CANCELLED') byPillar[e.pillar] = (byPillar[e.pillar] ?? 0) + 1;
    }
    const [pendingApprovals, failed, accounts] = await Promise.all([
      this.prisma.calendarEvent.count({ where: { businessId: tenant.businessId, deletedAt: null, status: { not: 'CANCELLED' }, content: { status: 'IN_REVIEW', deletedAt: null } } }),
      this.prisma.calendarEvent.count({ where: { businessId: tenant.businessId, deletedAt: null, content: { status: 'FAILED' } } }),
      this.prisma.socialAccount.findMany({ where: { businessId: tenant.businessId, status: 'CONNECTED', deletedAt: null }, select: { platform: true } }),
    ]);
    const now = Date.now();
    return {
      timezone: bt.timezone, today, language: bt.locale,
      counts: { byStatus, byPillar, total: events.length },
      pendingApprovals, failed,
      conflicts: this.rangeConflicts(events).length,
      upcoming: events.filter((e) => e.scheduledAt.getTime() >= now && !['CANCELLED', 'REJECTED'].includes(CalendarService.status(e))).slice(0, 5).map((e) => this.toDto(e)),
      connectedPlatforms: [...new Set(accounts.map((a) => a.platform))],
      publishing: { available: await this.gateway.isAvailable() },
    };
  }
}
