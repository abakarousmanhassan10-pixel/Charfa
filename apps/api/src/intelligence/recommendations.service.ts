import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { AuditService } from '../audit/audit.service';
import { creativeStrategy } from '../campaigns/campaign-agents';
import { CampaignsService } from '../campaigns/campaigns.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { detectRegression, evalClaims, evalDuplicates, evalFactualAccuracy, evalQuality, summarize, type EvalResult, type SuiteRun } from './evaluators';
import { GOLDEN_PRODUCTS, goldenContext } from './intelligence.service';
import { MemoryService, PREFERENCE_KEYS } from './memory.service';

/** There is deliberately no advertising or budget kind: no recommendation can ask to spend money, and none is accepted if forged. */
export const RECOMMENDATION_KINDS = ['DATA_GAP', 'RECONNECT_ACCOUNT', 'REAL_METRICS', 'FOLLOW_UP', 'IMPROVEMENT'] as const;
type Kind = (typeof RECOMMENDATION_KINDS)[number];
interface Candidate { kind: Kind; campaignId?: string; title: string; evidence: Record<string, unknown>; reviewMinutes: number; priority: number; dedupeKey: string }

const DEFAULT_MAX = 900;

/** The fixed corpus every caption limit is evaluated on (offline: no tenant data, no network). */
export function improvementCorpus(maxCaption: number): SuiteRun {
  const ctx = goldenContext();
  const ideas = creativeStrategy(GOLDEN_PRODUCTS, ['en', 'fr'], 20, maxCaption).ideas;
  const results: EvalResult[] = [];
  ideas.forEach((i, k) => {
    const d = { title: i.title, caption: i.caption, hashtags: i.hashtags, productId: i.productId };
    results.push(evalFactualAccuracy(`idea${k}.factual`, d, ctx), evalClaims(`idea${k}.claims`, d, ctx), evalQuality(`idea${k}.quality`, d, { maxCaption }));
  });
  results.push(evalDuplicates('corpus.duplicates', ideas.map((i) => i.caption)));
  return summarize('improvement', 1, results);
}

@Injectable()
export class RecommendationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly campaigns: CampaignsService, private readonly memory: MemoryService) {}

  /** Finds opportunities in this business's authorized data. Each proposal explains its evidence; none is applied automatically. */
  async generate(tenant: TenantContext) {
    const b = tenant.businessId;
    const found: Candidate[] = [];
    const products = await this.prisma.product.findMany({ where: { businessId: b, deletedAt: null, status: 'ACTIVE' }, select: { id: true, name: true, description: true, price: true, benefits: true, targetAudience: true } });
    for (const p of products) {
      const missing = [!p.description && 'description', p.price === null && 'price', p.benefits.length === 0 && 'benefits', !p.targetAudience && 'targetAudience'].filter(Boolean) as string[];
      if (missing.length) found.push({ kind: 'DATA_GAP', title: `Complete the product data of "${p.name}"`, evidence: { productId: p.id, missing }, reviewMinutes: 3, priority: Math.min(90, 50 + 10 * missing.length), dedupeKey: `gap:${p.id}` });
    }
    for (const a of await this.prisma.socialAccount.findMany({ where: { businessId: b, status: { in: ['TOKEN_EXPIRED', 'PERMISSION_MISSING', 'ERROR'] } }, select: { id: true, platform: true, status: true } })) {
      found.push({ kind: 'RECONNECT_ACCOUNT', title: `Reconnect your ${a.platform} account`, evidence: { accountId: a.id, status: a.status }, reviewMinutes: 2, priority: 95, dedupeKey: `reconnect:${a.id}` });
    }
    for (const c of await this.prisma.campaign.findMany({ where: { businessId: b, status: { notIn: ['CANCELLED'] }, paused: false } })) {
      const ev = (c.plan as { evaluation?: { evidence: string; counts: { unavailable: number }; followUps: Array<{ basedOnPublicationId: string; basis: 'REAL' | 'SIMULATED'; angle: string }> } } | null)?.evaluation;
      if (!ev) continue;
      if (ev.evidence === 'SIMULATED_ONLY' || ev.counts.unavailable > 0) found.push({ kind: 'REAL_METRICS', campaignId: c.id, title: `Get real measurements for "${c.name}"`, evidence: { campaignId: c.id, evidence: ev.evidence, unavailable: ev.counts.unavailable }, reviewMinutes: 5, priority: 40, dedupeKey: `metrics:${c.id}` });
      for (const f of ev.followUps) found.push({ kind: 'FOLLOW_UP', campaignId: c.id, title: `Draft a follow-up post for "${c.name}"`, evidence: { campaignId: c.id, basedOnPublicationId: f.basedOnPublicationId, basis: f.basis, angle: f.angle, note: f.basis === 'SIMULATED' ? 'Based on simulated data only.' : 'Based on measured engagement; not a sales effect.' }, reviewMinutes: 4, priority: f.basis === 'REAL' ? 70 : 30, dedupeKey: `followup:${c.id}:${f.basedOnPublicationId}` });
    }
    let created = 0;
    for (const c of found) {
      try { await this.create(b, c); created++; } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; }
    }
    await this.audit.record({ action: 'intelligence.recommendations_generated', actorId: tenant.userId, businessId: b, entityType: 'Recommendation', entityId: b, metadata: { candidates: found.length, created } });
    return { candidates: found.length, created, skippedDuplicates: found.length - created };
  }

  private async create(businessId: string, c: Candidate & { change?: unknown }) {
    if (!(RECOMMENDATION_KINDS as readonly string[]).includes(c.kind)) throw new BadRequestException({ code: 'INVALID_KIND', message: 'Unknown recommendation kind' });
    return this.prisma.recommendation.create({
      data: { businessId, campaignId: c.campaignId ?? null, kind: c.kind, title: c.title, evidence: c.evidence as Prisma.InputJsonValue, costEstimate: { aiCostMicros: 0, adSpendMicros: 0, reviewMinutes: c.reviewMinutes, note: 'Mock agents cost 0 USD. Review time is an estimate. No advertising spend.' }, priority: c.priority, dedupeKey: c.dedupeKey, ...(c.change ? { change: c.change as Prisma.InputJsonValue } : {}) },
    });
  }

  async list(tenant: TenantContext, status?: string) {
    const where: Prisma.RecommendationWhereInput = { businessId: tenant.businessId, ...(status ? { status: status as never } : {}) };
    return { items: await this.prisma.recommendation.findMany({ where, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 100 }) };
  }

  private async load(tenant: TenantContext, id: string) {
    const r = await this.prisma.recommendation.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!r) throw new NotFoundException({ code: 'RECOMMENDATION_NOT_FOUND', message: 'Recommendation not found' });
    return r;
  }

  /** The merchant decides. Approving a follow-up only creates DRAFT posts (each still needs its own approval); approving an improvement needs a passed offline evaluation. */
  async approve(tenant: TenantContext, id: string) {
    const r = await this.load(tenant, id);
    if (r.status !== 'PROPOSED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${r.status} recommendation cannot be approved` });
    if (r.kind === 'IMPROVEMENT') {
      const ev = r.offlineEval as { passed?: boolean } | null;
      if (!ev || ev.passed !== true) throw new ConflictException({ code: 'EVALUATION_REQUIRED', message: 'Run the offline evaluation first; a change that did not pass it cannot be approved.' });
    }
    const claimed = await this.prisma.recommendation.updateMany({ where: { id, businessId: tenant.businessId, status: 'PROPOSED' }, data: { status: 'APPROVED', decidedById: tenant.userId, decidedAt: new Date() } });
    if (!claimed.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This recommendation was decided by someone else' });
    let action: unknown = null;
    try {
      if (r.kind === 'FOLLOW_UP' && r.campaignId) action = await this.campaigns.followUps(tenant, r.campaignId);
      if (r.kind === 'IMPROVEMENT') {
        const ch = r.change as { key: string; to: number };
        await this.memory.put(tenant, { kind: 'PREFERENCE', key: ch.key, value: { value: ch.to, recommendationId: r.id }, provenance: 'MERCHANT' });
        action = { applied: ch };
      }
    } catch (e) {
      await this.prisma.recommendation.update({ where: { id }, data: { status: 'PROPOSED', decidedById: null, decidedAt: null } });
      throw e;
    }
    await this.memory.put(tenant, { kind: 'DECISION', key: `recommendation.${r.id}`, value: { kind: r.kind, title: r.title, decision: 'APPROVED' }, provenance: 'MERCHANT', sourceRef: r.id });
    await this.audit.record({ action: 'intelligence.recommendation_approved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Recommendation', entityId: id, metadata: { kind: r.kind } });
    return { id, status: 'APPROVED', action };
  }

  async reject(tenant: TenantContext, id: string) {
    const r = await this.load(tenant, id);
    const res = await this.prisma.recommendation.updateMany({ where: { id, businessId: tenant.businessId, status: 'PROPOSED' }, data: { status: 'REJECTED', decidedById: tenant.userId, decidedAt: new Date() } });
    if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${r.status} recommendation cannot be rejected` });
    await this.memory.put(tenant, { kind: 'DECISION', key: `recommendation.${r.id}`, value: { kind: r.kind, title: r.title, decision: 'REJECTED' }, provenance: 'MERCHANT', sourceRef: r.id });
    await this.audit.record({ action: 'intelligence.recommendation_rejected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Recommendation', entityId: id });
    return { id, status: 'REJECTED' };
  }

  // ─── Safe self-improvement ──────────────────────────────────────────────────

  /** Proposes a bounded change to agent behavior. It changes nothing until evaluated offline and approved by the merchant. */
  async proposeImprovement(tenant: TenantContext, i: { key: string; value: number }, origin: 'MERCHANT' | 'AGENT' = 'MERCHANT') {
    const range = PREFERENCE_KEYS[i.key];
    if (!range || !Number.isInteger(i.value) || i.value < range.min || i.value > range.max) throw new BadRequestException({ code: 'INVALID_IMPROVEMENT', message: `Allowed: ${Object.entries(PREFERENCE_KEYS).map(([k, r]) => `${k} (${r.min}-${r.max})`).join(', ')}. Prompts, code and tools cannot be changed here.` });
    const current = (await this.memory.preference(tenant.businessId, i.key)) ?? DEFAULT_MAX;
    if (current === i.value) throw new ConflictException({ code: 'NO_CHANGE', message: 'This is already the current value' });
    const c: Candidate & { change: unknown } = { kind: 'IMPROVEMENT', title: `Set ${i.key} to ${i.value} (now ${current})`, evidence: { origin, rationale: origin === 'AGENT' ? 'proposed by the optimization agent from the merchant\'s own drafts' : 'proposed by the merchant' }, reviewMinutes: 2, priority: 50, dedupeKey: `improve:${i.key}:${i.value}`, change: { key: i.key, from: current, to: i.value } };
    try { return await this.create(tenant.businessId, c); } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'ALREADY_PROPOSED', message: 'This change was already proposed' });
      throw e;
    }
  }

  /** The agent looks at this merchant's AI drafts and proposes a tighter caption limit when drafts run long. */
  async suggestImprovements(tenant: TenantContext) {
    const drafts = await this.prisma.content.findMany({ where: { businessId: tenant.businessId, origin: 'AI_GENERATED', deletedAt: null }, select: { caption: true }, take: 200 });
    const longest = drafts.reduce((m, d) => Math.max(m, d.caption?.length ?? 0), 0);
    if (longest <= 600) return { proposed: [] as string[], note: `The longest AI draft has ${longest} characters: no change suggested.` };
    const current = (await this.memory.preference(tenant.businessId, 'creative.maxCaptionChars')) ?? DEFAULT_MAX;
    if (current <= 600) return { proposed: [], note: 'The caption limit is already 600 or lower.' };
    const r = await this.proposeImprovement(tenant, { key: 'creative.maxCaptionChars', value: 600 }, 'AGENT').catch(() => null);
    return { proposed: r ? [r.id] : [], note: `The longest AI draft has ${longest} characters.` };
  }

  /** Offline evaluation: baseline vs candidate on the fixed corpus. A candidate that makes any passing case fail, or lowers the score, is rejected. */
  async evaluateImprovement(tenant: TenantContext, id: string) {
    const r = await this.load(tenant, id);
    if (r.kind !== 'IMPROVEMENT') throw new BadRequestException({ code: 'NOT_AN_IMPROVEMENT', message: 'Only improvements are evaluated offline' });
    if (r.status !== 'PROPOSED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${r.status} proposal cannot be evaluated` });
    const ch = r.change as { key: string; from: number; to: number };
    const base = improvementCorpus(ch.from);
    const cand = improvementCorpus(ch.to);
    const regression = detectRegression(base, cand);
    const offlineEval = { passed: !regression.regressed, baseline: { max: ch.from, score: base.score }, candidate: { max: ch.to, score: cand.score }, regression, failing: cand.results.filter((x) => !x.pass).slice(0, 5).map((x) => ({ id: x.id, detail: x.detail })), evaluatedAt: new Date().toISOString() };
    await this.prisma.recommendation.update({ where: { id }, data: { offlineEval: offlineEval as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ action: 'intelligence.improvement_evaluated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Recommendation', entityId: id, metadata: { passed: offlineEval.passed } });
    return offlineEval;
  }
}
