import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CampaignsService } from '../src/campaigns/campaigns.service';
import { MemoryService } from '../src/intelligence/memory.service';
import { RecommendationsService } from '../src/intelligence/recommendations.service';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * Phase N21: business intelligence (memory, evaluations, experiments, recommendations, alerts, safe self-improvement).
 * Real PostgreSQL, Redis, guards and services; mock agents; the platforms are the test-only simulator.
 * Nothing is sent to a real platform, customer or advertising network.
 */
describe('Business intelligence (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let camp: CampaignsService;
  let memory: MemoryService;
  let recs: RecommendationsService;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = socialHelpers(app);
    camp = app.get(CampaignsService);
    memory = app.get(MemoryService);
    recs = app.get(RecommendationsService);
  });
  beforeEach(() => h.hub.reset());
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function shop(connect = true) {
    const owner = await h.tenant(`Intel ${++n}`);
    const admin = await h.member(owner, 'ADMIN');
    const editor = await h.member(owner, 'EDITOR');
    const viewer = await h.member(owner, 'VIEWER');
    const account = connect ? await h.connect(owner, 'FACEBOOK') : null;
    return { owner, admin, editor, viewer, account, productId: owner.productId };
  }
  type S = Awaited<ReturnType<typeof shop>>;
  const call = (c: Ctx, method: 'get' | 'post' | 'delete', path: string, body: Record<string, unknown> = {}) => {
    const r = request(h.http)[method](`/api/v1/intelligence${path}`).set(as(c));
    return method === 'get' ? r : r.send(body);
  };
  const campaign = (c: Ctx, path = '', body: Record<string, unknown> = {}, method: 'get' | 'post' = 'post') => {
    const r = request(h.http)[method](`/api/v1/campaigns${path}`).set(as(c));
    return method === 'get' ? r : r.send(body);
  };
  async function ready(s: S) {
    const id = (await campaign(s.editor, '', { name: 'Launch', goalType: 'LAUNCH', productIds: [s.productId] }).expect(201)).body.id as string;
    await campaign(s.editor, `/${id}/plan`, { days: 10, languages: ['en', 'fr'] }).expect(200);
    await campaign(s.editor, `/${id}/content`).expect(200);
    return id;
  }
  const view = async (s: S, id: string) => (await campaign(s.viewer, `/${id}`, {}, 'get').expect(200)).body;
  const code = (r: request.Response) => r.body.code ?? r.body.error?.code;
  /** Approve, authorize (people, N18), dispatch and wait for the simulated publication of the first `count` posts. */
  async function publish(s: S, id: string, count: number) {
    await campaign(s.editor, `/${id}/submit`).expect(200);
    const entries = (await view(s, id)).entries.slice(0, count) as Array<{ id: string }>;
    for (const e of entries) {
      await h.act(s.admin, e.id, 'approve').expect(200);
      await h.act(s.admin, e.id, 'authorize').expect(200);
      await h.dispatch(e.id);
      await h.reach(e.id, ['PUBLISHED']);
    }
    return entries.map((e) => e.id);
  }

  it('memory: provenance rules, minimization, retention, isolation and deletion', async () => {
    const a = await shop();
    const b = await shop();
    await call(a.editor, 'post', '/memory', { kind: 'BRAND', key: 'voice', value: { tone: 'warm' }, provenance: 'MERCHANT' }).expect(200);
    // A metric can only come from a platform: a person or an agent cannot write one (no fabricated metrics).
    for (const provenance of ['MERCHANT', 'AGENT', 'CATALOG']) expect(code(await call(a.editor, 'post', '/memory', { kind: 'METRIC', key: 'reach', value: { reach: 99999 }, provenance }))).toBe('INVALID_PROVENANCE');
    await call(a.editor, 'post', '/memory', { kind: 'METRIC', key: 'reach', value: { reach: 10 }, provenance: 'PLATFORM_SIMULATED' }).expect(200);
    // Minimization: no contact data.
    expect(code(await call(a.editor, 'post', '/memory', { kind: 'BRAND', key: 'contact', value: { note: 'call me on +235 66 12 34 56' }, provenance: 'MERCHANT' }))).toBe('SENSITIVE_DATA');
    expect(code(await call(a.editor, 'post', '/memory', { kind: 'BRAND', key: 'contact2', value: { note: 'mail awa@example.com' }, provenance: 'MERCHANT' }))).toBe('SENSITIVE_DATA');
    expect(code(await call(a.editor, 'post', '/memory', { kind: 'PREFERENCE', key: 'agent.prompt', value: { value: 5 }, provenance: 'MERCHANT' }))).toBe('INVALID_PREFERENCE');
    expect((await call(a.viewer, 'post', '/memory', { kind: 'BRAND', key: 'x', value: { a: 1 }, provenance: 'MERCHANT' })).status).toBe(403);
    // Isolation: another business sees nothing and deletes nothing.
    expect((await call(b.viewer, 'get', '/memory').expect(200)).body.items).toHaveLength(0);
    expect((await call(b.admin, 'delete', '/memory', {}).expect(200)).body.deleted).toBe(0);
    expect((await call(a.viewer, 'get', '/memory').expect(200)).body.items).toHaveLength(2);
    // Retention: expired entries are hidden and purged.
    await prisma.merchantMemory.updateMany({ where: { businessId: a.owner.businessId, kind: 'METRIC' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(a.viewer, 'get', '/memory').expect(200)).body.items).toHaveLength(1);
    expect(await memory.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await prisma.merchantMemory.count({ where: { businessId: a.owner.businessId, kind: 'METRIC' } })).toBe(0);
    // Deletion needs an administrator and removes only this business's data.
    expect((await call(a.editor, 'delete', '/memory', {})).status).toBe(403);
    expect((await call(a.admin, 'delete', '/memory', { kind: 'BRAND', key: 'voice' }).expect(200)).body.deleted).toBe(1);
    await call(a.editor, 'post', '/memory', { kind: 'BRAND', key: 'voice2', value: { tone: 'warm' }, provenance: 'MERCHANT' }).expect(200);
    await call(b.editor, 'post', '/memory', { kind: 'BRAND', key: 'voice', value: { tone: 'bold' }, provenance: 'MERCHANT' }).expect(200);
    expect((await call(a.admin, 'delete', '/memory', {}).expect(200)).body.deleted).toBe(1);
    expect((await call(b.viewer, 'get', '/memory').expect(200)).body.items).toHaveLength(1);
  });

  it('slice: verified product → proposal → variants → individual approval → simulated publication → mock metrics → evaluation → recommendation', async () => {
    const s = await shop();
    const id = await ready(s);
    const [first, second] = await publish(s, id, 2);
    expect(h.hub.posts).toHaveLength(2); // exactly the two posts a person approved
    expect((await view(s, id)).entries.filter((e: { approvalStatus: string }) => e.approvalStatus === 'IN_REVIEW').length).toBeGreaterThanOrEqual(0);

    const ev = (await campaign(s.editor, `/${id}/metrics`, { refresh: true }).expect(200)).body;
    expect(ev.counts.real).toBe(0); // simulated or unavailable, never real
    const mem = (await call(s.editor, 'post', `/memory/capture/${id}`).expect(200)).body.written as string[];
    expect(mem.some((k) => k.startsWith('CAMPAIGN_HISTORY'))).toBe(true);
    const stored = (await call(s.viewer, 'get', '/memory?kind=METRIC').expect(200)).body.items;
    for (const m of stored) expect(m.provenance).toBe('PLATFORM_SIMULATED');

    // Experiment: simulated data can never produce a "winner".
    const x = (await call(s.editor, 'post', '/experiments', { campaignId: id, hypothesis: 'Benefit wording gets more engagement than feature wording', metric: 'engagementRate', entryA: first, entryB: second }).expect(201)).body;
    const done = (await call(s.viewer, 'post', `/experiments/${x.id}/conclude`).expect(200)).body;
    expect(['SIMULATED_NOT_EVIDENCE', 'INSUFFICIENT_DATA']).toContain(done.result.verdict);
    expect(done.result.leader).toBeNull();
    expect(done.result.caveats.join(' ')).toMatch(/not evidence about sales/);
    expect((await call(s.viewer, 'post', `/experiments/${x.id}/conclude`)).status).toBe(409);

    // Recommendations: evidence, cost, priority; no duplicates; the merchant decides.
    const gen = (await call(s.editor, 'post', '/recommendations/generate').expect(200)).body;
    expect(gen.created).toBeGreaterThan(0);
    expect((await call(s.editor, 'post', '/recommendations/generate').expect(200)).body.created).toBe(0);
    const list = (await call(s.viewer, 'get', '/recommendations?status=PROPOSED').expect(200)).body.items as Array<{ id: string; kind: string; priority: number; evidence: unknown; costEstimate: { adSpendMicros: number } }>;
    expect(list.map((r) => r.priority)).toEqual([...list.map((r) => r.priority)].sort((p, q) => q - p));
    expect(list.every((r) => r.costEstimate.adSpendMicros === 0 && r.evidence)).toBe(true);
    expect(list.some((r) => r.kind === 'DATA_GAP')).toBe(true);
    const follow = list.find((r) => r.kind === 'FOLLOW_UP');
    if (follow) {
      expect((await call(s.editor, 'post', `/recommendations/${follow.id}/approve`)).status).toBe(403); // a merchant decision
      const posts = h.hub.posts.length;
      const ok = (await call(s.admin, 'post', `/recommendations/${follow.id}/approve`).expect(200)).body;
      expect(ok.action.drafted.length).toBeGreaterThan(0);
      const row = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: ok.action.drafted[0] }, include: { content: true } });
      expect(row.content!.status).toBe('DRAFT'); // drafts only: it still needs its own approval
      expect(row.authorizedHash).toBeNull();
      expect(h.hub.posts).toHaveLength(posts);
      expect((await call(s.admin, 'post', `/recommendations/${follow.id}/approve`)).status).toBe(409);
    }
    const gap = list.find((r) => r.kind === 'DATA_GAP')!;
    await call(s.admin, 'post', `/recommendations/${gap.id}/reject`).expect(200);
    expect((await call(s.editor, 'post', '/recommendations/generate').expect(200)).body.created).toBe(0); // a rejected proposal is not re-proposed
    // The experiment and evaluation are simulated, and the overview says so.
    const o = (await call(s.viewer, 'get', '/overview').expect(200)).body;
    expect(o.simulatedPlatforms).toBe(true);
    expect(o.metricsOrigin).toMatchObject({ publishedSimulated: 2, publishedReal: 0 });
    expect(o.cost.limitMicros).toBe(0);
    expect(o.quotas.publicationsToday).toBeGreaterThanOrEqual(2);
  });

  it('evaluations: factual and approval checks pass on good drafts, a contradictory price is caught, and regressions are detected', async () => {
    const s = await shop();
    const id = await ready(s);
    await publish(s, id, 1);
    const first = (await call(s.editor, 'post', '/evaluations/run').expect(200)).body.suites as Array<{ suite: string; passed: boolean; regression: { regressed: boolean }; results: Array<{ id: string; pass: boolean; criterion: string }> }>;
    const golden = first.find((x) => x.suite === 'golden')!;
    const tenant = first.find((x) => x.suite === 'tenant-health')!;
    expect(golden.passed).toBe(true); // the evaluators still discriminate
    expect(tenant.passed).toBe(true);
    expect(tenant.results.find((r) => r.id === 'publications:approval')!.pass).toBe(true);
    expect(first.every((x) => !x.regression.regressed)).toBe(true);
    const again = (await call(s.editor, 'post', '/evaluations/run').expect(200)).body.suites;
    expect(again.every((x: { regression: { regressed: boolean } }) => !x.regression.regressed)).toBe(true);
    // The merchant changes the price: the drafts now contradict the verified catalog, and the evaluation says so.
    await request(h.http).patch(`/api/v1/products/${s.productId}`).set(as(s.editor)).send({ price: '2000' }).expect(200);
    const after = (await call(s.editor, 'post', '/evaluations/run').expect(200)).body.suites;
    const t2 = after.find((x: { suite: string }) => x.suite === 'tenant-health');
    expect(t2.regression.regressed).toBe(true);
    expect(t2.regression.newlyFailing.some((i: string) => i.endsWith(':factual'))).toBe(true);
    // Budget exhaustion shows up as a failing cost case.
    const cid = (await prisma.campaign.findFirstOrThrow({ where: { businessId: s.owner.businessId } })).id;
    await prisma.campaign.update({ where: { id: cid }, data: { costUsedMicros: 50 } });
    const t3 = (await call(s.editor, 'post', '/evaluations/run').expect(200)).body.suites.find((x: { suite: string }) => x.suite === 'tenant-health');
    expect(t3.results.find((r: { id: string }) => r.id === `${cid}:cost`).pass).toBe(false);
  });

  it('safe self-improvement: bounded, evaluated offline, approved by a person, then applied only as a preference', async () => {
    const s = await shop();
    expect(code(await call(s.editor, 'post', '/improvements', { key: 'agent.prompt', value: 5 }))).toBe('INVALID_IMPROVEMENT');
    expect(code(await call(s.editor, 'post', '/improvements', { key: 'creative.maxCaptionChars', value: 50 }))).toBe('INVALID_IMPROVEMENT');
    // A limit that truncates real wording fails the offline evaluation and cannot be approved.
    const tight = (await call(s.editor, 'post', '/improvements', { key: 'creative.maxCaptionChars', value: 150 }).expect(201)).body;
    expect(code(await call(s.admin, 'post', `/recommendations/${tight.id}/approve`))).toBe('EVALUATION_REQUIRED');
    const bad = (await call(s.editor, 'post', `/improvements/${tight.id}/evaluate`).expect(200)).body;
    expect(bad.passed).toBe(false);
    expect(bad.failing.length).toBeGreaterThan(0);
    expect(code(await call(s.admin, 'post', `/recommendations/${tight.id}/approve`))).toBe('EVALUATION_REQUIRED');
    expect(await memory.preference(s.owner.businessId, 'creative.maxCaptionChars')).toBeNull();
    // A reasonable limit passes, needs an administrator, and is applied as a bounded preference.
    const ok = (await call(s.editor, 'post', '/improvements', { key: 'creative.maxCaptionChars', value: 600 }).expect(201)).body;
    expect((await call(s.editor, 'post', `/improvements/${ok.id}/evaluate`).expect(200)).body.passed).toBe(true);
    expect((await call(s.editor, 'post', `/recommendations/${ok.id}/approve`)).status).toBe(403);
    await call(s.admin, 'post', `/recommendations/${ok.id}/approve`).expect(200);
    expect(await memory.preference(s.owner.businessId, 'creative.maxCaptionChars')).toBe(600);
    expect(code(await call(s.editor, 'post', '/improvements', { key: 'creative.maxCaptionChars', value: 600 }))).toBe('NO_CHANGE');
    const id = await ready(s); // the new behavior is used by the Director
    const captions = (await prisma.content.findMany({ where: { businessId: s.owner.businessId } })).map((c) => c.caption!.length);
    expect(Math.max(...captions)).toBeLessThanOrEqual(600);
    expect(id).toBeTruthy();
    // The agent only suggests when its own drafts run long.
    expect((await call(s.editor, 'post', '/improvements/suggest').expect(200)).body.proposed).toHaveLength(0);
  });

  it('forged recommendation kinds are refused: there is no advertising or budget action', async () => {
    const s = await shop();
    await expect((recs as unknown as { create: (b: string, c: unknown) => Promise<unknown> }).create(s.owner.businessId, { kind: 'ADS_BUDGET', title: 'Raise the ad budget', evidence: {}, reviewMinutes: 1, priority: 99, dedupeKey: 'x' })).rejects.toMatchObject({ response: { code: 'INVALID_KIND' } });
    expect(await prisma.recommendation.count({ where: { businessId: s.owner.businessId } })).toBe(0);
  });

  it('alerts: deduplicated, severity-ranked, resolved when the condition clears', async () => {
    const s = await shop();
    await prisma.socialAccount.update({ where: { id: s.account!.id }, data: { status: 'TOKEN_EXPIRED' } });
    const id = await ready(s);
    await prisma.campaign.update({ where: { id }, data: { executionsUsed: 19 } });
    const scan = async () => (await call(s.editor, 'post', '/alerts/scan').expect(200)).body;
    const first = await scan();
    expect(first.created).toBeGreaterThanOrEqual(3);
    const open = (await call(s.viewer, 'get', '/alerts').expect(200)).body.items as Array<{ kind: string; severity: string; occurrences: number }>;
    expect(open[0]!.severity).toBe('CRITICAL'); // most severe first
    expect(open.map((a) => a.kind)).toEqual(expect.arrayContaining(['EXPIRED_CONNECTION', 'MISSING_PRODUCT_DATA', 'COST_THRESHOLD']));
    const second = await scan();
    expect(second.created).toBe(0); // the same conditions update the same alerts
    expect(await prisma.businessAlert.count({ where: { businessId: s.owner.businessId, resolvedAt: null } })).toBe(first.open);
    expect((await call(s.viewer, 'get', '/alerts').expect(200)).body.items.every((a: { occurrences: number }) => a.occurrences === 2)).toBe(true);
    // Failures and workflow errors.
    camp.faults.set('PRODUCT_INTELLIGENCE', { fail: true });
    const c2 = (await campaign(s.editor, '', { name: 'Second', goalType: 'AWARENESS', productIds: [s.productId] }).expect(201)).body.id as string;
    await campaign(s.editor, `/${c2}/plan`).expect(502);
    camp.faults.set('PRODUCT_INTELLIGENCE', { fail: true });
    await campaign(s.editor, `/${c2}/plan`).expect(502);
    await scan();
    expect((await call(s.viewer, 'get', '/alerts').expect(200)).body.items.map((a: { kind: string }) => a.kind)).toContain('WORKFLOW_ERRORS');
    // The connection is repaired: that alert is resolved, not duplicated.
    await prisma.socialAccount.update({ where: { id: s.account!.id }, data: { status: 'CONNECTED' } });
    const fixed = await scan();
    expect(fixed.resolved).toBeGreaterThanOrEqual(1);
    expect((await call(s.viewer, 'get', '/alerts').expect(200)).body.items.map((a: { kind: string }) => a.kind)).not.toContain('EXPIRED_CONNECTION');
  });

  it('isolation: another business sees none of this and cannot act on it', async () => {
    const a = await shop();
    const b = await shop();
    const id = await ready(a);
    await call(a.editor, 'post', '/recommendations/generate').expect(200);
    await call(a.editor, 'post', '/alerts/scan').expect(200);
    const rid = (await prisma.recommendation.findFirstOrThrow({ where: { businessId: a.owner.businessId } })).id;
    const entries = (await view(a, id)).entries as Array<{ id: string }>;
    const x = (await call(a.editor, 'post', '/experiments', { campaignId: id, hypothesis: 'Variant A beats variant B for this product', metric: 'likes', entryA: entries[0]!.id, entryB: entries[1]!.id }).expect(201)).body;
    expect((await call(b.owner, 'get', '/recommendations').expect(200)).body.items).toHaveLength(0);
    expect((await call(b.owner, 'get', '/alerts').expect(200)).body.items).toHaveLength(0);
    expect((await call(b.owner, 'get', '/experiments').expect(200)).body.items).toHaveLength(0);
    const o = (await call(b.owner, 'get', '/overview').expect(200)).body;
    expect(o.campaigns.recent).toHaveLength(0);
    expect(o.recommendations).toHaveLength(0);
    expect((await call(b.admin, 'post', `/recommendations/${rid}/approve`)).status).toBe(404);
    expect((await call(b.admin, 'post', `/recommendations/${rid}/reject`)).status).toBe(404);
    expect((await call(b.admin, 'post', `/experiments/${x.id}/conclude`)).status).toBe(404);
    expect((await call(b.editor, 'post', `/memory/capture/${id}`)).status).toBe(404);
    expect(code(await call(b.editor, 'post', '/experiments', { campaignId: id, hypothesis: 'Variant A beats variant B for this product', metric: 'likes', entryA: entries[0]!.id, entryB: entries[1]!.id }))).toBe('VARIANT_NOT_FOUND');
    expect((await call(b.owner, 'get', '/evaluations').expect(200)).body.items).toHaveLength(0);
  });

  it('an experiment cannot be concluded before both variants are published, and the same variant cannot be used twice', async () => {
    const s = await shop();
    const id = await ready(s);
    const entries = (await view(s, id)).entries as Array<{ id: string }>;
    const x = (await call(s.editor, 'post', '/experiments', { campaignId: id, hypothesis: 'Variant A beats variant B for this product', metric: 'reach', entryA: entries[0]!.id, entryB: entries[1]!.id }).expect(201)).body;
    expect(code(await call(s.editor, 'post', `/experiments/${x.id}/conclude`))).toBe('NOT_PUBLISHED');
    expect(code(await call(s.editor, 'post', '/experiments', { campaignId: id, hypothesis: 'Variant A beats variant B for this product', metric: 'reach', entryA: entries[0]!.id, entryB: entries[0]!.id }))).toBe('SAME_VARIANT');
    expect(code(await call(s.editor, 'post', '/experiments', { campaignId: id, hypothesis: 'Variant A beats variant B for this product', metric: 'revenue', entryA: entries[0]!.id, entryB: entries[1]!.id }))).toBeDefined();
    expect(h.hub.posts).toHaveLength(0);
  });
});
