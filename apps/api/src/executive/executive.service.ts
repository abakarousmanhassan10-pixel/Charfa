import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { EXECUTIVE_AGENTS, EXECUTIVE_CONTRACTS, type ExecutiveAgentId } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { RecommendationsService } from '../intelligence/recommendations.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { analyzeQuestions, K_ANONYMITY, type CustomerIntel } from './customer-intel';
import { breakEvenPrice, compare, sellingPrice, unitEconomics, type EconomicsInput, type ScenarioInput } from './finance';

const day0 = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
const DAY = 86_400_000;
const MAX_RUNS_LIMIT = 50;

export interface ProductFinance {
  productId: string; name: string; currency: string; priceUsed: string | null; priceKind: 'PROMOTIONAL' | 'LIST' | 'MISSING';
  status: 'COMPLETE' | 'INCOMPLETE';
  /** Names of the inputs that were not supplied. Nothing is estimated in their place. */
  missing: string[];
  contributionBeforeAds: string | null; marginPercentBeforeAds: string | null; breakEvenAdCost: string | null; breakEvenPrice: string | null;
}
type Section = { status: 'VERIFIED' | 'PARTIAL' | 'MISSING' | 'SIMULATED' | 'UNAVAILABLE'; detail: Record<string, unknown>; note: string };

const dec = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? null : v.toFixed(2));

/**
 * Phase N22: the executive orchestrator and business decision support. It reads authorized data, computes with deterministic
 * functions, and PROPOSES. It cannot change a price, issue a refund, charge a payment, spend on advertising, publish or message a
 * customer; the only automatic consequence of an approved decision is a campaign DRAFT, which still needs per-post approval.
 */
@Injectable()
export class ExecutiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly intelligence: IntelligenceService,
    private readonly recs: RecommendationsService,
  ) {}

  /** Test hook: makes the next run of an agent take this long or fail. */
  readonly faults = new Map<ExecutiveAgentId, { delayMs?: number; fail?: boolean }>();

  // ─── Safety controls ────────────────────────────────────────────────────────

  async settings(tenant: Pick<TenantContext, 'businessId'>) {
    const s = await this.prisma.executiveSettings.findUnique({ where: { businessId: tenant.businessId } });
    return { paused: s?.paused ?? false, dailyRunLimit: s?.dailyRunLimit ?? 10 };
  }

  async updateSettings(tenant: TenantContext, i: { paused?: boolean; dailyRunLimit?: number }) {
    if (i.dailyRunLimit !== undefined && (!Number.isInteger(i.dailyRunLimit) || i.dailyRunLimit < 1 || i.dailyRunLimit > MAX_RUNS_LIMIT)) throw new BadRequestException({ code: 'INVALID_LIMIT', message: `dailyRunLimit must be 1 to ${MAX_RUNS_LIMIT}` });
    const data = { ...(i.paused !== undefined ? { paused: i.paused } : {}), ...(i.dailyRunLimit !== undefined ? { dailyRunLimit: i.dailyRunLimit } : {}), updatedById: tenant.userId };
    await this.prisma.executiveSettings.upsert({ where: { businessId: tenant.businessId }, create: { businessId: tenant.businessId, ...data }, update: data });
    await this.audit.record({ action: i.paused === undefined ? 'executive.limit_changed' : i.paused ? 'executive.emergency_stop' : 'executive.emergency_stop_released', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'ExecutiveSettings', entityId: tenant.businessId, metadata: { ...i } });
    return this.settings(tenant);
  }

  // ─── Merchant-entered finance inputs ────────────────────────────────────────

  async putEconomics(tenant: TenantContext, productId: string, i: { currency: string; unitCost?: string | null; shippingCost?: string | null; paymentFeePercent?: string | null; paymentFixedFee?: string | null; returnsAllowancePercent?: string | null }) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, businessId: tenant.businessId, deletedAt: null }, select: { id: true } });
    if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    const data = {
      currency: i.currency, unitCost: i.unitCost ?? null, shippingCost: i.shippingCost ?? null, paymentFeePercent: i.paymentFeePercent ?? null,
      paymentFixedFee: i.paymentFixedFee ?? null, returnsAllowancePercent: i.returnsAllowancePercent ?? null, updatedById: tenant.userId,
    };
    await this.prisma.productEconomics.upsert({ where: { businessId_productId: { businessId: tenant.businessId, productId } }, create: { businessId: tenant.businessId, productId, ...data }, update: data });
    await this.audit.record({ action: 'executive.economics_saved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Product', entityId: productId });
    return (await this.financeReport(tenant)).products.find((x) => x.productId === productId);
  }

  async addExpense(tenant: TenantContext, i: { amount: string; currency: string; spentOn: string; orders?: number; note?: string; campaignId?: string }) {
    if (i.campaignId) {
      const c = await this.prisma.campaign.findFirst({ where: { id: i.campaignId, businessId: tenant.businessId }, select: { id: true } });
      if (!c) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' });
    }
    const e = await this.prisma.marketingExpense.create({ data: { businessId: tenant.businessId, amount: i.amount, currency: i.currency, spentOn: new Date(i.spentOn), orders: i.orders ?? null, note: i.note?.slice(0, 200) ?? null, campaignId: i.campaignId ?? null, createdById: tenant.userId } });
    await this.audit.record({ action: 'executive.expense_recorded', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MarketingExpense', entityId: e.id });
    return { id: e.id, amount: e.amount.toFixed(2), currency: e.currency, spentOn: e.spentOn, orders: e.orders };
  }

  async listExpenses(tenant: TenantContext) {
    const rows = await this.prisma.marketingExpense.findMany({ where: { businessId: tenant.businessId }, orderBy: { spentOn: 'desc' }, take: 100 });
    return { items: rows.map((e) => ({ id: e.id, amount: e.amount.toFixed(2), currency: e.currency, spentOn: e.spentOn, orders: e.orders, note: e.note, campaignId: e.campaignId })) };
  }

  async deleteExpense(tenant: TenantContext, id: string) {
    const r = await this.prisma.marketingExpense.deleteMany({ where: { id, businessId: tenant.businessId } });
    if (!r.count) throw new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Expense not found' });
    await this.audit.record({ action: 'executive.expense_deleted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MarketingExpense', entityId: id });
    return { deleted: 1 };
  }

  // ─── Profit intelligence ────────────────────────────────────────────────────

  private async financeRows(businessId: string) {
    const products = await this.prisma.product.findMany({ where: { businessId, deletedAt: null, status: 'ACTIVE' }, include: { economics: { where: { businessId } } }, orderBy: { name: 'asc' }, take: 200 });
    return products.map((p) => {
      const e = p.economics[0];
      const econ: EconomicsInput | null = e ? { currency: e.currency, unitCost: dec(e.unitCost), shippingCost: dec(e.shippingCost), paymentFeePercent: dec(e.paymentFeePercent), paymentFixedFee: dec(e.paymentFixedFee), returnsAllowancePercent: dec(e.returnsAllowancePercent) } : null;
      const price = { price: dec(p.price), discountPrice: dec(p.discountPrice), currency: p.currency ?? e?.currency ?? 'XAF' };
      return { p, econ, price };
    });
  }

  async financeReport(tenant: Pick<TenantContext, 'businessId'>) {
    const rows = await this.financeRows(tenant.businessId);
    const products: ProductFinance[] = rows.map(({ p, econ, price }) => {
      const u = unitEconomics(price, econ);
      const missing = u.missing.filter((m) => m !== 'advertising cost per acquisition');
      const used = sellingPrice(price);
      return {
        productId: p.id, name: p.name, currency: price.currency, priceUsed: used, priceKind: used === null ? 'MISSING' : price.discountPrice ? 'PROMOTIONAL' : 'LIST',
        status: missing.length ? 'INCOMPLETE' : 'COMPLETE', missing,
        contributionBeforeAds: u.contributionBeforeAds.amount, breakEvenAdCost: u.breakEvenAdCost.amount, breakEvenPrice: breakEvenPrice(econ),
        marginPercentBeforeAds: u.contributionBeforeAds.amount && u.revenue.amount && Number(u.revenue.amount) > 0 ? ((Number(u.contributionBeforeAds.amount) / Number(u.revenue.amount)) * 100).toFixed(2) : null,
      };
    });
    const complete = products.filter((x) => x.status === 'COMPLETE');
    return {
      products,
      summary: { products: products.length, complete: complete.length, incomplete: products.length - complete.length, losingMoney: complete.filter((x) => Number(x.contributionBeforeAds) < 0).length },
      note: 'Per-order figures before advertising, from costs the merchant entered. A product with a missing input shows no contribution at all: nothing is estimated.',
    };
  }

  /** Compares scenarios for one product. A simulation only: nothing is spent, repriced or sent. */
  async scenarios(tenant: TenantContext, productId: string, scenarios: ScenarioInput[]) {
    const row = (await this.financeRows(tenant.businessId)).find((r) => r.p.id === productId);
    if (!row) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    const result = compare(row.price, row.econ, scenarios);
    await this.audit.record({ action: 'executive.scenarios_compared', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Product', entityId: productId, metadata: { scenarios: scenarios.length } });
    return { productId, ...result };
  }

  // ─── Customer intelligence (minimized) ──────────────────────────────────────

  async customerIntelligence(tenant: Pick<TenantContext, 'businessId'>): Promise<CustomerIntel> {
    const b = tenant.businessId;
    const since = new Date(Date.now() - 90 * DAY);
    const inbound = await this.prisma.comment.findMany({ where: { businessId: b, isFromBusiness: false, createdAt: { gte: since }, NOT: { externalCommentId: { startsWith: 'pending:' } } }, select: { id: true, body: true, createdAt: true }, take: 2000 });
    const repliedTo = new Set((await this.prisma.comment.findMany({ where: { businessId: b, parentId: { in: inbound.map((c) => c.id) } }, select: { parentId: true } })).map((r) => r.parentId));
    const knowledge = await this.prisma.knowledgeEntry.findMany({ where: { businessId: b, verified: true, deletedAt: null }, select: { title: true, body: true }, take: 500 });
    const now = Date.now();
    return analyzeQuestions(inbound.map((c) => ({ text: c.body, answered: repliedTo.has(c.id), ageHours: (now - c.createdAt.getTime()) / 3_600_000 })), knowledge.map((k) => `${k.title} ${k.body}`).join(' '));
  }

  // ─── Diagnosis ──────────────────────────────────────────────────────────────

  async diagnosis(tenant: TenantContext) {
    const b = tenant.businessId;
    const fin = await this.financeReport(tenant);
    const since = new Date(Date.now() - 30 * DAY);
    const [expenses, campaigns, pubsReal, pubsSim, inbound] = await Promise.all([
      this.prisma.marketingExpense.findMany({ where: { businessId: b, spentOn: { gte: since } }, select: { amount: true, orders: true, currency: true } }),
      this.prisma.campaign.groupBy({ by: ['status'], where: { businessId: b }, _count: { _all: true } }),
      this.prisma.publication.count({ where: { businessId: b, status: 'PUBLISHED', simulated: false } }),
      this.prisma.publication.count({ where: { businessId: b, status: 'PUBLISHED', simulated: true } }),
      this.prisma.comment.count({ where: { businessId: b, isFromBusiness: false } }),
    ]);
    const priced = fin.products.filter((p) => p.priceKind !== 'MISSING').length;
    const sections: Record<string, Section> = {
      catalog: { status: fin.summary.products ? 'VERIFIED' : 'MISSING', detail: { activeProducts: fin.summary.products }, note: 'Active products in the catalog.' },
      prices: { status: !fin.summary.products ? 'MISSING' : priced === fin.summary.products ? 'VERIFIED' : 'PARTIAL', detail: { priced, of: fin.summary.products }, note: 'Selling prices entered in the catalog.' },
      productAndShippingCosts: { status: !fin.summary.products ? 'MISSING' : fin.summary.complete === fin.summary.products ? 'VERIFIED' : fin.summary.complete > 0 ? 'PARTIAL' : 'MISSING', detail: { complete: fin.summary.complete, of: fin.summary.products }, note: 'Costs entered by the merchant. TOUMA does not know them otherwise.' },
      marketingExpenses: { status: expenses.length ? 'VERIFIED' : 'MISSING', detail: { entriesLast30Days: expenses.length, withOrders: expenses.filter((e) => e.orders !== null).length }, note: 'Expenses recorded by hand. TOUMA does not read advertising accounts.' },
      campaignMetrics: { status: pubsReal > 0 ? 'VERIFIED' : pubsSim > 0 ? 'SIMULATED' : 'MISSING', detail: { publishedReal: pubsReal, publishedSimulated: pubsSim, campaignsByStatus: Object.fromEntries(campaigns.map((c) => [c.status, c._count._all])) }, note: 'Real means a platform returned it; simulated comes from the test simulator.' },
      customerQuestions: { status: inbound ? 'VERIFIED' : 'MISSING', detail: { inbound }, note: 'Comments on your own posts. Direct messages are not read.' },
      salesData: { status: 'MISSING', detail: {}, note: 'TOUMA does not collect orders or revenue. Profitability is per order, from entered costs. Scenario volumes are assumptions, never actuals.' },
      marketData: { status: 'UNAVAILABLE', detail: {}, note: 'No verified market data in this workspace; nothing is estimated.' },
    };
    const known = Object.values(sections).filter((s) => s.status === 'VERIFIED').length;
    return { sections, health: { dataCoveragePercent: Math.round((known / Object.keys(sections).length) * 100), verifiedSections: known, totalSections: Object.keys(sections).length, note: 'Share of the data areas above that hold verified data. It measures how much TOUMA can analyze, not how well the business performs.' }, finance: fin.summary };
  }

  // ─── Orchestrator ───────────────────────────────────────────────────────────

  async run(tenant: TenantContext, idempotencyKey?: string) {
    const b = tenant.businessId;
    const st = await this.settings(tenant);
    if (st.paused) throw new ConflictException({ code: 'EXECUTIVE_PAUSED', message: 'The emergency stop is on: no executive run starts until it is released.' });
    const key = (idempotencyKey ?? `daily:${new Date().toISOString().slice(0, 10)}`).slice(0, 120);
    const prior = await this.prisma.executiveRun.findUnique({ where: { businessId_idempotencyKey: { businessId: b, idempotencyKey: key } } });
    if (prior) return this.runDto(prior);
    const today = await this.prisma.executiveRun.count({ where: { businessId: b, createdAt: { gte: day0() } } });
    if (today >= st.dailyRunLimit) throw new HttpException({ code: 'RUN_LIMIT', message: `The daily limit of ${st.dailyRunLimit} executive runs is reached. Nothing was run.` }, HttpStatus.TOO_MANY_REQUESTS);

    const started = Date.now();
    const out: Record<string, unknown> = {};
    const steps: Array<{ agent: ExecutiveAgentId; status: 'OK' | 'FAILED' | 'TIMED_OUT'; durationMs: number; error?: string }> = [];
    const agents: Record<ExecutiveAgentId, () => Promise<unknown>> = {
      MARKETING: async () => (await this.diagnosis(tenant)).sections.campaignMetrics,
      SALES: async () => ({ status: 'MISSING', note: 'TOUMA does not collect orders or revenue.' }),
      MARKET_ANALYST: async () => ({ status: 'UNAVAILABLE', note: 'No verified market data; nothing is estimated.' }),
      FINANCE_ANALYST: async () => this.financeReport(tenant),
      CUSTOMER_INTELLIGENCE: async () => this.customerIntelligence(tenant),
      OPTIMIZATION: async () => this.decide(tenant, out),
    };
    for (const id of EXECUTIVE_AGENTS) {
      const c = EXECUTIVE_CONTRACTS[id];
      const t0 = Date.now();
      const fault = this.faults.get(id);
      if (fault) this.faults.delete(id);
      let timer: NodeJS.Timeout | undefined;
      try {
        const work = (async () => { if (fault?.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs)); if (fault?.fail) throw new Error('simulated failure'); return agents[id](); })();
        out[id] = await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), c.timeoutMs); })]);
        steps.push({ agent: id, status: 'OK', durationMs: Date.now() - t0 });
      } catch (e) {
        const timedOut = e instanceof Error && e.message === 'TIMEOUT';
        steps.push({ agent: id, status: timedOut ? 'TIMED_OUT' : 'FAILED', durationMs: Date.now() - t0, error: timedOut ? 'AGENT_TIMEOUT' : 'AGENT_FAILED' });
      } finally { if (timer) clearTimeout(timer); }
    }
    const failed = steps.filter((s) => s.status !== 'OK').length;
    const summary = { decisionsCreated: (out.OPTIMIZATION as { created?: number } | undefined)?.created ?? 0, finance: (out.FINANCE_ANALYST as { summary?: unknown } | undefined)?.summary ?? null, tokensUsed: 0, costMicros: 0 };
    try {
      const run = await this.prisma.executiveRun.create({ data: { businessId: b, idempotencyKey: key, status: failed === 0 ? 'COMPLETED' : failed === steps.length ? 'FAILED' : 'PARTIAL', steps: steps as unknown as Prisma.InputJsonValue, summary: summary as unknown as Prisma.InputJsonValue, durationMs: Date.now() - started, createdById: tenant.userId } });
      await this.audit.record({ action: 'executive.run', actorId: tenant.userId, businessId: b, entityType: 'ExecutiveRun', entityId: run.id, metadata: { status: run.status, failedAgents: failed, decisions: summary.decisionsCreated } });
      return this.runDto(run);
    } catch (e) {
      // A concurrent run with the same key stored its result first: return that one.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.executiveRun.findUnique({ where: { businessId_idempotencyKey: { businessId: b, idempotencyKey: key } } });
        if (won) return this.runDto(won);
      }
      throw e;
    }
  }

  private runDto(r: { id: string; idempotencyKey: string; status: string; steps: unknown; summary: unknown; durationMs: number; createdAt: Date }) {
    return { id: r.id, key: r.idempotencyKey, status: r.status, steps: r.steps, summary: r.summary, durationMs: r.durationMs, createdAt: r.createdAt };
  }

  // ─── Decision engine ────────────────────────────────────────────────────────

  /** Optimization agent: turns the findings into proposals. Each has a problem, evidence, action, an estimate or "not estimated", confidence, cost, risk and required approval. */
  private async decide(tenant: TenantContext, found: Record<string, unknown>) {
    const b = tenant.businessId;
    const fin = (found.FINANCE_ANALYST as Awaited<ReturnType<ExecutiveService['financeReport']>> | undefined) ?? null;
    const intel = (found.CUSTOMER_INTELLIGENCE as CustomerIntel | undefined) ?? null;
    let created = 0;
    const make = async (d: Parameters<RecommendationsService['createDecision']>[1]) => {
      try { await this.recs.createDecision(b, d); created++; } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; }
    };
    const NOT = (reason: string) => ({ type: 'NOT_ESTIMATED' as const, reason });
    if (fin) {
      for (const p of fin.products) {
        if (p.status === 'INCOMPLETE') {
          await make({ kind: 'ECONOMICS_GAP', title: `Enter the costs of "${p.name}"`, problem: `The profitability of "${p.name}" cannot be computed: ${p.missing.join(', ')} not entered.`, evidence: { productId: p.productId, missing: p.missing }, proposedAction: { type: 'ENTER_COSTS', productId: p.productId }, expectedBenefit: NOT('Entering costs does not change sales. It makes the margin computable.'), confidence: 'HIGH', reviewMinutes: 3, risk: 'None: nothing is changed automatically.', priority: 80, dedupeKey: `econ:${p.productId}` });
        } else if (Number(p.contributionBeforeAds) < 0) {
          await make({ kind: 'NEGATIVE_MARGIN_REVIEW', title: `Review the price or costs of "${p.name}"`, problem: `Each order of "${p.name}" loses ${Math.abs(Number(p.contributionBeforeAds)).toFixed(2)} ${p.currency} before advertising.`, evidence: { productId: p.productId, contributionBeforeAds: p.contributionBeforeAds, currentPrice: p.priceUsed, breakEvenPrice: p.breakEvenPrice, currency: p.currency }, proposedAction: { type: 'REVIEW_PRICE_OR_COSTS', breakEvenPrice: p.breakEvenPrice }, expectedBenefit: { type: 'ESTIMATE', text: `At ${p.breakEvenPrice} ${p.currency} an order would contribute 0 before advertising (estimate).`, assumptions: ['The costs you entered are accurate.', 'Order volume stays the same: demand at a higher price is not modeled.'] }, confidence: 'MEDIUM', reviewMinutes: 5, risk: 'A higher price can reduce orders. TOUMA never changes a price: you decide.', priority: 95, dedupeKey: `negmargin:${p.productId}` });
        }
      }
      const withCampaign = new Set((await this.prisma.campaignProduct.findMany({ where: { businessId: b }, select: { productId: true } })).map((c) => c.productId));
      const candidates = fin.products.filter((p) => p.status === 'COMPLETE' && Number(p.contributionBeforeAds) > 0 && !withCampaign.has(p.productId)).slice(0, 3);
      for (const p of candidates) {
        await make({ kind: 'CAMPAIGN_PROPOSAL', title: `Campaign for "${p.name}"`, problem: `"${p.name}" earns a positive contribution (${p.contributionBeforeAds} ${p.currency} per order before advertising) but has no campaign.`, evidence: { productId: p.productId, contributionBeforeAds: p.contributionBeforeAds, currency: p.currency }, proposedAction: { type: 'CREATE_CAMPAIGN_DRAFT', productIds: [p.productId], name: `Campaign: ${p.name}` }, expectedBenefit: NOT('Organic reach and sales cannot be predicted from the data TOUMA has.'), confidence: 'LOW', reviewMinutes: 6, risk: 'None until you approve each post individually. Approving only creates a draft.', priority: 60, dedupeKey: `campaign:${p.productId}` });
      }
      // Advertising cost per order (merchant-entered spend and attributed orders) against what the products can afford.
      const since = new Date(Date.now() - 30 * DAY);
      const exp = await this.prisma.marketingExpense.findMany({ where: { businessId: b, spentOn: { gte: since }, orders: { gt: 0 } }, select: { amount: true, orders: true, currency: true } });
      const affordable = fin.products.filter((p) => p.status === 'COMPLETE' && p.breakEvenAdCost !== null && Number(p.breakEvenAdCost) > 0);
      if (exp.length && affordable.length) {
        const currency = exp[0]!.currency;
        const spend = exp.filter((e) => e.currency === currency).reduce((s, e) => s + Number(e.amount), 0);
        const orders = exp.filter((e) => e.currency === currency).reduce((s, e) => s + (e.orders ?? 0), 0);
        const comparable = affordable.filter((p) => p.currency === currency);
        if (orders > 0 && comparable.length) {
          const cac = spend / orders;
          const maxAfford = comparable.reduce((s, p) => s + Number(p.breakEvenAdCost), 0) / comparable.length;
          if (cac > maxAfford) await make({ kind: 'AD_COST_REVIEW', title: 'Review your advertising cost per order', problem: `Advertising cost ${cac.toFixed(2)} ${currency} per order, above the ${maxAfford.toFixed(2)} ${currency} the products can afford before losing money.`, evidence: { spend: spend.toFixed(2), orders, costPerOrder: cac.toFixed(2), averageBreakEvenAdCost: maxAfford.toFixed(2), currency, window: '30 days', note: 'Spend and orders were entered by the merchant.' }, proposedAction: { type: 'REVIEW_AD_SPEND' }, expectedBenefit: { type: 'ESTIMATE', text: `Bringing the cost per order down to ${maxAfford.toFixed(2)} ${currency} would stop each order losing money to advertising (estimate).`, assumptions: ['Spend and attributed orders are accurate.', 'Attribution is the merchant\'s own count; TOUMA cannot verify it.'] }, confidence: orders >= 10 ? 'MEDIUM' : 'LOW', reviewMinutes: 10, risk: 'TOUMA never changes advertising spend: you decide where and how much to spend.', priority: 85, dedupeKey: `adcost:${new Date().toISOString().slice(0, 7)}` });
        }
      }
    }
    if (intel) {
      for (const m of intel.missingInformation) {
        await make({ kind: 'CUSTOMER_INFO_GAP', title: `Customers ask about ${m.topic.toLowerCase().replace('_', ' ')}`, problem: `${m.count} customer questions concern ${m.topic.toLowerCase().replace('_', ' ')}, but no verified knowledge covers it.`, evidence: { topic: m.topic, questions: m.count, privacy: `Only themes asked at least ${K_ANONYMITY} times are shown; no message text is stored here.` }, proposedAction: { type: 'ADD_KNOWLEDGE', topic: m.topic }, expectedBenefit: NOT('Fewer unanswered questions is plausible but cannot be quantified from this data.'), confidence: 'MEDIUM', reviewMinutes: 5, risk: 'None: nothing is sent to customers.', priority: 70, dedupeKey: `info:${m.topic}` });
      }
    }
    return { created };
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async decisions(tenant: TenantContext, status?: string) { return this.recs.list(tenant, status, 'EXECUTIVE'); }
  approve(tenant: TenantContext, id: string) { return this.recs.approve(tenant, id, 'EXECUTIVE'); }
  reject(tenant: TenantContext, id: string) { return this.recs.reject(tenant, id, 'EXECUTIVE'); }

  async runs(tenant: TenantContext) {
    const rows = await this.prisma.executiveRun.findMany({ where: { businessId: tenant.businessId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return { items: rows.map((r) => this.runDto(r)) };
  }

  /** The merchant command center in one call. Simulated and real data are labelled apart. */
  async overview(tenant: TenantContext) {
    const [settings, diagnosis, finance, decisions, latest, ops, alerts] = await Promise.all([
      this.settings(tenant), this.diagnosis(tenant), this.financeReport(tenant), this.recs.list(tenant, 'PROPOSED', 'EXECUTIVE'),
      this.prisma.executiveRun.findFirst({ where: { businessId: tenant.businessId }, orderBy: { createdAt: 'desc' } }),
      this.intelligence.overview(tenant), this.intelligence.listAlerts(tenant),
    ]);
    return {
      settings, health: diagnosis.health, sections: diagnosis.sections, finance,
      decisions: decisions.items.slice(0, 8), latestRun: latest ? this.runDto(latest) : null,
      campaigns: ops.campaigns, pendingApprovals: ops.pendingApprovals, agentActivity: ops.agentActivity,
      alerts: alerts.items.slice(0, 8).map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, title: a.title })),
      simulatedPlatforms: ops.simulatedPlatforms, metricsOrigin: ops.metricsOrigin, cost: ops.cost, quotas: ops.quotas,
    };
  }
}
