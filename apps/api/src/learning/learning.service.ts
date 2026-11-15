import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { regressions, runLearningSuite, type EvalCase } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { lockTenantQuota } from '../common/tenant-quota';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublishingPlannerService } from '../publishing/planner.service';
import { PublishingPolicyService } from '../publishing/policy.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { LearningProfileService } from './learning-profile.service';
import { PerformanceService } from './performance.service';
import { PreferencesService } from './preferences.service';
import { RecommendService } from './recommend.service';

type StepName = 'COLLECT' | 'ANALYZE' | 'RECOMMEND' | 'VALIDATE_POLICY' | 'EXECUTE' | 'MEASURE';
interface Step { step: StepName; status: 'OK' | 'SKIPPED' | 'BLOCKED' | 'FAILED'; detail: string; data?: Record<string, unknown> }
const MEASURE_AFTER_DAYS = 14;
const DAY = 86_400_000;

/**
 * The learning loop (N22): COLLECT -> ANALYZE -> RECOMMEND -> VALIDATE POLICY -> EXECUTE IF AUTHORIZED -> MEASURE.
 * It is a guest in the publishing system, not a second one: EXECUTE can only prepare next week's drafts through the same planner and the same publishing pipeline
 * (consent, policy, classifier, approval, publication gate), so it can never publish anything the policy would not. It stops before doing anything when the consent is
 * missing, an emergency stop is on, the subscription is not active, the daily run quota is used or another run is in progress, and it spends no AI money (the analysis
 * is deterministic). Every run records what it did and the preferences before and after, so it can be reverted.
 */
@Injectable()
export class LearningService {
  private readonly logger = new Logger('LearningLoop');
  constructor(
    private readonly prisma: PrismaService, private readonly profile: LearningProfileService, private readonly performance: PerformanceService, private readonly recs: RecommendService,
    private readonly prefs: PreferencesService, private readonly planner: PublishingPlannerService, private readonly policies: PublishingPolicyService, private readonly billing: BillingService,
    private readonly audit: AuditService, @InjectEnv() private readonly env: AppEnv,
  ) {}

  private snapshotConfig(businessId: string) {
    return this.prisma.clientPreference.findMany({ where: { businessId, origin: { in: ['INFERRED', 'HYPOTHESIS'] } }, select: { key: true, origin: true, value: true, status: true, evidence: true, confidence: true, version: true } });
  }

  /** Why a run may not start (null = it may). */
  private async refusal(businessId: string, now: Date): Promise<{ code: string; message: string } | null> {
    const g = await this.profile.get(businessId);
    if (!g.consentValid) return { code: 'CONSENT_REQUIRED', message: 'The learning consent is missing, revoked or outdated' };
    if (!g.enabled) return { code: 'LEARNING_DISABLED', message: 'Learning is switched off for this business' };
    const stop = await this.prisma.agentControl.findFirst({ where: { stopped: true, OR: [{ scope: 'GLOBAL', scopeId: '' }, { scope: 'TENANT', scopeId: businessId }] } });
    if (stop) return { code: 'AUTOMATION_STOPPED', message: 'An administrator stopped the automation' };
    try { await this.billing.assertAccess(businessId); } catch (e) { if (e instanceof HttpException) return { code: 'SUBSCRIPTION_REQUIRED', message: 'The subscription does not allow this' }; throw e; }
    const since = new Date(now.getTime() - DAY);
    const runs = await this.prisma.learningRun.count({ where: { businessId, startedAt: { gte: since }, status: { not: 'BLOCKED' } } });
    if (runs >= g.maxRunsPerDay) return { code: 'RUN_QUOTA', message: `The limit of ${g.maxRunsPerDay} run(s) per day was reached` };
    return null;
  }

  /** Records a refused run (so the history shows why nothing happened) and returns it. */
  private async blocked(businessId: string, trigger: string, r: { code: string; message: string }) {
    return this.prisma.learningRun.create({ data: { businessId, trigger, status: 'BLOCKED', blockedReason: `${r.code}: ${r.message}`, steps: [{ step: 'COLLECT', status: 'BLOCKED', detail: r.message }] as unknown as Prisma.InputJsonValue, costEstimate: { aiCostMicros: 0 }, finishedAt: new Date() } });
  }

  async run(businessId: string, trigger: 'MANUAL' | 'SCHEDULED', actor?: TenantContext | null, now = new Date()) {
    const why = await this.refusal(businessId, now);
    if (why) return this.blocked(businessId, trigger, why);
    // One run at a time per business; the row is created under the same lock that counts the running ones.
    const run = await this.prisma.$transaction(async (tx) => {
      await lockTenantQuota(tx, 'learning', businessId);
      const active = await tx.learningRun.findFirst({ where: { businessId, status: 'RUNNING', startedAt: { gte: new Date(now.getTime() - 30 * 60_000) } } });
      if (active) return null;
      return tx.learningRun.create({ data: { businessId, trigger, status: 'RUNNING', steps: [], costEstimate: { aiCostMicros: 0, adSpendMicros: 0, note: 'Deterministic analysis: no AI call and no advertising spend. A real model would add per-call cost.' } } });
    });
    if (!run) return this.blocked(businessId, trigger, { code: 'ALREADY_RUNNING', message: 'Another run is in progress' });
    const steps: Step[] = [];
    const save = (data: Prisma.LearningRunUpdateInput) => this.prisma.learningRun.update({ where: { id: run.id }, data: { steps: steps as unknown as Prisma.InputJsonValue, ...data } });
    try {
      const configBefore = await this.snapshotConfig(businessId);
      // COLLECT
      const col = await this.performance.collect(businessId, now);
      if (col.considered > 0 && col.collected === 0 && col.failed > 0) {
        steps.push({ step: 'COLLECT', status: 'FAILED', detail: 'The analytics source could not be reached; nothing was analyzed or changed.', data: { ...col } });
        return await save({ status: 'FAILED', blockedReason: 'COLLECT_FAILED: analytics source unreachable', counts: col as unknown as Prisma.InputJsonValue, configBefore: configBefore as unknown as Prisma.InputJsonValue, finishedAt: new Date() });
      }
      steps.push({ step: 'COLLECT', status: 'OK', detail: `${col.collected} post(s) measured, ${col.pendingMaturity} still too recent, ${col.unavailable} without metrics`, data: { ...col } });
      // ANALYZE + RECOMMEND
      const gen = await this.recs.generate(businessId, run.id, now);
      const { results: _results, ...summary } = gen; void _results;
      steps.push({ step: 'ANALYZE', status: 'OK', detail: Object.entries(gen.analyzed).map(([p, a]) => `${p}: ${a.usable} measured post(s), ${a.origin}`).join('; ') || 'No post with measurements', data: { analyzed: gen.analyzed } });
      steps.push({ step: 'RECOMMEND', status: 'OK', detail: `${gen.created} new, ${gen.refreshed} refreshed, ${gen.skippedDecided} already decided, ${gen.hypotheses} hypothesis(es) to confirm`, data: summary });
      const configAfter = await this.snapshotConfig(businessId);
      const all = Object.values(gen.results).flatMap((r) => r.baselineRate === null ? [] : [{ rate: r.baselineRate, n: r.usable }]);
      const baseline = all.length ? { meanEngagement: all.reduce((a, b) => a + b.rate * b.n, 0) / all.reduce((a, b) => a + b.n, 0), n: all.reduce((a, b) => a + b.n, 0), at: now.toISOString() } : null;
      // VALIDATE POLICY + EXECUTE
      steps.push(...(await this.execute(businessId, actor ?? null, now)));
      // MEASURE earlier runs
      steps.push(await this.measure(businessId, now));
      await this.prisma.learningProfile.update({ where: { businessId }, data: { lastRunAt: now } });
      await this.audit.record({ action: 'learning.run_completed', actorId: actor?.userId ?? null, businessId, entityType: 'LearningRun', entityId: run.id, metadata: { trigger, created: gen.created } });
      return await save({ status: 'COMPLETED', counts: summary as unknown as Prisma.InputJsonValue, configBefore: configBefore as unknown as Prisma.InputJsonValue, configAfter: configAfter as unknown as Prisma.InputJsonValue, baseline: baseline as unknown as Prisma.InputJsonValue, finishedAt: new Date() });
    } catch (e) {
      this.logger.warn(`run ${run.id} failed: ${(e as Error).message}`);
      steps.push({ step: 'ANALYZE', status: 'FAILED', detail: 'The run stopped on an internal error; nothing was published.' });
      return save({ status: 'FAILED', blockedReason: 'INTERNAL_ERROR', finishedAt: new Date() });
    }
  }

  /** VALIDATE POLICY then EXECUTE: only prepares next week's drafts, only when allowed, and the publishing pipeline still decides each one. */
  private async execute(businessId: string, actor: TenantContext | null, now: Date): Promise<Step[]> {
    const g = await this.profile.get(businessId);
    if (!g.autoPlan) return [{ step: 'VALIDATE_POLICY', status: 'OK', detail: 'Automatic planning is off: proposals only, nothing was scheduled.' }, { step: 'EXECUTE', status: 'SKIPPED', detail: 'Nothing to execute.' }];
    const accounts = await this.prisma.socialAccount.findMany({ where: { businessId, status: 'CONNECTED', deletedAt: null, platform: { in: ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] }, publishingPolicy: { is: { consentGrantedAt: { not: null }, consentRevokedAt: null } } }, include: { publishingPolicy: true } });
    const out: Step[] = [];
    const planned: Array<{ accountId: string; entries: number; decisions: string[] }> = [];
    const refused: string[] = [];
    for (const a of accounts) {
      const p = a.publishingPolicy!;
      const view = await this.policies.get({ businessId } as TenantContext, a.id);
      if (view.effectiveMode === 'MANUAL') { refused.push(`${a.platform}: policy is MANUAL (drafts would only wait for a person)`); }
      const grantor = p.consentGrantedById ? await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: p.consentGrantedById, businessId } } }) : null;
      if (!grantor || grantor.status !== 'ACTIVE') { refused.push(`${a.platform}: the person who gave the publishing consent is no longer active`); continue; }
      const t: TenantContext = { businessId, membershipId: grantor.id, role: grantor.role, userId: grantor.userId };
      const eff = await this.prefs.effective(businessId);
      const adopted = async (key: string) => { const r = await this.prisma.clientPreference.findUnique({ where: { businessId_key_origin: { businessId, key, origin: 'INFERRED' } } }); return r && r.status === 'ACTIVE' && (r.evidence as { adopted?: boolean } | null)?.adopted ? (r.value as Record<string, unknown>) : null; };
      const slot = (eff['publishing.preferredHour']?.origin === 'DECLARED' ? { hour: eff['publishing.preferredHour']!.value as number } : await adopted('inferred.bestSlot')) as { hour?: number } | null;
      const freq = await adopted('inferred.frequency') as { postsPerWeek?: number } | null;
      const count = Math.max(1, Math.min(freq?.postsPerWeek ?? 3, 7, p.maximumPostsPerDay * 7));
      const upcoming = await this.prisma.calendarEvent.count({ where: { businessId, deletedAt: null, status: { not: 'CANCELLED' }, scheduledAt: { gt: now, lt: new Date(now.getTime() + 7 * DAY) }, OR: [{ socialAccountId: a.id }, { authorizedAccountId: a.id }] } });
      if (upcoming >= count) { refused.push(`${a.platform}: ${upcoming} post(s) already planned for the next 7 days`); continue; }
      const res = await this.planner.plan(t, { accountId: a.id, days: 7, process: true, hour: slot?.hour, maxPosts: count - upcoming });
      planned.push({ accountId: a.id, entries: res.entries.length, decisions: res.entries.map((e) => e.decision?.action ?? 'ERROR') });
    }
    out.push({ step: 'VALIDATE_POLICY', status: 'OK', detail: accounts.length ? `${accounts.length} account(s) with a publishing consent; ${refused.length} not planned` : 'No account has a publishing consent: nothing can be planned', data: { refused } });
    out.push({ step: 'EXECUTE', status: planned.length ? 'OK' : 'SKIPPED', detail: planned.length ? `Drafts prepared and handed to the publishing policy: ${planned.map((x) => x.decisions.join(', ')).join(' | ')}` : 'No draft was prepared', data: { planned } });
    void actor;
    return out;
  }

  /** Before/after: posts published since an earlier run against that run's baseline. Correlational, with the sample size; too few posts concludes nothing. */
  private async measure(businessId: string, now: Date): Promise<Step> {
    const old = await this.prisma.learningRun.findMany({ where: { businessId, status: 'COMPLETED', outcome: { equals: Prisma.DbNull }, finishedAt: { lt: new Date(now.getTime() - MEASURE_AFTER_DAYS * DAY) }, baseline: { not: Prisma.DbNull } }, take: 10 });
    let measured = 0;
    for (const r of old) {
      const base = r.baseline as { meanEngagement: number; n: number } | null;
      if (!base) continue;
      const posts = (await this.performance.posts(businessId, { now })).filter((p) => p.matured && p.engagementRate !== null && p.publishedAt > r.finishedAt!);
      const outcome = posts.length < 4
        ? { status: 'INSUFFICIENT_DATA', nAfter: posts.length, note: 'Fewer than 4 posts since this run: no comparison is made.' }
        : { status: 'MEASURED', nAfter: posts.length, meanAfter: posts.reduce((a, b) => a + b.engagementRate!, 0) / posts.length, baseline: base.meanEngagement, nBefore: base.n, origin: posts.every((p) => p.origin === 'SIMULATED') ? 'SIMULATED' : 'REAL', note: 'A before/after comparison on different posts and dates: it can reflect season, content or audience changes and does not show that the run caused it.' };
      await this.prisma.learningRun.update({ where: { id: r.id }, data: { outcome: outcome as unknown as Prisma.InputJsonValue } });
      measured++;
    }
    return { step: 'MEASURE', status: measured ? 'OK' : 'SKIPPED', detail: measured ? `${measured} earlier run(s) measured` : 'No earlier run is old enough to measure' };
  }

  async list(businessId: string) { return this.prisma.learningRun.findMany({ where: { businessId }, orderBy: { startedAt: 'desc' }, take: 50 }); }

  /** Goes back to the configuration (inferred observations and hypotheses) that existed before a run. Declared preferences are the client's and are never touched. */
  async rollback(t: TenantContext, runId: string) {
    const run = await this.prisma.learningRun.findFirst({ where: { id: runId, businessId: t.businessId } });
    if (!run || !run.configBefore) return null;
    const before = run.configBefore as unknown as Array<{ key: string; origin: 'INFERRED' | 'HYPOTHESIS'; value: Prisma.InputJsonValue; status: string; evidence: Prisma.InputJsonValue | null; confidence: string | null; version: number }>;
    await this.prisma.$transaction(async (tx) => {
      await tx.clientPreference.deleteMany({ where: { businessId: t.businessId, origin: { in: ['INFERRED', 'HYPOTHESIS'] } } });
      for (const r of before) await tx.clientPreference.create({ data: { businessId: t.businessId, key: r.key, origin: r.origin, value: r.value, status: r.status, evidence: r.evidence ?? Prisma.JsonNull, confidence: r.confidence, version: r.version + 1, updatedById: t.userId } });
      await tx.preferenceRevision.create({ data: { businessId: t.businessId, key: '*', origin: 'INFERRED', version: 0, value: { restoredKeys: before.map((b) => b.key) } as Prisma.InputJsonValue, action: 'ROLLBACK', actorId: t.userId, runId } });
      await tx.learningRun.update({ where: { id: runId }, data: { status: 'ROLLED_BACK' } });
    });
    await this.audit.record({ action: 'learning.run_rolled_back', actorId: t.userId, businessId: t.businessId, entityType: 'LearningRun', entityId: runId });
    return this.prisma.learningRun.findUnique({ where: { id: runId } });
  }

  // ─── Quality evaluation ────────────────────────────────────────────────

  /** Runs the fixed corpus and stores the result; a case that passed before and fails now is a regression. */
  async evaluate(businessId: string) {
    const suite = runLearningSuite();
    const prev = await this.prisma.evaluationRun.findFirst({ where: { businessId, suite: suite.suite }, orderBy: { createdAt: 'desc' } });
    const reg = regressions((prev?.results as unknown as { cases?: EvalCase[] } | null)?.cases ?? null, suite.cases);
    const row = await this.prisma.evaluationRun.create({ data: { businessId, suite: suite.suite, version: suite.version, passed: suite.passed && reg.length === 0, score: suite.score, results: { cases: suite.cases, regressions: reg } as unknown as Prisma.InputJsonValue } });
    return { id: row.id, passed: row.passed, score: row.score, cases: suite.cases, regressions: reg, createdAt: row.createdAt };
  }

  /** How the proposals fare with this client: decisions, usefulness feedback and before/after outcomes. None of it proves a proposal was better. */
  async quality(businessId: string) {
    const [fb, runs, latest] = await Promise.all([
      this.prisma.recommendationFeedback.groupBy({ by: ['decision'], where: { businessId }, _count: { _all: true } }),
      this.prisma.learningRun.findMany({ where: { businessId, outcome: { not: Prisma.DbNull } }, orderBy: { startedAt: 'desc' }, take: 10, select: { id: true, startedAt: true, outcome: true } }),
      this.prisma.evaluationRun.findFirst({ where: { businessId, suite: 'learning-golden' }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { feedback: Object.fromEntries(fb.map((f) => [f.decision, f._count._all])), outcomes: runs, golden: latest && { passed: latest.passed, score: latest.score, at: latest.createdAt, regressions: (latest.results as { regressions?: string[] }).regressions ?? [] }, note: 'Acceptance and usefulness show how clients judge the proposals; before/after outcomes are correlational. A new proposal is not assumed to be better than the previous setting: compare, and roll back if it is not.' };
  }

  /** The scheduled pass: every business whose consent is valid and whose last run is older than the interval. */
  async tick(now = new Date()) {
    const due = await this.prisma.learningProfile.findMany({ where: { enabled: true, consentGrantedAt: { not: null }, consentRevokedAt: null, OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - this.env.LEARNING_RUN_INTERVAL_HOURS * 3_600_000) } }] }, take: 20 });
    const out: Array<{ businessId: string; status: string }> = [];
    for (const p of due) { try { const r = await this.run(p.businessId, 'SCHEDULED', null, now); out.push({ businessId: p.businessId, status: r.status }); } catch (e) { this.logger.warn(`scheduled run ${p.businessId}: ${(e as Error).message}`); } }
    return out;
  }
}
