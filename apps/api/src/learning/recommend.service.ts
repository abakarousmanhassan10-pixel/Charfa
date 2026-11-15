import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { analyze, ANALYTICS_PLATFORMS, DEFAULT_HOURS, type EngineResult, type HoursWindow, type PerfPost, type Rec } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PerformanceService } from './performance.service';
import { PreferencesService } from './preferences.service';

export interface RecommendSummary { analyzed: Record<string, { usable: number; origin: string; insufficient: string[]; dropped: number }>; created: number; refreshed: number; skippedDecided: number; hypotheses: number; inferences: number }

const PRIORITY = { HIGH: 80, MEDIUM: 60, LOW: 40 } as const;

/**
 * Turns the client's measured posts into proposals (N22). Each proposal is stored as a `Recommendation` with source LEARNING (so it never appears in the other
 * intelligence lists) and carries its justification, data used, confidence, limits and the effects to verify. A proposal the client rejected, or accepted, is never
 * created again; an open one is refreshed with the latest figures. Nothing here publishes or changes a schedule: accepting records a decision and adopts an observation.
 */
@Injectable()
export class RecommendService {
  constructor(private readonly prisma: PrismaService, private readonly performance: PerformanceService, private readonly prefs: PreferencesService, private readonly audit: AuditService) {}

  /** The publishing constraints the proposals must respect (the account policy when there is one). */
  async constraints(businessId: string) {
    const p = await this.prisma.publishingPolicy.findFirst({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    return { timezone: p?.timezone ?? 'UTC', hours: ((p?.allowedPublishingHours as unknown as HoursWindow[] | undefined) ?? DEFAULT_HOURS), maxPostsPerDay: p?.maximumPostsPerDay ?? 2 };
  }

  async analysisInput(businessId: string, platform: string, now: Date) {
    const posts = (await this.performance.posts(businessId, { platform, now })).filter((p) => p.matured && p.engagementRate !== null);
    return posts.map((p): PerfPost => ({ id: p.publicationId, platform: p.platform, publishedAt: p.publishedAt, kind: p.kind, title: p.title, caption: p.caption, hashtags: p.hashtags, rate: p.engagementRate, origin: p.origin }));
  }

  /** Runs the analysis for every platform with data and stores the proposals, observations and hypotheses. */
  async generate(businessId: string, runId: string | null, now = new Date()): Promise<RecommendSummary & { results: Record<string, EngineResult> }> {
    const c = await this.constraints(businessId);
    const eff = await this.prefs.effective(businessId);
    const rows = await this.prefs.rows(businessId);
    const decided = await this.prisma.recommendation.findMany({ where: { businessId, source: 'LEARNING', status: 'REJECTED' }, select: { evidence: true } });
    const rejectedKeys = [...rows.filter((r) => r.status === 'REJECTED').map((r) => r.key), ...decided.map((d) => (d.evidence as { key?: string } | null)?.key ?? '')].filter(Boolean).flatMap((k) => [k, k.replace(/^[A-Z]+:/, '')]);
    const out: RecommendSummary & { results: Record<string, EngineResult> } = { analyzed: {}, created: 0, refreshed: 0, skippedDecided: 0, hypotheses: 0, inferences: 0, results: {} };
    for (const platform of ANALYTICS_PLATFORMS) {
      const posts = await this.analysisInput(businessId, platform, now);
      if (!posts.length) continue;
      const r = analyze(posts, { now, timezone: c.timezone, hours: c.hours, maxPostsPerDay: c.maxPostsPerDay, allowedKinds: eff['content.preferredTypes']?.origin === 'DECLARED' ? (eff['content.preferredTypes']!.value as string[]) : [], restrictions: eff['editorial.restrictions']?.origin === 'DECLARED' ? (eff['editorial.restrictions']!.value as string[]) : [], rejectedKeys });
      out.results[platform] = r;
      out.analyzed[platform] = { usable: r.usable, origin: r.origin, insufficient: r.insufficient, dropped: r.dropped.length };
      for (const rec of r.recommendations) {
        const s = await this.store(businessId, platform, rec, r);
        out[s]++;
      }
      for (const h of r.hypotheses) if (await this.prefs.learn(businessId, runId ?? 'manual', h.key, 'HYPOTHESIS', h.value as Record<string, unknown>, { statement: h.statement, n: h.n, platform }, 'LOW')) out.hypotheses++;
      for (const i of r.inferences) if (await this.prefs.learn(businessId, runId ?? 'manual', i.key, 'INFERRED', i.value, { n: i.n, platform, basis: r.origin }, i.confidence)) out.inferences++;
    }
    return out;
  }

  private async store(businessId: string, platform: string, rec: Rec, r: EngineResult): Promise<'created' | 'refreshed' | 'skippedDecided'> {
    const dedupeKey = `learn:${platform}:${rec.key}:${rec.kind}`.slice(0, 190);
    const evidence = { key: `${platform}:${rec.key}`, platform, justification: rec.justification, dataUsed: rec.dataUsed, limitations: rec.limitations, expectedEffects: rec.expectedEffects, basis: r.origin === 'REAL' ? 'REAL' : 'SIMULATED' } as unknown as Prisma.InputJsonValue;
    const data = { title: `${platform}: ${rec.title}`, evidence, confidence: rec.confidence, priority: PRIORITY[rec.confidence] + (r.origin === 'REAL' ? 5 : 0), proposedAction: rec.proposedAction as Prisma.InputJsonValue };
    const cur = await this.prisma.recommendation.findUnique({ where: { businessId_dedupeKey: { businessId, dedupeKey } } });
    if (cur) {
      if (cur.status !== 'PROPOSED') return 'skippedDecided';
      await this.prisma.recommendation.update({ where: { id: cur.id }, data });
      return 'refreshed';
    }
    await this.prisma.recommendation.create({ data: { businessId, kind: rec.kind, dedupeKey, costEstimate: { aiCostMicros: 0, adSpendMicros: 0, reviewMinutes: 3, note: 'Deterministic analysis: no AI call, no advertising spend.' }, problem: rec.justification, expectedBenefit: { type: 'NOT_ESTIMATED', reason: 'An effect on engagement can only be checked after new posts; none is promised.' }, risk: 'LOW', requiredApproval: 'MERCHANT', source: 'LEARNING', ...data } });
    return 'created';
  }

  async list(businessId: string, status?: string) {
    return this.prisma.recommendation.findMany({ where: { businessId, source: 'LEARNING', ...(status ? { status: status as never } : {}) }, orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }], take: 100 });
  }

  private async load(businessId: string, id: string) {
    const r = await this.prisma.recommendation.findFirst({ where: { id, businessId, source: 'LEARNING' } });
    if (!r) throw new NotFoundException({ code: 'RECOMMENDATION_NOT_FOUND', message: 'Recommendation not found' });
    return r;
  }

  /** The client decides. Accepting adopts the matching observation (it may then guide the next drafts, inside the publishing policy); rejecting is remembered. */
  async decide(t: TenantContext, id: string, decision: 'ACCEPT' | 'REJECT', reason?: string) {
    const r = await this.load(t.businessId, id);
    const status = decision === 'ACCEPT' ? 'APPROVED' : 'REJECTED';
    const res = await this.prisma.recommendation.updateMany({ where: { id, businessId: t.businessId, status: 'PROPOSED' }, data: { status, decidedById: t.userId, decidedAt: new Date() } });
    if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${r.status} recommendation cannot be decided again` });
    await this.prisma.recommendationFeedback.create({ data: { businessId: t.businessId, recommendationId: id, decision: decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', reason: reason?.slice(0, 300) ?? null, actorId: t.userId } });
    if (decision === 'ACCEPT') await this.adopt(t, r);
    await this.audit.record({ action: decision === 'ACCEPT' ? 'learning.recommendation_accepted' : 'learning.recommendation_rejected', actorId: t.userId, businessId: t.businessId, entityType: 'Recommendation', entityId: id, metadata: { kind: r.kind } });
    return { id, status };
  }

  private static readonly KEY: Record<string, string> = { POSTING_SLOT: 'inferred.bestSlot', VIDEO_FORMAT: 'inferred.bestKind', LENGTH: 'inferred.captionLength', HOOK: 'inferred.hook', TOPIC: 'inferred.topic', FREQUENCY: 'inferred.frequency' };
  private async adopt(t: TenantContext, r: { kind: string; proposedAction: unknown }) {
    const key = RecommendService.KEY[r.kind];
    if (!key) return;
    const row = await this.prisma.clientPreference.findUnique({ where: { businessId_key_origin: { businessId: t.businessId, key, origin: 'INFERRED' } } });
    if (!row || row.status !== 'ACTIVE') return;
    const version = row.version + 1;
    await this.prisma.clientPreference.update({ where: { id: row.id }, data: { evidence: { ...((row.evidence as object) ?? {}), adopted: true, adoptedBy: t.userId, adoptedAt: new Date().toISOString() } as Prisma.InputJsonValue, version } });
    await this.prisma.preferenceRevision.create({ data: { businessId: t.businessId, key, origin: 'INFERRED', version, value: row.value as Prisma.InputJsonValue, action: 'ADOPT', actorId: t.userId } });
  }

  async feedback(t: TenantContext, id: string, decision: 'USEFUL' | 'NOT_USEFUL', reason?: string) {
    await this.load(t.businessId, id);
    await this.prisma.recommendationFeedback.create({ data: { businessId: t.businessId, recommendationId: id, decision, reason: reason?.slice(0, 300) ?? null, actorId: t.userId } });
    return { id, decision };
  }
}
