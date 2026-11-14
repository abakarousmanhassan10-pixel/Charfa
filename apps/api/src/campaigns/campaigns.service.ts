import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Campaign } from '@touma/database';
import { assessGrounding, checkFactPreservation, type BusinessContext } from '@touma/ai-engine';
import { AGENT_CONTRACTS, CAMPAIGN_LIMITS, canMoveCampaign, type CampaignAgentId, type CampaignStatusId } from '@touma/shared';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { CalendarService } from '../calendar/calendar.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocialAnalyticsService } from '../social/social-analytics.service';
import { SocialInteractionsService } from '../social/social-interactions.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { CreateEntryDto } from '../calendar/calendar.dto';
import {
  audienceStrategy, campaignPlanning, creativeStrategy, customerServiceTriage, marketResearch, performanceAnalysis, productIntelligence,
  type CampaignPlan, type ContentIdea, type MetricRow, type PerformanceReport, type ProductFacts,
} from './campaign-agents';

const PLAN_MAX_BYTES = 60_000;
const TERMINAL_ENTRY = new Set(['PUBLISHED', 'CANCELLED', 'REJECTED', 'FAILED', 'ARCHIVED']);
const day = (d = new Date()) => d.toISOString().slice(0, 10);

interface StoredPlan extends CampaignPlan {
  version: number;
  products: ReturnType<typeof productIntelligence>['insights'];
  market: ReturnType<typeof marketResearch>;
  audiences: ReturnType<typeof audienceStrategy>;
  rejected: Array<{ index: number; code: string; detail?: string[] }>;
  languages: string[];
  evaluation?: PerformanceReport & { evaluatedAt: string };
}

/**
 * Phase N20, the AI Marketing Director for one vertical slice. It coordinates bounded mock agents in a FIXED order (agents cannot
 * call each other), and only ever creates DRAFT calendar entries. Approval, authorization, scheduling and publishing remain the
 * N18 individual approval; this service has no way to approve, authorize or publish anything.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly knowledge: KnowledgeService,
    private readonly calendar: CalendarService,
    private readonly analytics: SocialAnalyticsService,
    private readonly interactions: SocialInteractionsService,
  ) {}

  // ─── Agent execution (budget, limits, timeout, idempotency, audit) ──────────

  /** Test hook: makes the next execution of an agent take this many ms or throw. */
  readonly faults = new Map<CampaignAgentId, { delayMs?: number; fail?: boolean }>();

  private async exec<I, O>(tenant: TenantContext, campaignId: string, agent: CampaignAgentId, key: string, input: I, fn: (i: I) => O | Promise<O>): Promise<O> {
    const contract = AGENT_CONTRACTS[agent];
    const c = await this.prisma.campaign.findFirst({ where: { id: campaignId, businessId: tenant.businessId } });
    if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' });
    if (c.paused || c.status === 'CANCELLED') throw new ConflictException({ code: 'CAMPAIGN_PAUSED', message: 'This campaign is paused or cancelled: no agent runs.' });
    const inputHash = createHash('sha256').update(JSON.stringify(input) ?? '').digest('hex');
    const existing = await this.prisma.agentExecution.findUnique({ where: { campaignId_idempotencyKey: { campaignId, idempotencyKey: key } } });
    if (existing?.status === 'SUCCEEDED') return existing.output as O; // replay: no second run, no cost
    if (existing && existing.attempts >= contract.maxAttemptsPerKey) throw new ConflictException({ code: 'RETRY_LIMIT', message: `${agent} already failed ${existing.attempts} times for this request.` });
    const used = await this.prisma.agentExecution.count({ where: { campaignId, agent } });
    if (!existing && used >= contract.maxExecutionsPerCampaign) throw new ConflictException({ code: 'AGENT_LIMIT', message: `${agent} reached its limit for this campaign.` });
    if (c.costUsedMicros + contract.costMicros > c.costLimitMicros && contract.costMicros > 0) throw new ConflictException({ code: 'COST_LIMIT', message: 'The campaign cost budget is exhausted. Nothing was run.' });
    // Reserve one execution atomically (two concurrent runs can never exceed the limit), before doing any work.
    const reserved = await this.prisma.campaign.updateMany({ where: { id: c.id, executionsUsed: { lt: c.executionLimit } }, data: { executionsUsed: { increment: 1 }, costUsedMicros: { increment: contract.costMicros } } });
    if (!reserved.count) throw new ConflictException({ code: 'EXECUTION_LIMIT', message: 'The campaign execution budget is exhausted. Nothing was run.' });

    const started = Date.now();
    let status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' = 'SUCCEEDED';
    let output: O | undefined;
    let errorCode: string | null = null;
    const fault = this.faults.get(agent);
    if (fault) this.faults.delete(agent);
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        if (fault?.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
        if (fault?.fail) throw new Error('simulated failure');
        return fn(input);
      })();
      output = await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), contract.timeoutMs); })]);
      if (Buffer.byteLength(JSON.stringify(output) ?? '') > PLAN_MAX_BYTES) throw new Error('OUTPUT_TOO_LARGE');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      status = msg === 'TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
      errorCode = msg === 'TIMEOUT' ? 'AGENT_TIMEOUT' : msg === 'OUTPUT_TOO_LARGE' ? 'OUTPUT_TOO_LARGE' : 'AGENT_FAILED';
    } finally {
      if (timer) clearTimeout(timer);
    }
    const durationMs = Date.now() - started;
    const data = { status, inputHash, output: status === 'SUCCEEDED' ? (output as unknown as Prisma.InputJsonValue) : Prisma.DbNull, errorCode, costMicros: contract.costMicros, durationMs };
    try {
      if (existing) await this.prisma.agentExecution.update({ where: { id: existing.id }, data: { ...data, attempts: { increment: 1 } } });
      else await this.prisma.agentExecution.create({ data: { businessId: tenant.businessId, campaignId, agent, idempotencyKey: key, ...data } });
    } catch (e) {
      // A concurrent identical request stored its result first: return that one.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.agentExecution.findUnique({ where: { campaignId_idempotencyKey: { campaignId, idempotencyKey: key } } });
        if (won?.status === 'SUCCEEDED') return won.output as O;
      }
      throw e;
    }
    await this.audit.record({ action: `campaign.agent_${status.toLowerCase()}`, actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: campaignId, metadata: { agent, key, durationMs, errorCode } });
    if (status === 'TIMED_OUT') throw new HttpException({ code: 'AGENT_TIMEOUT', message: `${agent} took too long and was stopped.` }, HttpStatus.GATEWAY_TIMEOUT);
    if (status === 'FAILED') throw new HttpException({ code: errorCode ?? 'AGENT_FAILED', message: `${agent} failed. Nothing was published or sent.` }, HttpStatus.BAD_GATEWAY);
    return output as O;
  }

  // ─── Campaign lifecycle ─────────────────────────────────────────────────────

  async create(tenant: TenantContext, dto: { name: string; goalType: string; goalText?: string; productIds: string[]; idempotencyKey: string }) {
    const ids = [...new Set(dto.productIds)];
    if (ids.length === 0 || ids.length > CAMPAIGN_LIMITS.productsMax) throw new BadRequestException({ code: 'INVALID_PRODUCTS', message: `Choose 1 to ${CAMPAIGN_LIMITS.productsMax} products` });
    const found = await this.prisma.product.findMany({ where: { id: { in: ids }, businessId: tenant.businessId, deletedAt: null, status: 'ACTIVE' }, select: { id: true } });
    if (found.length !== ids.length) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Every product must be an active product of this business' });
    const prior = await this.prisma.campaign.findUnique({ where: { businessId_idempotencyKey: { businessId: tenant.businessId, idempotencyKey: dto.idempotencyKey } } });
    if (prior) return this.view(tenant, prior.id);
    let c: Campaign;
    try {
      c = await this.prisma.campaign.create({
        data: {
          businessId: tenant.businessId, name: dto.name.trim(), goal: { type: dto.goalType, ...(dto.goalText ? { description: dto.goalText.trim() } : {}) }, idempotencyKey: dto.idempotencyKey, createdById: tenant.userId,
          products: { create: ids.map((productId) => ({ productId, businessId: tenant.businessId })) },
        },
      });
    } catch (e) {
      // A concurrent request with the same key won the race: return its campaign.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.campaign.findUnique({ where: { businessId_idempotencyKey: { businessId: tenant.businessId, idempotencyKey: dto.idempotencyKey } } });
        if (won) return this.view(tenant, won.id);
      }
      throw e;
    }
    await this.audit.record({ action: 'campaign.created', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: c.id, metadata: { products: ids.length, goal: dto.goalType } });
    return this.view(tenant, c.id);
  }

  private async load(tenant: TenantContext, id: string): Promise<Campaign> {
    const c = await this.prisma.campaign.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' });
    return c;
  }
  private async move(c: Campaign, to: CampaignStatusId) {
    if (!canMoveCampaign(c.status as CampaignStatusId, to)) throw new ConflictException({ code: 'INVALID_STATE', message: `A ${c.status} campaign cannot become ${to}` });
    return this.prisma.campaign.update({ where: { id: c.id }, data: { status: to } });
  }
  private async facts(tenant: TenantContext, c: Campaign) {
    const ctx = (await this.knowledge.buildAgentContext(tenant)) as unknown as BusinessContext;
    const selected = await this.prisma.campaignProduct.findMany({ where: { campaignId: c.id, businessId: tenant.businessId }, select: { productId: true } });
    const ids = new Set(selected.map((s) => s.productId));
    const products = ctx.products.filter((p) => ids.has(p.id)) as unknown as ProductFacts[];
    if (products.length !== ids.size) throw new ConflictException({ code: 'PRODUCT_NOT_ACTIVE', message: 'A selected product is no longer active or verified. Update the campaign products.' });
    return { ctx, products };
  }

  /** Product Intelligence → Market Research → Audience → Creative → Planning, in that fixed order. Writes the plan; creates no entry. */
  async plan(tenant: TenantContext, id: string, o: { days?: number; startDate?: string; languages?: Array<'en' | 'fr'>; platforms?: string[] } = {}) {
    let c = await this.load(tenant, id);
    if (c.status !== 'DRAFT' && c.status !== 'PLANNED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${c.status} campaign cannot be re-planned` });
    if ((await this.prisma.campaignContent.count({ where: { campaignId: c.id } })) > 0) throw new ConflictException({ code: 'PLAN_LOCKED', message: 'Drafts already exist for this plan.' });
    const { products } = await this.facts(tenant, c);
    const version = c.planVersion + 1;
    const k = (a: string) => `plan:v${version}:${a}`;
    const languages = o.languages?.length ? o.languages : (['en'] as Array<'en' | 'fr'>);
    const { insights } = await this.exec(tenant, id, 'PRODUCT_INTELLIGENCE', k('pi'), { products }, (i) => productIntelligence(i.products));
    const market = await this.exec(tenant, id, 'MARKET_RESEARCH', k('mr'), {}, () => marketResearch());
    const audiences = await this.exec(tenant, id, 'AUDIENCE_STRATEGY', k('as'), { products }, (i) => audienceStrategy(i.products));
    const { ideas } = await this.exec(tenant, id, 'CREATIVE_STRATEGY', k('cs'), { products, languages }, (i) => creativeStrategy(i.products, i.languages, CAMPAIGN_LIMITS.entriesMax));
    const accounts = await this.prisma.socialAccount.findMany({ where: { businessId: tenant.businessId, status: 'CONNECTED' }, select: { platform: true } });
    const connected = [...new Set(accounts.map((a) => a.platform as string))];
    const plan = await this.exec(tenant, id, 'CAMPAIGN_PLANNING', k('cp'), { ideas: ideas.length, connected, days: o.days, startDate: o.startDate }, () =>
      campaignPlanning({ ideas, platforms: o.platforms?.length ? o.platforms : connected, connectedPlatforms: connected, startDate: o.startDate ?? day(), days: o.days ?? 14, entriesMax: CAMPAIGN_LIMITS.entriesMax }));
    const stored: StoredPlan = { ...plan, version, products: insights, market, audiences, rejected: [], languages };
    c = await this.prisma.campaign.update({ where: { id }, data: { plan: stored as unknown as Prisma.InputJsonValue, planVersion: version, status: 'PLANNED' } });
    await this.audit.record({ action: 'campaign.planned', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id, metadata: { version, entries: plan.calendar.length } });
    return this.view(tenant, c.id);
  }

  /** Turns each proposal into a DRAFT calendar entry after a fact check against verified data. Unsupported claims are rejected, not "fixed". */
  async generateContent(tenant: TenantContext, id: string) {
    const c = await this.load(tenant, id);
    if (c.status !== 'PLANNED') throw new ConflictException({ code: 'INVALID_STATE', message: `Plan the campaign first (status ${c.status})` });
    const plan = c.plan as unknown as StoredPlan | null;
    if (!plan?.calendar?.length) throw new ConflictException({ code: 'NO_PLAN', message: 'The plan has no entries' });
    const { ctx } = await this.facts(tenant, c);
    const result = await this.exec(tenant, id, 'CREATIVE_STRATEGY', `content:v${plan.version}`, { entries: plan.calendar.length }, () => plan.calendar.map((p) => ({ index: p.index, idea: p.idea })));
    plan.rejected = [];
    for (const p of plan.calendar) {
      if (p.calendarEventId || !result.some((r) => r.index === p.index)) continue;
      const out = { title: p.idea.title, caption: p.idea.caption, hashtags: p.idea.hashtags };
      const issues = [...assessGrounding(out, ctx).issues, ...checkFactPreservation(out, ctx, { type: 'PRODUCT', id: p.idea.productId })];
      if (issues.length) { plan.rejected.push({ index: p.index, code: 'UNSUPPORTED_CLAIM', detail: issues.slice(0, 5) }); continue; }
      try {
        const entry = await this.createDraft(tenant, c.id, p.idea, p.platform, p.localDate, p.localTime, 'INITIAL');
        p.calendarEventId = entry.id;
      } catch (e) {
        plan.rejected.push({ index: p.index, code: e instanceof HttpException ? String((e.getResponse() as { code?: string }).code ?? 'REJECTED') : 'REJECTED' });
      }
    }
    await this.prisma.campaign.update({ where: { id }, data: { plan: plan as unknown as Prisma.InputJsonValue } });
    if (!plan.calendar.some((p) => p.calendarEventId)) throw new ConflictException({ code: 'NO_CONTENT', message: 'No draft passed the fact check or could be scheduled.', rejected: plan.rejected });
    await this.move(c, 'CONTENT_READY');
    await this.audit.record({ action: 'campaign.content_ready', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id, metadata: { drafts: plan.calendar.filter((p) => p.calendarEventId).length, rejected: plan.rejected.length } });
    return this.view(tenant, id);
  }

  private async createDraft(tenant: TenantContext, campaignId: string, idea: ContentIdea, platform: string, localDate: string, localTime: string, kind: 'INITIAL' | 'FOLLOW_UP') {
    const dto = { title: idea.title, platform, contentType: 'TEXT', caption: idea.caption, hashtags: idea.hashtags, language: idea.language, productId: idea.productId, localDate, localTime, acknowledgeConflicts: false } as unknown as CreateEntryDto;
    const entry = await this.calendar.create(tenant, dto);
    const row = await this.prisma.calendarEvent.findFirstOrThrow({ where: { id: entry.id, businessId: tenant.businessId }, select: { contentId: true } });
    if (row.contentId) await this.prisma.content.update({ where: { id: row.contentId }, data: { origin: 'AI_GENERATED', aiMetadata: { agent: 'CREATIVE_STRATEGY', campaignId, mock: true, kind } } });
    await this.prisma.campaignContent.create({ data: { campaignId, businessId: tenant.businessId, calendarEventId: entry.id, productId: idea.productId, kind } });
    return entry;
  }

  /** Sends each draft to the N18 approval. It cannot approve or authorize: a person does that, post by post. */
  async submit(tenant: TenantContext, id: string) {
    const c = await this.load(tenant, id);
    if (c.paused) throw new ConflictException({ code: 'CAMPAIGN_PAUSED', message: 'This campaign is paused.' });
    const links = await this.prisma.campaignContent.findMany({ where: { campaignId: id, businessId: tenant.businessId }, include: { calendarEvent: { include: { content: true } } } });
    const drafts = links.filter((l) => ['DRAFT', 'REJECTED'].includes(CalendarService.status(l.calendarEvent as never)));
    if (!drafts.length) throw new ConflictException({ code: 'NOTHING_TO_SUBMIT', message: 'No draft is waiting to be submitted.' });
    let sent = 0;
    const failed: Array<{ entryId: string; code: string }> = [];
    for (const l of drafts) {
      try { await this.calendar.submit(tenant, l.calendarEventId); sent++; } catch (e) { failed.push({ entryId: l.calendarEventId, code: e instanceof HttpException ? String((e.getResponse() as { code?: string }).code ?? 'ERROR') : 'ERROR' }); }
    }
    await this.audit.record({ action: 'campaign.submitted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id, metadata: { sent, failed: failed.length } });
    const v = await this.view(tenant, id);
    return { ...v, submitted: sent, failed };
  }

  /** The campaign state is DERIVED from its posts, never the other way round. Approval states live on the calendar entries. */
  async sync(c: Campaign): Promise<Campaign> {
    if (c.status === 'CANCELLED' || c.status === 'COMPLETED' || c.status === 'DRAFT' || c.status === 'PLANNED') return c;
    const links = await this.prisma.campaignContent.findMany({ where: { campaignId: c.id }, include: { calendarEvent: { include: { content: true } } } });
    if (!links.length) return c;
    const st = links.map((l) => CalendarService.status(l.calendarEvent as never) as string);
    let next: CampaignStatusId = c.status as CampaignStatusId;
    if (st.every((s) => TERMINAL_ENTRY.has(s)) && st.includes('PUBLISHED')) next = 'COMPLETED';
    else if (st.some((s) => ['SCHEDULED', 'PUBLISHING', 'PUBLISHED'].includes(s))) next = 'ACTIVE';
    else if (st.some((s) => ['IN_REVIEW', 'APPROVED'].includes(s))) next = 'AWAITING_APPROVAL';
    else if (st.every((s) => ['DRAFT', 'REJECTED'].includes(s) || TERMINAL_ENTRY.has(s))) next = 'CONTENT_READY';
    if (next !== c.status && canMoveCampaign(c.status as CampaignStatusId, next)) return this.prisma.campaign.update({ where: { id: c.id }, data: { status: next } });
    return c;
  }

  // ─── Kill switches ──────────────────────────────────────────────────────────

  async setPaused(tenant: TenantContext, id: string, paused: boolean) {
    const c = await this.load(tenant, id);
    if (c.status === 'CANCELLED' || c.status === 'COMPLETED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${c.status} campaign cannot be ${paused ? 'paused' : 'resumed'}` });
    await this.prisma.campaign.update({ where: { id }, data: { paused } });
    await this.audit.record({ action: paused ? 'campaign.paused' : 'campaign.resumed', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id });
    return this.view(tenant, id);
  }

  /** Cancels the campaign and withdraws every post that has not been published. Published posts are untouched. */
  async cancel(tenant: TenantContext, id: string) {
    const c = await this.load(tenant, id);
    if (c.status === 'COMPLETED' || c.status === 'CANCELLED') throw new ConflictException({ code: 'INVALID_STATE', message: `A ${c.status} campaign cannot be cancelled` });
    await this.prisma.campaign.update({ where: { id }, data: { status: 'CANCELLED', paused: true } });
    const links = await this.prisma.campaignContent.findMany({ where: { campaignId: id }, include: { calendarEvent: { include: { content: true } } } });
    let cancelled = 0;
    for (const l of links) {
      if (TERMINAL_ENTRY.has(CalendarService.status(l.calendarEvent as never))) continue;
      try { await this.calendar.cancel(tenant, l.calendarEventId, 'Campaign cancelled'); cancelled++; } catch { /* already moving to a final state */ }
    }
    await this.audit.record({ action: 'campaign.cancelled', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id, metadata: { entriesCancelled: cancelled } });
    return this.view(tenant, id);
  }

  // ─── Performance feedback ───────────────────────────────────────────────────

  /** Reads the authorized metrics of this campaign's published posts (read-only), then evaluates them. Unavailable stays unavailable. */
  async evaluate(tenant: TenantContext, id: string, refresh: boolean) {
    const c = await this.load(tenant, id);
    const links = await this.prisma.campaignContent.findMany({ where: { campaignId: id, businessId: tenant.businessId }, select: { calendarEventId: true, productId: true } });
    const pubs = await this.prisma.publication.findMany({ where: { businessId: tenant.businessId, calendarEventId: { in: links.map((l) => l.calendarEventId) }, status: 'PUBLISHED' }, select: { id: true, simulated: true, calendarEventId: true } });
    if (refresh) for (const p of pubs) await this.analytics.collect(p.id).catch(() => null);
    const snaps = await this.prisma.analyticsSnapshot.findMany({ where: { businessId: tenant.businessId, publicationId: { in: pubs.map((p) => p.id) }, period: 'LIFETIME', source: 'MEASURED' } });
    const by = new Map(snaps.map((s) => [s.publicationId, s]));
    const product = new Map(links.map((l) => [l.calendarEventId, l.productId]));
    const rows: MetricRow[] = pubs.map((p) => {
      const s = by.get(p.id);
      const has = !!s && [s.reach, s.impressions, s.views, s.likes, s.comments, s.shares, s.saves, s.linkClicks].some((v) => v !== null);
      return { publicationId: p.id, productId: product.get(p.calendarEventId ?? '') ?? null, origin: !has ? 'UNAVAILABLE' : p.simulated ? 'SIMULATED' : 'REAL', engagementRate: s?.engagementRate === null || s?.engagementRate === undefined ? null : Number(s.engagementRate), reach: s?.reach ?? null, likes: s?.likes ?? null };
    });
    const report = await this.exec(tenant, id, 'PERFORMANCE_ANALYSIS', `eval:${createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)}`, { rows }, (i) => performanceAnalysis(i.rows));
    const plan = (c.plan ?? {}) as unknown as StoredPlan;
    plan.evaluation = { ...report, evaluatedAt: new Date().toISOString() };
    await this.prisma.campaign.update({ where: { id }, data: { plan: plan as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ action: 'campaign.evaluated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id, metadata: { evidence: report.evidence, ...report.counts } });
    return { ...report, rows };
  }

  /** Drafts follow-up posts suggested by the evaluation. They are ordinary drafts: each needs its own approval. */
  async followUps(tenant: TenantContext, id: string) {
    const c = await this.load(tenant, id);
    const plan = c.plan as unknown as StoredPlan | null;
    const ev = plan?.evaluation;
    if (!ev || ev.followUps.length === 0) throw new ConflictException({ code: 'NO_FOLLOW_UP', message: 'Evaluate the campaign first; no follow-up is recommended yet.' });
    const { ctx, products } = await this.facts(tenant, c);
    const created: string[] = [];
    const rejected: Array<{ productId: string; code: string }> = [];
    for (const f of ev.followUps.slice(0, 3)) {
      const p = products.filter((x) => x.id === f.productId);
      const idea = creativeStrategy(p, [(plan!.languages[0] as 'en' | 'fr') ?? 'en'], 3).ideas.find((i) => i.angle !== f.angle) ?? creativeStrategy(p, ['en'], 3).ideas[0];
      if (!idea) continue;
      const out = { title: idea.title, caption: idea.caption, hashtags: idea.hashtags };
      if ([...assessGrounding(out, ctx).issues, ...checkFactPreservation(out, ctx, { type: 'PRODUCT', id: idea.productId })].length) { rejected.push({ productId: f.productId, code: 'UNSUPPORTED_CLAIM' }); continue; }
      const platform = plan!.calendar[0]?.platform ?? 'FACEBOOK';
      try { created.push((await this.createDraft(tenant, id, idea, platform, day(new Date(Date.now() + 7 * 86_400_000)), '10:00', 'FOLLOW_UP')).id); } catch { rejected.push({ productId: f.productId, code: 'NOT_SCHEDULABLE' }); }
    }
    await this.audit.record({ action: 'campaign.follow_ups_drafted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Campaign', entityId: id, metadata: { drafts: created.length } });
    return { drafted: created, rejected };
  }

  // ─── Customer service coordination (decision only; N19 owns the sending) ────

  async triageComment(tenant: TenantContext, commentId: string) {
    const comment = await this.prisma.comment.findFirst({ where: { id: commentId, businessId: tenant.businessId } });
    if (!comment || comment.externalCommentId.startsWith('pending:') || comment.externalCommentId.startsWith('unknown:')) throw new NotFoundException({ code: 'COMMENT_NOT_FOUND', message: 'Comment not found' });
    const mode = await this.interactions.replyMode(tenant.businessId);
    const words = comment.body.toLowerCase().match(/[\p{L}]{4,}/gu) ?? [];
    const entries = await this.prisma.knowledgeEntry.findMany({ where: { businessId: tenant.businessId, verified: true, deletedAt: null }, select: { title: true, body: true }, take: 200 });
    const hay = entries.map((e) => `${e.title} ${e.body}`.toLowerCase()).join(' ');
    const matches = words.filter((w) => hay.includes(w)).length >= 2 ? 1 : 0;
    const t = customerServiceTriage({ text: comment.body, mode, knowledgeMatches: matches, isOwnComment: comment.isFromBusiness });
    const replied = await this.prisma.comment.count({ where: { businessId: tenant.businessId, parentId: comment.id } });
    await this.audit.record({ action: 'campaign.comment_triaged', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Comment', entityId: comment.id, metadata: { mode, action: t.action } });
    // Duplicate prevention: a comment that already has a reply is never offered for another automatic one.
    return { ...t, mode, autoSendAllowed: t.autoSendAllowed && replied === 0, alreadyReplied: replied > 0, note: 'This is a decision only. Replies are sent by the N19 comment service, which checks the merchant mode again.' };
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async view(tenant: TenantContext, id: string) {
    let c = await this.load(tenant, id);
    c = await this.sync(c);
    const [products, links, execs] = await Promise.all([
      this.prisma.campaignProduct.findMany({ where: { campaignId: id }, include: { product: { select: { id: true, name: true } } } }),
      this.prisma.campaignContent.findMany({ where: { campaignId: id }, include: { calendarEvent: { include: { content: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.agentExecution.findMany({ where: { campaignId: id, businessId: tenant.businessId }, orderBy: { createdAt: 'asc' }, select: { id: true, agent: true, status: true, attempts: true, errorCode: true, costMicros: true, durationMs: true, createdAt: true } }),
    ]);
    return {
      id: c.id, name: c.name, goal: c.goal, status: c.status, paused: c.paused,
      budget: { executionLimit: c.executionLimit, executionsUsed: c.executionsUsed, costLimitMicros: c.costLimitMicros, costUsedMicros: c.costUsedMicros },
      products: products.map((p) => p.product), plan: c.plan, planVersion: c.planVersion,
      entries: links.map((l) => ({ id: l.calendarEventId, kind: l.kind, title: l.calendarEvent.title, platform: l.calendarEvent.platform, scheduledAt: l.calendarEvent.scheduledAt, approvalStatus: CalendarService.status(l.calendarEvent as never) })),
      executions: execs, createdAt: c.createdAt,
    };
  }

  async list(tenant: TenantContext, q: { page: number; pageSize: number }) {
    const where = { businessId: tenant.businessId };
    const [total, rows] = await Promise.all([this.prisma.campaign.count({ where }), this.prisma.campaign.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const items = await Promise.all(rows.map(async (r) => { const c = await this.sync(r); return { id: c.id, name: c.name, status: c.status, paused: c.paused, createdAt: c.createdAt }; }));
    return { total, page: q.page, pageSize: q.pageSize, items };
  }
}
