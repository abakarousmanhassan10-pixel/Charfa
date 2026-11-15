import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { concludePrudently, detectBias, makeVariants, type VariantCondition } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { CalendarService } from '../calendar/calendar.service';
import { interpretExperiment, type Arm } from '../intelligence/experiment-stats';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PreferencesService } from './preferences.service';

const METRICS = ['engagementRate', 'likes', 'reach', 'views'] as const;

/**
 * Comparison tests of two content variants (N22), on the existing Experiment table and statistics. Honest by construction: TOUMA publishes to one audience, so a test
 * is always recorded as NON_RANDOMIZED_SEQUENTIAL with its bias flags, and the conclusion is an observation, never a proven effect. Preparing variants creates two
 * ordinary calendar DRAFTS: they follow the publishing policy like any other post, and nothing here publishes, boosts or spends.
 */
@Injectable()
export class ExperimentsService {
  constructor(private readonly prisma: PrismaService, private readonly calendar: CalendarService, private readonly prefs: PreferencesService, private readonly audit: AuditService) {}

  private async entry(businessId: string, id: string) {
    const e = await this.prisma.calendarEvent.findFirst({ where: { id, businessId, deletedAt: null }, include: { content: { include: { media: { select: { mediaId: true }, orderBy: { position: 'asc' } } } } } });
    if (!e?.content || !e.platform) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant entry not found' });
    return e;
  }

  private async condition(businessId: string, label: string, entryId: string): Promise<VariantCondition> {
    const e = await this.entry(businessId, entryId);
    const c = e.content!;
    const pub = await this.prisma.publication.findFirst({ where: { businessId, calendarEventId: e.id, status: 'PUBLISHED' } });
    const snap = pub ? await this.prisma.analyticsSnapshot.findFirst({ where: { businessId, publicationId: pub.id, period: 'LIFETIME' }, orderBy: { fetchedAt: 'desc' } }) : null;
    return { label, platform: e.platform!, accountId: e.authorizedAccountId ?? e.socialAccountId, scheduledAt: pub?.publishedAt ?? e.scheduledAt, kind: c.type, title: c.title, caption: c.caption, hashtags: c.hashtags, mediaIds: c.media.map((m) => m.mediaId), audience: snap ? snap.reach ?? snap.impressions ?? null : null, origin: !snap || (snap.reach ?? snap.impressions) === null ? 'UNAVAILABLE' : pub!.simulated || snap.simulated ? 'SIMULATED' : 'REAL' };
  }

  /** Records a comparison between two existing posts: hypothesis, primary metric, delivery conditions and the biases they imply. */
  async create(t: TenantContext, i: { hypothesis: string; metric: string; entryA: string; entryB: string; minSamplePerArm?: number }) {
    if (!(METRICS as readonly string[]).includes(i.metric)) throw new BadRequestException({ code: 'INVALID_METRIC', message: `metric must be one of ${METRICS.join(', ')}` });
    if (i.entryA === i.entryB) throw new BadRequestException({ code: 'SAME_VARIANT', message: 'The two variants must be different posts' });
    const [a, b] = [await this.condition(t.businessId, 'A', i.entryA), await this.condition(t.businessId, 'B', i.entryB)];
    const minSample = Math.min(Math.max(i.minSamplePerArm ?? 100, 10), 100_000);
    const flags = detectBias(a, b, { timezone: 'UTC', minAudience: minSample });
    const conditions = { design: 'NON_RANDOMIZED_SEQUENTIAL', paidPromotion: false, variants: [a, b].map((x) => ({ label: x.label, platform: x.platform, accountId: x.accountId, scheduledAt: x.scheduledAt.toISOString(), kind: x.kind })), note: 'Both variants go to the same audience on the same account, one after the other. No advertising or paid boost is used.' };
    const e = await this.prisma.experiment.create({ data: { businessId: t.businessId, hypothesis: i.hypothesis.trim(), metric: i.metric, status: 'RUNNING', variants: [{ label: 'A', calendarEventId: i.entryA }, { label: 'B', calendarEventId: i.entryB }], minSamplePerArm: minSample, design: 'NON_RANDOMIZED_SEQUENTIAL', conditions: conditions as Prisma.InputJsonValue, biasFlags: flags as unknown as Prisma.InputJsonValue, createdById: t.userId } });
    await this.audit.record({ action: 'learning.experiment_created', actorId: t.userId, businessId: t.businessId, entityType: 'Experiment', entityId: e.id });
    return e;
  }

  /** Prepares two variants that differ in one element and creates both as calendar DRAFTS (each still needs its own approval and policy decision). */
  async prepare(t: TenantContext, i: { hypothesis: string; platform: string; base: { title: string; caption: string; hashtags: string[]; mediaIds?: string[]; contentType?: string }; scheduledAtA: string; scheduledAtB: string }) {
    const eff = await this.prefs.effective(t.businessId);
    let v;
    try { v = makeVariants(i.base, { language: (eff.language?.value as string) ?? 'en', restrictions: (eff['editorial.restrictions']?.value as string[]) ?? [] }); } catch (e) { throw new BadRequestException({ code: 'RESTRICTED_CONTENT', message: (e as Error).message }); }
    const mk = (x: { title: string; caption: string; hashtags: string[] }, at: string, label: string) => this.calendar.create(t, { title: `${x.title.slice(0, 100)} (${label})`.slice(0, 120), platform: i.platform, caption: x.caption, hashtags: x.hashtags, contentType: i.base.contentType ?? 'IMAGE', mediaIds: i.base.mediaIds, scheduledAt: at, acknowledgeConflicts: true, brief: x.title } as never) as unknown as Promise<{ id: string }>;
    const [ea, eb] = [await mk(v.a, i.scheduledAtA, 'A'), await mk(v.b, i.scheduledAtB, 'B')];
    // Variant titles are set on the content itself so that the difference is exactly the title.
    for (const [x, e] of [[v.a, ea], [v.b, eb]] as const) { const row = await this.prisma.calendarEvent.findUniqueOrThrow({ where: { id: e.id } }); if (row.contentId) await this.prisma.content.update({ where: { id: row.contentId }, data: { title: x.title } }); }
    const exp = await this.create(t, { hypothesis: i.hypothesis, metric: 'engagementRate', entryA: ea.id, entryB: eb.id });
    return { experiment: exp, variants: { A: v.a, B: v.b }, changed: v.changed, entries: { A: ea.id, B: eb.id } };
  }

  /** Compares the measured engagement of the two published variants and states a prudent conclusion. A missing measurement concludes nothing. */
  async conclude(t: TenantContext, id: string) {
    const e = await this.prisma.experiment.findFirst({ where: { id, businessId: t.businessId } });
    if (!e) throw new NotFoundException({ code: 'EXPERIMENT_NOT_FOUND', message: 'Experiment not found' });
    if (e.status !== 'RUNNING') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${e.status} experiment cannot be concluded` });
    const vs = e.variants as unknown as Array<{ label: string; calendarEventId: string }>;
    const arms: Arm[] = [];
    const conds: VariantCondition[] = [];
    for (const v of vs) {
      const pub = await this.prisma.publication.findFirst({ where: { businessId: t.businessId, calendarEventId: v.calendarEventId, status: 'PUBLISHED' } });
      if (!pub) throw new ConflictException({ code: 'NOT_PUBLISHED', message: `Variant ${v.label} is not published yet` });
      const s = await this.prisma.analyticsSnapshot.findFirst({ where: { businessId: t.businessId, publicationId: pub.id, period: 'LIFETIME' }, orderBy: { fetchedAt: 'desc' } });
      const parts = s ? [s.likes, s.comments, s.shares, s.saves].filter((x): x is number => x !== null) : [];
      const reach = s ? s.reach ?? s.impressions : null;
      arms.push({ label: v.label, engagements: parts.length ? parts.reduce((a, b) => a + b, 0) : null, reach, origin: !s || reach === null ? 'UNAVAILABLE' : pub.simulated || s.simulated ? 'SIMULATED' : 'REAL' });
      conds.push(await this.condition(t.businessId, v.label, v.calendarEventId));
    }
    const stats = interpretExperiment(arms[0]!, arms[1]!, e.minSamplePerArm);
    const flags = detectBias(conds[0]!, conds[1]!, { timezone: 'UTC', minAudience: e.minSamplePerArm });
    const conclusion = concludePrudently(stats, flags);
    const result = { ...stats, conclusion, biasFlags: flags };
    const saved = await this.prisma.experiment.update({ where: { id }, data: { status: 'CONCLUDED', result: result as unknown as Prisma.InputJsonValue, biasFlags: flags as unknown as Prisma.InputJsonValue, concludedAt: new Date() } });
    await this.audit.record({ action: 'learning.experiment_concluded', actorId: t.userId, businessId: t.businessId, entityType: 'Experiment', entityId: id, metadata: { verdict: conclusion.verdict, origin: stats.evidenceOrigin } });
    return saved;
  }

  async list(businessId: string) {
    return this.prisma.experiment.findMany({ where: { businessId, design: { not: 'LEGACY' } }, orderBy: { createdAt: 'desc' }, take: 50 });
  }
}
