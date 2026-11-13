import { HttpException, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@touma/database';
import type { SocialPlatform } from '@touma/database';
import { SOCIAL_PLATFORMS } from '@touma/shared';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { RUN_ADAPTER_REGISTRY, RunStepError, type RunAdapterRegistry } from '../runs/run-adapters';
import { CalendarService } from './calendar.service';
import { SchedulingService } from './scheduling.service';

const TITLE_MAX = 200;

/**
 * Phase N9: the workflow step that really creates a calendar entry (a PLANNED entry with a draft content) in the business's
 * own calendar. It acts on TOUMA data, never outside, but it is declared external so the engine always requires a person's
 * approval first. It does not authorize or publish anything: authorization of the exact content stays a separate human act.
 *
 * Idempotent without a schema change: the content id is derived from the step's idempotency key, and the calendar's unique
 * placement key (`contentId:platform`) rejects a second entry, so a replay returns the entry that already exists.
 * Inputs: title, platform, scheduled_at (ISO instant), optional caption.
 */
@Injectable()
export class CalendarRunAdapter implements OnModuleInit {
  constructor(
    private readonly calendar: CalendarService,
    private readonly scheduling: SchedulingService,
    private readonly audit: AuditService,
    @Inject(RUN_ADAPTER_REGISTRY) private readonly registry: RunAdapterRegistry,
  ) {}

  onModuleInit() {
    this.registry.register?.({
      name: 'calendar.create-entry',
      external: true,
      execute: async (ctx) => {
        const title = typeof ctx.input.title === 'string' ? ctx.input.title.trim() : '';
        const platform = ctx.input.platform;
        const when = typeof ctx.input.scheduled_at === 'string' ? new Date(ctx.input.scheduled_at) : null;
        const caption = typeof ctx.input.caption === 'string' && ctx.input.caption.trim() ? ctx.input.caption.trim().slice(0, 2000) : null;
        if (!title || title.length > TITLE_MAX || typeof platform !== 'string' || !(SOCIAL_PLATFORMS as readonly string[]).includes(platform) || !when || Number.isNaN(when.getTime())) {
          throw new RunStepError('INVALID_INPUT', 'title, platform and scheduled_at (ISO date) are required', false);
        }
        const businessId = ctx.businessId;
        const contentId = `wfc${createHash('sha256').update(ctx.idempotencyKey).digest('hex').slice(0, 24)}`;
        const existing = () => this.prisma.calendarEvent.findFirst({ where: { businessId, contentId } });
        const view = (e: { id: string; status: string; scheduledAt: Date; platform: string | null; deletedAt: Date | null }, created: boolean) => ({
          eventId: e.id, status: e.deletedAt ? 'DELETED' : e.status, scheduledAt: e.scheduledAt.toISOString(), platform: e.platform, created, published: false, authorized: false,
        });
        try {
          const done = await existing();
          if (done) return view(done, false); // a replay (retry, resume after a crash): the entry is already there, in whatever state a person left it
          const bt = await this.calendar.businessTime(businessId);
          const created = await this.prisma.$transaction(async (tx) => {
            await this.scheduling.lock(tx, businessId, platform);
            const raced = await tx.calendarEvent.findFirst({ where: { businessId, contentId } }); // checked again under the lock: a concurrent attempt may just have created it
            if (raced) return { entry: raced, created: false };
            const time = await this.calendar.resolveTime(tx, { businessId, platform: platform as SocialPlatform, timezone: bt.timezone, scheduledAt: when.toISOString() });
            const conflicts = await this.scheduling.detect(tx, { businessId, platform: platform as SocialPlatform, scheduledAt: time.at, timezone: bt.timezone });
            const blocking = conflicts.filter((c) => c.code !== 'ACCOUNT_NOT_CONNECTED'); // an automation cannot acknowledge conflicts
            if (blocking.length) throw new RunStepError('CALENDAR_CONFLICT', blocking[0]!.message, false);
            const entry = await this.calendar.insertEntry(tx, { businessId, userId: null }, bt, { contentId, title, platform: platform as SocialPlatform, at: time.at, source: time.source, timeNote: time.note, caption, language: bt.locale, origin: 'AI_ASSISTED' });
            return { entry, created: true };
          });
          if (!created.created) return view(created.entry, false);
          await this.audit.record({ action: 'calendar.entry_created', businessId, entityType: 'CalendarEvent', entityId: created.entry.id, metadata: { via: 'workflow', runId: ctx.runId, stepKey: ctx.stepKey, platform, scheduledAt: created.entry.scheduledAt.toISOString() } });
          return view(created.entry, true);
        } catch (e) {
          if (e instanceof RunStepError) throw e;
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            const raced = await existing(); // another attempt won the race: one entry, never two
            if (raced) return view(raced, false);
          }
          const code = e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? 'CALENDAR_FAILED') : 'CALENDAR_FAILED';
          throw new RunStepError(code, 'The calendar entry could not be created', false);
        }
      },
    });
  }

  private get prisma() {
    return this.calendar.prisma;
  }
}
