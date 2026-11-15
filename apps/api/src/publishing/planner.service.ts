import { ConflictException, Injectable } from '@nestjs/common';
import { addDays, todayIn, weekdayOf, zonedToUtc, type HoursWindow } from '@touma/shared';
import { CalendarService } from '../calendar/calendar.service';
import type { CreateEntryDto } from '../calendar/calendar.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PublishingAutomationService } from './automation.service';
import { PublishingPolicyService } from './policy.service';

export interface PlannedPost { title: string; caption: string; hashtags?: string[]; contentType?: string; mediaIds?: string[]; callToAction?: string; productId?: string }

/**
 * Editorial calendar for one account (N21): chooses the days and times inside the policy's publishing hours and daily limit, prepares the drafts and hands each to the
 * pipeline. Without supplied posts it prepares drafts from the ACTIVE catalog using only the stored facts (name, description, price) and no AI call, so it costs nothing
 * and invents nothing. Posts that need media get none unless the caller attaches it: such posts are stopped by the pipeline, not sent.
 */
@Injectable()
export class PublishingPlannerService {
  constructor(private readonly prisma: PrismaService, private readonly calendar: CalendarService, private readonly policies: PublishingPolicyService, private readonly automation: PublishingAutomationService) {}

  async plan(t: TenantContext, o: { accountId: string; days: number; startDate?: string; posts?: PlannedPost[]; process: boolean }) {
    const view = await this.policies.get(t, o.accountId);
    const p = view.policy;
    if (!p) throw new ConflictException({ code: 'CONSENT_REQUIRED', message: 'Accept the consent and configure the account before planning' });
    const account = await this.prisma.socialAccount.findFirstOrThrow({ where: { id: o.accountId, businessId: t.businessId } });
    const hours = p.allowedPublishingHours as unknown as HoursWindow[];
    const tz = p.timezone;
    const start = o.startDate ?? addDays(todayIn(tz), 1);
    const posts = o.posts?.length ? o.posts : await this.fromCatalog(t.businessId, o.days);
    const created: Array<{ entryId: string; title: string; scheduledAt: string; decision: { action: string; risk: string; reasons: unknown } | null; error?: string }> = [];
    let i = 0;
    for (let d = 0; d < o.days && i < posts.length; d++) {
      const date = addDays(start, d);
      const win = hours.find((w) => w.days.includes(weekdayOf(date)));
      if (!win) continue;
      // One post per day, an hour after the window opens: simple, predictable and inside the allowed hours.
      const [h, m] = win.from.split(':').map(Number);
      const time = `${String(Math.min((h ?? 8) + 1, 23)).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
      const post = posts[i++]!;
      try {
        const at = zonedToUtc(date, time, tz).utc;
        const dto = { title: post.title.slice(0, 120), platform: account.platform, caption: post.caption, hashtags: post.hashtags, callToAction: post.callToAction, contentType: post.contentType ?? p.allowedContentTypes[0] ?? 'IMAGE', mediaIds: post.mediaIds, productId: post.productId, scheduledAt: at.toISOString(), acknowledgeConflicts: true } as unknown as CreateEntryDto;
        const entry = (await this.calendar.create(t, dto)) as unknown as { id: string };
        await this.prisma.calendarEvent.update({ where: { id: entry.id }, data: { socialAccountId: account.id } });
        const decision = o.process ? await this.automation.process(t, entry.id) : await this.automation.enqueue(t.businessId, entry.id);
        created.push({ entryId: entry.id, title: post.title, scheduledAt: at.toISOString(), decision: { action: decision.action, risk: decision.risk, reasons: decision.reasons } });
      } catch (e) {
        created.push({ entryId: '', title: post.title, scheduledAt: '', decision: null, error: (e as { message?: string }).message?.slice(0, 200) ?? 'error' });
      }
    }
    await this.policies.event(t.businessId, 'PLAN_CREATED', { accountId: account.id, actorId: t.userId, data: { days: o.days, posts: created.length } });
    return { accountId: account.id, entries: created };
  }

  private async fromCatalog(businessId: string, n: number): Promise<PlannedPost[]> {
    const products = await this.prisma.product.findMany({ where: { businessId, status: 'ACTIVE', deletedAt: null }, orderBy: { createdAt: 'asc' }, take: Math.min(n, 14) });
    return products.map((pr) => ({
      title: pr.name,
      caption: [pr.name, pr.description?.trim(), pr.price != null ? `${pr.price.toString()}${pr.currency ? ` ${pr.currency}` : ''}` : null].filter(Boolean).join(' — '),
      productId: pr.id,
    }));
  }
}
