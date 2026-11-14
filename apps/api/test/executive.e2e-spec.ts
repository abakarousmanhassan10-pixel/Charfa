import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ExecutiveService } from '../src/executive/executive.service';
import { RecommendationsService } from '../src/intelligence/recommendations.service';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * Phase N22: business decision support. Real PostgreSQL, Redis, guards and services; deterministic agents; simulated platforms.
 * Nothing is sent to a real platform, customer, payment processor or advertising network.
 */
describe('Business autopilot (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let exec: ExecutiveService;
  let recs: RecommendationsService;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = socialHelpers(app);
    exec = app.get(ExecutiveService);
    recs = app.get(RecommendationsService);
  });
  beforeEach(() => h.hub.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function shop(connect = true) {
    const owner = await h.tenant(`Auto ${++n}`);
    const admin = await h.member(owner, 'ADMIN');
    const editor = await h.member(owner, 'EDITOR');
    const viewer = await h.member(owner, 'VIEWER');
    const account = connect ? await h.connect(owner, 'FACEBOOK') : null;
    return { owner, admin, editor, viewer, account, productId: owner.productId };
  }
  type S = Awaited<ReturnType<typeof shop>>;
  const call = (c: Ctx, method: 'get' | 'post' | 'put' | 'delete', path: string, body: Record<string, unknown> = {}, key?: string) => {
    const r = request(h.http)[method](`/api/v1/executive${path}`).set(as(c));
    if (key) r.set('Idempotency-Key', key);
    return method === 'get' ? r : r.send(body);
  };
  const code = (r: request.Response) => r.body.code ?? r.body.error?.code;
  const ECON = { currency: 'XAF', unitCost: '600', shippingCost: '200', paymentFeePercent: '2.5', paymentFixedFee: '0', returnsAllowancePercent: '5' };
  const econ = (s: S, over: Record<string, unknown> = {}, pid = s.productId) => call(s.admin, 'put', `/economics/${pid}`, { ...ECON, ...over });
  const finance = async (s: S) => (await call(s.admin, 'get', '/finance').expect(200)).body;
  const decisions = async (s: S, status = 'PROPOSED') => (await call(s.admin, 'get', `/decisions?status=${status}`).expect(200)).body.items as Array<{ id: string; kind: string; problem: string; evidence: Record<string, unknown>; proposedAction: Record<string, unknown>; expectedBenefit: { type: string }; confidence: string; risk: string; requiredApproval: string; status: string }>;
  const run = (s: S, key?: string) => call(s.admin, 'post', '/run', {}, key);

  it('profit intelligence: exact contribution and break-even from entered costs, per order, before advertising', async () => {
    const s = await shop();
    const r = (await econ(s).expect(200)).body;
    expect(r).toMatchObject({ status: 'COMPLETE', contributionBeforeAds: '587.50', breakEvenAdCost: '587.50', breakEvenPrice: '864.87', priceKind: 'LIST' }); // 1500 - 600 - 200 - 37.50 - 75
    expect(Number(r.marginPercentBeforeAds)).toBeCloseTo(39.17, 2);
    expect((await finance(s)).summary).toMatchObject({ products: 1, complete: 1, incomplete: 0, losingMoney: 0 });
  });

  it('missing costs stay missing: no contribution, no guess, and a decision asks for the data', async () => {
    const s = await shop();
    const f = (await finance(s)).products[0];
    expect(f).toMatchObject({ status: 'INCOMPLETE', contributionBeforeAds: null, breakEvenPrice: null });
    expect(f.missing).toEqual(expect.arrayContaining(['unit cost', 'shipping cost']));
    const partial = (await econ(s, { unitCost: null }).expect(200)).body;
    expect(partial).toMatchObject({ status: 'INCOMPLETE', contributionBeforeAds: null });
    await run(s).expect(200);
    const d = (await decisions(s)).find((x) => x.kind === 'ECONOMICS_GAP')!;
    expect(d).toMatchObject({ requiredApproval: 'MERCHANT', confidence: 'HIGH' });
    expect(d.expectedBenefit.type).toBe('NOT_ESTIMATED');
    expect(JSON.stringify(d)).not.toMatch(/\b\d+\.\d\d\b/); // no invented figure
  });

  it('negative margin: a price review is proposed, and approving it changes nothing', async () => {
    const s = await shop();
    await econ(s, { unitCost: '1400', shippingCost: '300' }).expect(200); // 1500 - 1400 - 300 - 37.50 - 75 = -312.50
    expect((await finance(s)).summary.losingMoney).toBe(1);
    await run(s).expect(200);
    const d = (await decisions(s)).find((x) => x.kind === 'NEGATIVE_MARGIN_REVIEW')!;
    expect(d.problem).toMatch(/loses 312\.50/);
    expect(d.evidence).toMatchObject({ contributionBeforeAds: '-312.50', breakEvenPrice: '1837.84' });
    expect(d.expectedBenefit.type).toBe('ESTIMATE');
    expect(d.risk).toMatch(/never changes a price/);
    const before = await prisma.product.findUniqueOrThrow({ where: { id: s.productId } });
    const ok = (await call(s.admin, 'post', `/decisions/${d.id}/approve`).expect(200)).body;
    expect(ok.action).toBeNull(); // recorded as the merchant's decision: nothing is executed
    const after = await prisma.product.findUniqueOrThrow({ where: { id: s.productId } });
    expect(after.price?.toString()).toBe(before.price?.toString());
    expect(after.discountPrice).toEqual(before.discountPrice);
    expect(await prisma.campaign.count({ where: { businessId: s.owner.businessId } })).toBe(0);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('scenario simulator: deterministic, assumptions explicit, negative outcomes flagged, nothing guessed or spent', async () => {
    const s = await shop();
    await econ(s).expect(200);
    const sc = (scenarios: Array<Record<string, unknown>>) => call(s.admin, 'post', '/scenarios', { productId: s.productId, scenarios });
    const ads = { adBudget: '100000', costPerClick: '50', conversionPercent: '2' };
    const r = (await sc([{ name: 'base', ...ads }, { name: 'price 1200', price: '1200', ...ads }, { name: 'bad price', price: '800', ...ads }]).expect(200)).body;
    const base = r.results[0];
    expect(base.ads).toMatchObject({ clicks: '2000', orders: '40', costPerOrder: '2500.00' });
    expect(base.netProfit).toBe('-76500.00'); // 40 x 587.50 - 100000: the advertising loses money at these assumptions
    expect(base.flags).toContain('NEGATIVE_NET_PROFIT');
    expect(base.assumptions.find((a: { name: string }) => a.name === 'conversionPercent').kind).toBe('SCENARIO_ASSUMPTION');
    expect(r.results[2].flags).toContain('NEGATIVE_UNIT_MARGIN');
    expect(r.note).toMatch(/not forecasts or guarantees/);
    expect((await sc([{ name: 'again', ...ads }]).expect(200)).body.results[0].netProfit).toBe(base.netProfit); // deterministic
    const noConv = (await sc([{ name: 'x', adBudget: '1000', costPerClick: '50' }]).expect(200)).body.results[0];
    expect(noConv.netProfit).toBeNull();
    expect(noConv.missing).toContain('conversion rate (scenario assumption)');
    expect((await sc([{ name: 'x', price: '-5' }])).status).toBe(400);
    expect(await prisma.marketingExpense.count({ where: { businessId: s.owner.businessId } })).toBe(0); // a simulation spends nothing
  });

  it('roles: finance data needs an administrator; entering it too; decisions need the merchant', async () => {
    const s = await shop();
    for (const c of [s.viewer, s.editor]) {
      expect((await call(c, 'get', '/finance')).status).toBe(403);
      expect((await call(c, 'get', '/overview')).status).toBe(403);
      expect((await call(c, 'post', '/run')).status).toBe(403);
      expect((await call(c, 'put', `/economics/${s.productId}`, ECON)).status).toBe(403);
      expect((await call(c, 'put', '/settings', { paused: true })).status).toBe(403);
    }
    await econ(s, { unitCost: null }).expect(200);
    await run(s).expect(200);
    const d = (await decisions(s))[0]!;
    expect((await call(s.editor, 'post', `/decisions/${d.id}/approve`)).status).toBe(403);
    expect((await call(s.viewer, 'post', `/decisions/${d.id}/reject`)).status).toBe(403);
    // An executive decision can only be decided through the executive endpoints.
    const viaIntel = await request(h.http).post(`/api/v1/intelligence/recommendations/${d.id}/approve`).set(as(s.admin));
    expect(viaIntel.status).toBe(404);
    expect((await request(h.http).get('/api/v1/intelligence/recommendations').set(as(s.viewer)).expect(200)).body.items.some((r: { id: string }) => r.id === d.id)).toBe(false);
    await call(s.admin, 'post', `/decisions/${d.id}/approve`).expect(200);
    expect((await call(s.admin, 'post', `/decisions/${d.id}/approve`)).status).toBe(409);
  });

  it('isolation: another business sees none of the finance, decisions, expenses or customer data and cannot act on them', async () => {
    const a = await shop();
    const b = await shop();
    await econ(a, { unitCost: '1400', shippingCost: '300' }).expect(200);
    const ex = (await call(a.admin, 'post', '/expenses', { amount: '5000', currency: 'XAF', spentOn: '2026-11-01', orders: 2 }).expect(201)).body;
    await run(a).expect(200);
    const d = (await decisions(a))[0]!;
    expect((await finance(b)).products.every((p: { productId: string }) => p.productId !== a.productId)).toBe(true);
    expect((await call(b.admin, 'get', '/expenses').expect(200)).body.items).toHaveLength(0);
    expect((await decisions(b))).toHaveLength(0);
    expect((await call(b.admin, 'post', `/decisions/${d.id}/approve`)).status).toBe(404);
    expect((await call(b.admin, 'post', `/decisions/${d.id}/reject`)).status).toBe(404);
    expect((await call(b.admin, 'delete', `/expenses/${ex.id}`)).status).toBe(404);
    expect((await call(b.admin, 'put', `/economics/${a.productId}`, ECON)).status).toBe(404);
    expect((await call(b.admin, 'post', '/scenarios', { productId: a.productId, scenarios: [{ name: 'x' }] })).status).toBe(404);
    const o = (await call(b.admin, 'get', '/overview').expect(200)).body;
    expect(o.decisions).toHaveLength(0);
    expect(o.latestRun).toBeNull();
    expect((await call(b.admin, 'get', '/runs').expect(200)).body.items).toHaveLength(0);
    expect(await prisma.marketingExpense.count({ where: { id: ex.id } })).toBe(1);
  });

  it('duplicate agent jobs: the same key returns the same run, concurrent calls store one, and decisions are not duplicated', async () => {
    const s = await shop();
    const a = (await run(s, 'k1').expect(200)).body;
    const b = (await run(s, 'k1').expect(200)).body;
    expect(b.id).toBe(a.id);
    const [x, y] = await Promise.all([run(s, 'k2'), run(s, 'k2')]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.body.id).toBe(y.body.id);
    expect(await prisma.executiveRun.count({ where: { businessId: s.owner.businessId } })).toBe(2);
    const first = (await decisions(s)).length;
    expect(first).toBeGreaterThan(0);
    await run(s, 'k3').expect(200); // a different key re-analyzes but the same findings are not proposed twice
    expect((await decisions(s)).length).toBe(first);
    expect((await run(s)).body.key).toBe((await run(s)).body.key); // the default key is per day
  });

  it('budget and quotas: the daily run limit stops a run before any work', async () => {
    const s = await shop();
    expect(code(await call(s.admin, 'put', '/settings', { dailyRunLimit: 0 }))).toBeDefined();
    await call(s.admin, 'put', '/settings', { dailyRunLimit: 1 }).expect(200);
    await run(s, 'a').expect(200);
    const over = await run(s, 'b');
    expect(over.status).toBe(429);
    expect(code(over)).toBe('RUN_LIMIT');
    expect(await prisma.executiveRun.count({ where: { businessId: s.owner.businessId } })).toBe(1);
    expect((await run(s, 'a').expect(200)).body.summary.tokensUsed).toBe(0); // a replay is free and does not count
  });

  it('inconsistent data is never reconciled by guessing: another currency without a rate leaves the margin unknown', async () => {
    const s = await shop();
    await request(h.http).patch(`/api/v1/products/${s.productId}`).set(as(s.editor)).send({ currency: 'EUR' }).expect(200);
    const r = (await econ(s).expect(200)).body; // costs in XAF, price in EUR, no exchange rate
    expect(r).toMatchObject({ status: 'INCOMPLETE', contributionBeforeAds: null });
    expect(r.missing).toEqual(expect.arrayContaining(['unit cost', 'shipping cost']));
    const t = await shop();
    const heavy = (await econ(t, { paymentFeePercent: '60', returnsAllowancePercent: '40' }).expect(200)).body;
    expect(heavy.breakEvenPrice).toBeNull(); // fees reach 100%: no price breaks even
    // Advertising cost per order is only compared in the currency the expenses were recorded in.
    await econ(s, { currency: 'EUR' }).expect(200);
    await call(s.admin, 'post', '/expenses', { amount: '999999', currency: 'XAF', spentOn: '2026-11-10', orders: 1 }).expect(201);
    await run(s).expect(200);
    expect((await decisions(s)).some((x) => x.kind === 'AD_COST_REVIEW')).toBe(false);
  });

  it('advertising cost review: proposed from entered spend and orders, and TOUMA never changes spend', async () => {
    const s = await shop();
    await econ(s).expect(200);
    const spent = await call(s.admin, 'post', '/expenses', { amount: '100000', currency: 'XAF', spentOn: new Date().toISOString().slice(0, 10), orders: 10, note: 'November ads' }).expect(201);
    await call(s.admin, 'post', '/expenses', { amount: '5000', currency: 'XAF', spentOn: new Date().toISOString().slice(0, 10) }).expect(201); // no orders known: not used for the ratio
    await run(s).expect(200);
    const d = (await decisions(s)).find((x) => x.kind === 'AD_COST_REVIEW')!;
    expect(d.problem).toMatch(/10000\.00 XAF per order, above the 587\.50 XAF/);
    expect(d.confidence).toBe('MEDIUM');
    expect(d.expectedBenefit.type).toBe('ESTIMATE');
    expect(d.risk).toMatch(/never changes advertising spend/);
    await call(s.admin, 'post', `/decisions/${d.id}/approve`).expect(200);
    expect((await call(s.admin, 'get', '/expenses').expect(200)).body.items).toHaveLength(2); // nothing was spent or removed
    expect(spent.body.orders).toBe(10);
  });

  it('customer intelligence: aggregate themes only, no text or identifiers, rare themes suppressed, gaps become decisions', async () => {
    const s = await shop();
    const acc = s.account!;
    let i = 0;
    const mk = (body: string, over: Record<string, unknown> = {}) => prisma.comment.create({ data: { businessId: s.owner.businessId, socialAccountId: acc.id, externalCommentId: `c${++i}`, authorName: 'Amina Hassan', authorExternalId: `u${i}`, body, ...over } });
    for (let k = 0; k < 4; k++) await mk(`Do you deliver to Abeche? call me 66 12 34 5${k} or amina${k}@example.com`);
    for (let k = 0; k < 3; k++) await mk('Too expensive! how much for two?');
    await mk('Is it in stock?'); // asked once: suppressed
    const r = (await call(s.editor, 'get', '/customer-intelligence').expect(200)).body;
    expect(r.faq).toEqual(expect.arrayContaining([{ topic: 'SHIPPING', count: 4 }]));
    expect(r.objections).toEqual([{ type: 'TOO_EXPENSIVE', count: 3 }]);
    expect(r.faq.find((f: { topic: string }) => f.topic === 'AVAILABILITY')).toBeUndefined();
    expect(r.missingInformation.map((m: { topic: string }) => m.topic)).toContain('SHIPPING');
    expect(JSON.stringify(r)).not.toMatch(/amina|Hassan|@example|66 12|Abeche|\bu\d\b/i);
    expect((await call(s.viewer, 'get', '/customer-intelligence').expect(200)).body.totals.inbound).toBe(8);
    await run(s).expect(200);
    const gap = (await decisions(s)).find((x) => x.kind === 'CUSTOMER_INFO_GAP')!;
    expect(JSON.stringify(gap)).not.toMatch(/amina|Hassan|@example|66 12|Abeche/i);
    const other = await shop();
    expect((await call(other.viewer, 'get', '/customer-intelligence').expect(200)).body.totals.inbound).toBe(0);
  });

  it('mock agent failures: a failing or hanging agent gives a partial run, never a half-applied one', async () => {
    const s = await shop();
    await econ(s, { unitCost: '1400', shippingCost: '300' }).expect(200);
    exec.faults.set('FINANCE_ANALYST', { fail: true });
    const failed = (await run(s, 'f1').expect(200)).body;
    expect(failed.status).toBe('PARTIAL');
    expect(failed.steps.find((x: { agent: string }) => x.agent === 'FINANCE_ANALYST')).toMatchObject({ status: 'FAILED', error: 'AGENT_FAILED' });
    expect(failed.steps.filter((x: { status: string }) => x.status === 'OK')).toHaveLength(5);
    expect((await decisions(s)).some((x) => x.kind === 'NEGATIVE_MARGIN_REVIEW')).toBe(false); // no finance, so no finance decision
    exec.faults.set('CUSTOMER_INTELLIGENCE', { delayMs: 5_600 });
    const slow = (await run(s, 'f2').expect(200)).body;
    expect(slow.steps.find((x: { agent: string }) => x.agent === 'CUSTOMER_INTELLIGENCE').status).toBe('TIMED_OUT');
    const ok = (await run(s, 'f3').expect(200)).body; // recovery: the next run is complete
    expect(ok.status).toBe('COMPLETED');
    expect((await decisions(s)).some((x) => x.kind === 'NEGATIVE_MARGIN_REVIEW')).toBe(true);
  }, 30_000);

  it('emergency stop: no run and no decision is applied until it is released; everything is audited', async () => {
    const s = await shop();
    await econ(s, { unitCost: null }).expect(200);
    await run(s, 'one').expect(200);
    const d = (await decisions(s))[0]!;
    await call(s.admin, 'put', '/settings', { paused: true }).expect(200);
    expect(code(await run(s, 'two'))).toBe('EXECUTIVE_PAUSED');
    expect(code(await call(s.admin, 'post', `/decisions/${d.id}/approve`))).toBe('EXECUTIVE_PAUSED');
    expect((await call(s.admin, 'get', '/settings').expect(200)).body.paused).toBe(true);
    expect(await prisma.executiveRun.count({ where: { businessId: s.owner.businessId, idempotencyKey: 'two' } })).toBe(0);
    await call(s.admin, 'put', '/settings', { paused: false }).expect(200);
    await run(s, 'two').expect(200);
    await call(s.admin, 'post', `/decisions/${d.id}/approve`).expect(200);
    const actions = (await prisma.auditLog.findMany({ where: { businessId: s.owner.businessId }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['executive.emergency_stop', 'executive.emergency_stop_released', 'executive.run', 'executive.economics_saved']));
  });

  it('forged decision kinds are refused: there is no price, refund, payment or advertising action', async () => {
    const s = await shop();
    for (const kind of ['PRICE_CHANGE', 'REFUND', 'AD_BUDGET', 'PAYMENT', 'PUBLISH']) {
      await expect(recs.createDecision(s.owner.businessId, { kind, title: 't', problem: 'p', evidence: {}, proposedAction: {}, expectedBenefit: { type: 'NOT_ESTIMATED', reason: 'x' }, confidence: 'LOW', reviewMinutes: 1, risk: 'r', priority: 1, dedupeKey: `x:${kind}` } as never)).rejects.toMatchObject({ response: { code: 'INVALID_KIND' } });
    }
    expect(await prisma.recommendation.count({ where: { businessId: s.owner.businessId } })).toBe(0);
  });

  it('slice: product data → financial analysis → campaign recommendation → merchant review → simulated campaign → mock metrics → improvement proposal; publication still needs individual approval', async () => {
    const s = await shop();
    await econ(s).expect(200);
    await run(s).expect(200);
    const proposal = (await decisions(s)).find((x) => x.kind === 'CAMPAIGN_PROPOSAL')!;
    expect(proposal.expectedBenefit.type).toBe('NOT_ESTIMATED'); // organic reach is not predicted
    expect(JSON.stringify(await decisions(s))).not.toMatch(/guarantee|will (increase|boost|double)/i);
    expect((await call(s.editor, 'post', `/decisions/${proposal.id}/approve`)).status).toBe(403);
    const done = (await call(s.admin, 'post', `/decisions/${proposal.id}/approve`).expect(200)).body;
    const campaignId = done.action.campaignDraftId as string;
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('DRAFT');
    expect(await prisma.publication.count({ where: { businessId: s.owner.businessId } })).toBe(0); // approving the proposal published nothing
    const camp = (path: string, body: Record<string, unknown> = {}) => request(h.http).post(`/api/v1/campaigns/${campaignId}${path}`).set(as(s.editor)).send(body);
    await camp('/plan', { days: 10, languages: ['en'] }).expect(200);
    await camp('/content').expect(200);
    await camp('/submit').expect(200);
    await h.calendarWorker.tick();
    expect(h.hub.posts).toHaveLength(0); // drafts and pending approvals are not publications
    const entries = (await request(h.http).get(`/api/v1/campaigns/${campaignId}`).set(as(s.viewer)).expect(200)).body.entries as Array<{ id: string }>;
    await h.act(s.admin, entries[0]!.id, 'approve').expect(200);
    await h.act(s.admin, entries[0]!.id, 'authorize').expect(200);
    await h.dispatch(entries[0]!.id);
    const pub = await h.reach(entries[0]!.id, ['PUBLISHED']);
    expect(pub.simulated).toBe(true);
    expect(h.hub.posts).toHaveLength(1);
    const ev = (await request(h.http).post(`/api/v1/campaigns/${campaignId}/metrics`).set(as(s.editor)).send({ refresh: true }).expect(200)).body;
    expect(ev.counts.real).toBe(0);
    const gen = (await request(h.http).post('/api/v1/intelligence/recommendations/generate').set(as(s.editor)).expect(200)).body;
    expect(gen.created).toBeGreaterThan(0); // improvement proposals: real measurements, follow-up posts
    const o = (await call(s.admin, 'get', '/overview').expect(200)).body;
    expect(o.simulatedPlatforms).toBe(true);
    expect(o.metricsOrigin).toMatchObject({ publishedSimulated: 1, publishedReal: 0 });
    expect(o.sections.salesData.status).toBe('MISSING');
    expect(o.sections.campaignMetrics.status).toBe('SIMULATED');
    expect(o.health.note).toMatch(/not how well the business performs/);
    expect(o.latestRun.status).toBe('COMPLETED');
  });

  it('customer replies are untouched by the executive layer in every mode', async () => {
    const s = await shop();
    await prisma.salesAgentConfig.upsert({ where: { businessId: s.owner.businessId }, create: { businessId: s.owner.businessId, enabled: true, replyMode: 'AUTO', autoReplyAuthorizedAt: new Date() }, update: { enabled: true, replyMode: 'AUTO', autoReplyAuthorizedAt: new Date() } });
    await prisma.comment.create({ data: { businessId: s.owner.businessId, socialAccountId: s.account!.id, externalCommentId: 'q1', body: 'What are the delivery fees?' } });
    const before = await prisma.comment.count({ where: { businessId: s.owner.businessId } });
    await run(s).expect(200);
    expect(h.hub.replies).toHaveLength(0); // the executive layer never sends a reply, even in AUTO
    expect(await prisma.comment.count({ where: { businessId: s.owner.businessId } })).toBe(before);
  });
});
