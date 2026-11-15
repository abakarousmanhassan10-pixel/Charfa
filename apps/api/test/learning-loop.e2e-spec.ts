import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';
import { MockAnalyticsProvider } from '../src/learning/analytics-provider';
import { seedHistory } from '../src/learning/demo-history';
import { LearningService } from '../src/learning/learning.service';
import { ANALYTICS_PROVIDER } from '../src/learning/performance.service';
import { PrismaService } from '../src/prisma/prisma.service';

/** N22 phase C: comparison tests, the learning loop, quality evaluation and the A/B demo. All simulated: no platform is contacted, nothing real is published. */
const ENV: Record<string, string> = { LEARNING_ENABLED: 'true', ANALYTICS_PROVIDER: 'mock', LEARNING_RATE_LIMIT_PER_MINUTE: '1000', AUTOPUBLISH_ENABLED: 'true', AUTOPUBLISH_RATE_LIMIT_PER_MINUTE: '1000', BILLING_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: 'n22-webhook-secret-0123456789', BILLING_ENFORCEMENT_ENABLED: 'true', BILLING_GRACE_DAYS: '3', LEARNING_MAX_RUNS_PER_DAY: '5' };
const LEARN = { accept: true, consentVersion: '2026-12-v1' };
const PUB = { accept: true, consentVersion: '2026-11-v1' };
const DAY = 86_400_000;
const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }];

describe('Learning: loop, experiments, quality (simulated)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let provider: MockAnalyticsProvider;
  let loop: LearningService;
  let n = 0;
  const L = (m: 'get' | 'post' | 'put', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/learning/${path}`).set(as(c)); return body !== undefined ? r.send(body) : m === 'post' ? r.send({}) : r; };
  const P = (m: 'get' | 'post' | 'put', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/publishing/${path}`).set(as(c)); return body !== undefined ? r.send(body) : m === 'post' ? r.send({}) : r; };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    await prisma.$executeRawUnsafe('TRUNCATE "AgentControl" CASCADE');
    await prisma.plan.upsert({ where: { code: 'PRO' }, update: { limits: {}, isActive: true }, create: { code: 'PRO', name: 'PRO', priceAmount: '49', priceAmountMinor: 4900, yearlyPriceAmountMinor: 49000, currency: 'USD', limits: {} } });
    app = await startApp();
    h = socialHelpers(app);
    provider = app.get<MockAnalyticsProvider>(ANALYTICS_PROVIDER);
    loop = app.get(LearningService);
  });
  beforeEach(() => { provider.down = false; provider.delayHours = 24; });
  afterAll(async () => { await prisma.$executeRawUnsafe('TRUNCATE "AgentControl" CASCADE'); await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  async function biz(o: { posts?: number; collect?: boolean } = {}) {
    const owner = await h.tenant(`Loop ${++n}`);
    const admin = await h.member(owner, 'ADMIN');
    const viewer = await h.member(owner, 'VIEWER');
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await prisma.subscription.create({ data: { businessId: owner.businessId, planId: plan.id, status: 'ACTIVE', provider: 'simulated', amountMinor: 4900, currentPeriodStart: new Date(Date.now() - 5 * DAY), currentPeriodEnd: new Date(Date.now() + 25 * DAY) } });
    const account = await h.connect(owner, 'INSTAGRAM');
    const media = await h.jpeg(owner);
    await prisma.productMedia.create({ data: { productId: owner.productId, mediaId: media.id } });
    if (o.posts ?? 30) {
      await seedHistory(app.get(PrismaService), { businessId: owner.businessId, socialAccountId: account.id, platform: 'INSTAGRAM', count: o.posts ?? 30 });
      if (o.collect !== false) await L('post', 'performance/collect', owner).expect(200);
    }
    return { owner, admin, viewer, account, media };
  }
  type Biz = Awaited<ReturnType<typeof biz>>;
  const consent = (b: Biz) => L('post', 'consent', b.owner, LEARN).expect(200);
  const run = (b: Biz) => L('post', 'runs', b.owner).expect(200).then((r) => r.body);
  const step = (r: { steps: Array<{ step: string; status: string; detail: string; data?: unknown }> }, name: string) => r.steps.find((s) => s.step === name)!;
  async function publishingPolicy(b: Biz, mode: 'AUTO' | 'HYBRID' | 'MANUAL') {
    await P('post', `accounts/${b.account.id}/consent`, b.owner, PUB).expect(200);
    await P('put', `accounts/${b.account.id}/policy`, b.owner, { mode, timezone: 'UTC', allowedContentTypes: ['IMAGE'], allowedPublishingHours: ALL_DAY, maximumPostsPerDay: 5 }).expect(200);
  }

  it('one pass: collect, analyze, recommend, validate policy, (skip) execute, measure; nothing is spent and nothing is scheduled', async () => {
    const b = await biz();
    await consent(b);
    const r = await run(b);
    expect(r).toMatchObject({ status: 'COMPLETED', trigger: 'MANUAL', costEstimate: { aiCostMicros: 0, adSpendMicros: 0 } });
    expect(r.steps.map((s: { step: string }) => s.step)).toEqual(['COLLECT', 'ANALYZE', 'RECOMMEND', 'VALIDATE_POLICY', 'EXECUTE', 'MEASURE']);
    expect(step(r, 'EXECUTE').status).toBe('SKIPPED');
    expect(step(r, 'ANALYZE').detail).toMatch(/30 measured post/);
    expect(r.counts.created).toBeGreaterThanOrEqual(3);
    expect(r.baseline).toMatchObject({ n: 30 });
    expect(await prisma.calendarEvent.count({ where: { businessId: b.owner.businessId } })).toBe(0);
    expect(await prisma.publication.count({ where: { businessId: b.owner.businessId, simulated: false } })).toBe(0);
    const runs = (await L('get', 'runs', b.viewer).expect(200)).body;
    expect(runs).toHaveLength(1);
    await L('post', 'runs', b.viewer).expect(403);
  });

  it('refusals are recorded and nothing happens: no consent, revoked consent, emergency stop, run quota, expired subscription', async () => {
    const b = await biz();
    expect((await run(b)).blockedReason).toMatch(/^CONSENT_REQUIRED/);
    await consent(b);
    await L('put', 'settings', b.owner, { maxRunsPerDay: 1 }).expect(200);
    expect((await run(b)).status).toBe('COMPLETED');
    expect((await run(b)).blockedReason).toMatch(/^RUN_QUOTA/); // quota exceeded
    await L('put', 'settings', b.owner, { maxRunsPerDay: 5 }).expect(200);
    await prisma.agentControl.upsert({ where: { scope_scopeId: { scope: 'GLOBAL', scopeId: '' } }, create: { scope: 'GLOBAL', scopeId: '', stopped: true, reason: 'test' }, update: { stopped: true } });
    expect((await run(b)).blockedReason).toMatch(/^AUTOMATION_STOPPED/);
    await prisma.agentControl.update({ where: { scope_scopeId: { scope: 'GLOBAL', scopeId: '' } }, data: { stopped: false } });
    await prisma.subscription.update({ where: { businessId: b.owner.businessId }, data: { status: 'EXPIRED', currentPeriodEnd: new Date(Date.now() - 30 * DAY) } });
    expect((await run(b)).blockedReason).toMatch(/^SUBSCRIPTION_REQUIRED/);
    await prisma.subscription.update({ where: { businessId: b.owner.businessId }, data: { status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 25 * DAY) } });
    await L('post', 'consent/revoke', b.owner).expect(200);
    expect((await run(b)).blockedReason).toMatch(/^CONSENT_REQUIRED/);
    expect((await L('get', 'runs', b.owner).expect(200)).body.filter((x: { status: string }) => x.status === 'BLOCKED').length).toBeGreaterThanOrEqual(4);
  });

  it('an unreachable analytics source fails the run before anything is analyzed or changed', async () => {
    const b = await biz({ collect: false });
    await consent(b);
    provider.down = true;
    const r = await run(b);
    expect(r).toMatchObject({ status: 'FAILED' });
    expect(r.blockedReason).toMatch(/^COLLECT_FAILED/);
    expect(step(r, 'COLLECT').status).toBe('FAILED');
    expect((await L('get', 'recommendations', b.owner).expect(200)).body).toEqual([]);
    expect((await L('get', 'preferences', b.owner).expect(200)).body.inferred).toEqual([]);
    provider.down = false;
    expect((await run(b)).status).toBe('COMPLETED'); // recovers
  });

  it('two runs at the same time: only one completes (quota and single-run lock)', async () => {
    const b = await biz();
    await consent(b);
    await L('put', 'settings', b.owner, { maxRunsPerDay: 1 }).expect(200);
    const rs = await Promise.all([run(b), run(b)]);
    expect(rs.filter((r) => r.status === 'COMPLETED')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'BLOCKED')).toHaveLength(1);
  });

  it('the loop can never publish without authorization: without a publishing consent nothing is planned; MANUAL sends drafts to a person; HYBRID/AUTO go through the policy', async () => {
    // No publishing consent: nothing is prepared.
    const a = await biz();
    await consent(a);
    await L('put', 'settings', a.owner, { autoPlan: true }).expect(200);
    const ra = await run(a);
    expect(step(ra, 'EXECUTE').status).toBe('SKIPPED');
    expect(await prisma.calendarEvent.count({ where: { businessId: a.owner.businessId } })).toBe(0);
    // MANUAL policy with consent: drafts are prepared but only wait for a person's review.
    const m = await biz();
    await consent(m);
    await publishingPolicy(m, 'MANUAL');
    await L('put', 'settings', m.owner, { autoPlan: true }).expect(200);
    const rm = await run(m);
    expect(step(rm, 'EXECUTE').status).toBe('OK');
    const dm = await prisma.publishingDecision.findMany({ where: { businessId: m.owner.businessId } });
    expect(dm.length).toBeGreaterThan(0);
    expect(dm.every((d) => d.action === 'SENT_TO_REVIEW')).toBe(true);
    // AUTO: ordinary drafts are scheduled by the policy; the loop itself still published nothing.
    const u = await biz();
    await consent(u);
    await publishingPolicy(u, 'AUTO');
    await L('put', 'settings', u.owner, { autoPlan: true }).expect(200);
    const before = await prisma.publication.count({ where: { businessId: u.owner.businessId } });
    const ru = await run(u);
    expect(step(ru, 'EXECUTE').detail).toMatch(/AUTO_SCHEDULED/);
    expect(await prisma.publication.count({ where: { businessId: u.owner.businessId } })).toBe(before);
    // Withdrawn publishing consent: the next loop prepares nothing.
    await P('post', `accounts/${u.account.id}/consent/revoke`, u.owner).expect(200);
    const rs = await run(u);
    expect(step(rs, 'EXECUTE').status).toBe('SKIPPED');
  });

  it('rolling a run back restores the earlier inferred configuration and never touches declared preferences', async () => {
    const b = await biz();
    await consent(b);
    await L('put', 'preferences/tone', b.owner, { value: 'formal' }).expect(200);
    const r = await run(b);
    expect((await L('get', 'preferences', b.owner).expect(200)).body.inferred.length).toBeGreaterThan(0);
    const rb = (await L('post', `runs/${r.id}/rollback`, b.owner).expect(200)).body;
    expect(rb.status).toBe('ROLLED_BACK');
    const p = (await L('get', 'preferences', b.owner).expect(200)).body;
    expect(p.inferred).toEqual([]);
    expect(p.declared.map((x: { key: string }) => x.key)).toEqual(['tone']);
    expect((await L('get', 'preferences/revisions?key=*', b.owner).expect(200)).body[0].action).toBe('ROLLBACK');
    const other = await biz({ posts: 0 });
    await L('post', `runs/${r.id}/rollback`, other.owner).expect(400); // another business's run is not reachable
  });

  it('a biased comparison is labelled non-randomized with its bias flags, and the conclusion stays prudent', async () => {
    const b = await biz({ posts: 0 });
    await consent(b);
    const day = (k: number) => new Date(Date.now() + k * DAY).toISOString().slice(0, 10);
    const mk = (title: string, date: string) => h.create(b.owner, { title, platform: 'INSTAGRAM', caption: `Caption for ${title}`, localDate: date, localTime: '18:00' }).expect(201).then((r) => r.body.id as string);
    const [ea, eb] = [await mk('Statement version', day(3)), await mk('Question version?', day(6))];
    const exp = (await L('post', 'experiments', b.owner, { hypothesis: 'A question title gets more engagement than a statement', entryA: ea, entryB: eb }).expect(201)).body;
    expect(exp).toMatchObject({ design: 'NON_RANDOMIZED_SEQUENTIAL', status: 'RUNNING' });
    expect(exp.biasFlags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(['NOT_RANDOMIZED', 'DIFFERENT_DAYS', 'ORDER_EFFECT']));
    expect(exp.conditions).toMatchObject({ paidPromotion: false });
    await L('post', `experiments/${exp.id}/conclude`, b.owner).expect(409).expect((r) => expect(r.body.code).toBe('NOT_PUBLISHED'));
    // Both posts get published (simulated) and measured.
    for (const [e, k] of [[ea, 3], [eb, 6]] as const) {
      const row = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: e } });
      const at = new Date(Date.now() - (10 - k) * DAY);
      await prisma.publication.create({ data: { businessId: b.owner.businessId, contentId: row.contentId!, socialAccountId: b.account.id, calendarEventId: e, platform: 'INSTAGRAM', status: 'PUBLISHED', scheduledAt: at, publishedAt: at, timezone: 'UTC', idempotencyKey: `exp-${e}`, simulated: true, confirmedByProvider: true, externalPostId: `sim-${e}` } });
    }
    await L('post', 'performance/collect', b.owner).expect(200);
    const done = (await L('post', `experiments/${exp.id}/conclude`, b.owner).expect(200)).body;
    expect(done.status).toBe('CONCLUDED');
    expect(done.result.conclusion).toMatchObject({ design: 'NON_RANDOMIZED_SEQUENTIAL', evidenceGrade: 'ANECDOTAL', verdict: 'SIMULATED_NOT_EVIDENCE', observedLeader: null });
    expect(JSON.stringify(done.result)).not.toMatch(/guarantee|will increase|proves/i);
    // Variants prepared by TOUMA are ordinary drafts that differ only by the title opening.
    const prep = (await L('post', 'experiments/prepare', b.owner, { hypothesis: 'Question openings do better', platform: 'INSTAGRAM', base: { title: 'Fresh bissap today', caption: 'Brewed every morning.', hashtags: ['#bissap'], mediaIds: [] }, scheduledAtA: new Date(Date.now() + 8 * DAY).toISOString(), scheduledAtB: new Date(Date.now() + 9 * DAY).toISOString() }).expect(201)).body;
    expect(prep.changed).toEqual(['title.hook']);
    expect(prep.variants.A.caption).toBe(prep.variants.B.caption);
    const drafts = await prisma.content.findMany({ where: { id: { in: (await prisma.calendarEvent.findMany({ where: { id: { in: [prep.entries.A, prep.entries.B] } } })).map((e) => e.contentId!) } } });
    expect(drafts.every((d) => d.status === 'DRAFT')).toBe(true);
    expect((await L('get', 'experiments', b.viewer).expect(200)).body).toHaveLength(2);
  });

  it('quality evaluation: the fixed corpus passes, regressions would be reported, and feedback is tracked without assuming improvement', async () => {
    const b = await biz();
    await consent(b);
    const e1 = (await L('post', 'quality/evaluate', b.owner).expect(200)).body;
    expect(e1).toMatchObject({ passed: true, score: 100, regressions: [] });
    expect(e1.cases.length).toBeGreaterThanOrEqual(8);
    await run(b);
    const [rec] = (await L('get', 'recommendations', b.owner).expect(200)).body;
    await L('post', `recommendations/${rec.id}/feedback`, b.owner, { decision: 'USEFUL' }).expect(200);
    await L('post', `recommendations/${rec.id}/decision`, b.owner, { decision: 'ACCEPT' }).expect(200);
    const e2 = (await L('post', 'quality/evaluate', b.owner).expect(200)).body;
    expect(e2.regressions).toEqual([]);
    const q = (await L('get', 'quality', b.owner).expect(200)).body;
    expect(q.feedback).toMatchObject({ USEFUL: 1, ACCEPTED: 1 });
    expect(q.golden).toMatchObject({ passed: true, score: 100 });
    expect(q.note).toMatch(/not assumed to be better/);
  });

  it('the scheduled pass runs due businesses once, and earlier runs are measured against their baseline without claiming a cause', async () => {
    const b = await biz();
    await consent(b);
    expect((await loop.tick()).filter((x) => x.status === 'COMPLETED').length).toBeGreaterThanOrEqual(1);
    expect((await prisma.learningRun.findMany({ where: { businessId: b.owner.businessId } }))[0]).toMatchObject({ trigger: 'SCHEDULED' });
    expect((await loop.tick()).some((x) => x.businessId === b.owner.businessId)).toBe(false); // not due again yet
    const first = await prisma.learningRun.findFirstOrThrow({ where: { businessId: b.owner.businessId } });
    await prisma.learningRun.update({ where: { id: first.id }, data: { finishedAt: new Date(Date.now() - 20 * DAY) } });
    await run(b);
    const measured = await prisma.learningRun.findUniqueOrThrow({ where: { id: first.id } });
    expect(measured.outcome).toMatchObject({ status: expect.stringMatching(/MEASURED|INSUFFICIENT_DATA/) });
    expect(JSON.stringify(measured.outcome)).not.toMatch(/guarantee|improved because|thanks to/i);
  });

  it('DEMO: client A (AUTO) and client B (HYBRID): analysis, trends with limits, three improvements, two variants, preferences, decisions, dashboard data', async () => {
    const A = await biz();
    const B = await biz();
    // B has an unusual promotion among its products: HYBRID sends it to a person, AUTO may publish it.
    for (const c of [A, B]) {
      const promo = await prisma.product.create({ data: { businessId: c.owner.businessId, name: 'Weekend promo bissap', description: 'Special offer: 70% off this weekend only', price: '1000', currency: 'XAF', status: 'ACTIVE' } });
      await prisma.productMedia.create({ data: { productId: promo.id, mediaId: c.media.id } });
    }
    for (const [c, mode] of [[A, 'AUTO'], [B, 'HYBRID']] as const) {
      await consent(c);
      await publishingPolicy(c, mode);
      await L('put', 'preferences/tone', c.owner, { value: 'friendly' }).expect(200);
      await L('put', 'preferences/marketing.goals', c.owner, { value: ['engagement', 'awareness'] }).expect(200);
      await L('put', 'preferences/editorial.restrictions', c.owner, { value: ['giveaway'] }).expect(200);
      await L('put', 'settings', c.owner, { autoPlan: true }).expect(200);
    }
    // 1-3. Analysis, trends with their limits, three improvements.
    const ra = await run(A);
    expect(ra.status).toBe('COMPLETED');
    const recs = (await L('get', 'recommendations', A.owner).expect(200)).body;
    expect(recs.length).toBeGreaterThanOrEqual(3);
    for (const r of recs.slice(0, 3)) {
      expect(r.evidence.justification).toBeTruthy();
      expect(r.evidence.limitations.join(' ')).toMatch(/not proof|simulator/);
      expect(r.confidence).toBe('LOW');
    }
    const perf = (await L('get', 'performance', A.owner).expect(200)).body[0];
    expect(perf).toMatchObject({ evidence: 'SIMULATED', posts: 30 });
    expect((await L('get', 'performance/series', A.owner).expect(200)).body.length).toBeGreaterThanOrEqual(6);
    // 4. The client accepts the slot proposal: it guides the next drafts (inside the policy), nothing else.
    const slot = recs.find((r: { kind: string }) => r.kind === 'POSTING_SLOT');
    if (slot) await L('post', `recommendations/${slot.id}/decision`, A.owner, { decision: 'ACCEPT' }).expect(200);
    // 5. Two variants prepared (drafts only).
    const prep = (await L('post', 'experiments/prepare', A.owner, { hypothesis: 'Question openings get more engagement', platform: 'INSTAGRAM', base: { title: 'Fresh bissap today', caption: 'Brewed every morning with fresh flowers.', hashtags: ['#bissap'], mediaIds: [A.media.id] }, scheduledAtA: new Date(Date.now() + 10 * DAY).toISOString(), scheduledAtB: new Date(Date.now() + 11 * DAY).toISOString() }).expect(201)).body;
    expect(prep.experiment.biasFlags.map((f: { code: string }) => f.code)).toContain('NOT_RANDOMIZED');
    // 6. Preferences are stored in three separate layers.
    const prefs = (await L('get', 'preferences', A.owner).expect(200)).body;
    expect(prefs.declared.map((x: { key: string }) => x.key).sort()).toEqual(['editorial.restrictions', 'marketing.goals', 'tone']);
    expect(prefs.inferred.length).toBeGreaterThan(0);
    // 7. AUTO vs HYBRID decisions on the drafts the loop prepared.
    const rb = await run(B);
    expect(rb.status).toBe('COMPLETED');
    const dA = await prisma.publishingDecision.findMany({ where: { businessId: A.owner.businessId, automated: true } });
    const dB = await prisma.publishingDecision.findMany({ where: { businessId: B.owner.businessId } });
    expect(dA.length).toBeGreaterThan(0);
    expect(dA.every((d) => d.action === 'AUTO_SCHEDULED')).toBe(true);
    expect(dB.some((d) => d.action === 'SENT_TO_REVIEW')).toBe(true); // the unusual promotion waits for a person in HYBRID
    if (slot) {
      const planned = await prisma.calendarEvent.findMany({ where: { businessId: A.owner.businessId, id: { in: dA.map((d) => d.calendarEventId) } } });
      expect(planned.every((e) => e.scheduledAt.getUTCHours() === 18 || e.scheduledAt.getUTCHours() === 9)).toBe(true);
    }
    // Nothing real: all publications are the fictitious history, none new, no real network.
    expect(await prisma.publication.count({ where: { businessId: { in: [A.owner.businessId, B.owner.businessId] }, simulated: false } })).toBe(0);
    expect(await prisma.publication.count({ where: { businessId: A.owner.businessId } })).toBe(30);
    // 8. Dashboard data: runs, quality, estimated cost, real-vs-simulated label.
    expect((await L('get', 'runs', A.owner).expect(200)).body[0].costEstimate).toMatchObject({ aiCostMicros: 0 });
    expect((await L('get', 'profile', A.owner).expect(200)).body).toMatchObject({ simulated: true, analyticsProvider: 'mock' });
    expect((await L('get', 'analytics-capabilities', A.owner).expect(200)).body.platforms.TIKTOK.metrics.saves).toBe('UNVERIFIED');
  });
});
