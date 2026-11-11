import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { fakeDefaultAnswer, type FakeTextProvider } from '@touma/ai-engine';
import { addDays, diffDays, utcToZoned } from '@touma/shared';
import { TEXT_PROVIDER } from '../src/ai/ai-provider';
import { as, type Ctx } from './ai-helpers';
import { calendarHelpers } from './calendar-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * AI 30-day marketing plans through the TOUMA AI pipeline (background job, grounding, usage limits). Real PostgreSQL,
 * Redis and BullMQ; only the AI provider is the TEST-ONLY deterministic one.
 */
describe('Calendar: AI content plan (e2e)', () => {
  let app: INestApplication;
  let fake: FakeTextProvider;
  let h: ReturnType<typeof calendarHelpers>;
  let owner: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['tenant']>>;
  let editor: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['member']>>;
  let viewer: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['member']>>;
  let other: Awaited<ReturnType<ReturnType<typeof calendarHelpers>['tenant']>>;
  const tz = 'Africa/Ndjamena';

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    fake = app.get(TEXT_PROVIDER);
    h = calendarHelpers(app);
    owner = await h.tenant('Café Awa');
    editor = await h.member(owner, 'EDITOR');
    viewer = await h.member(owner, 'VIEWER');
    other = await h.tenant('Other Shop');
    await h.setTimezone(owner, tz);
  });
  beforeEach(() => fake.reset());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const submit = (c: Ctx, body: Record<string, unknown> = {}) =>
    request(h.http).post('/api/v1/calendar/plans').set(as(c)).send({ startDate: h.day(3, tz), days: 30, postsPerWeek: 5, platforms: ['INSTAGRAM', 'FACEBOOK'], language: 'en', ...body });
  const preview = (c: Ctx, id: string) => request(h.http).get(`/api/v1/calendar/plans/${id}`).set(as(c));
  const apply = (c: Ctx, id: string, body: Record<string, unknown> = {}) => request(h.http).post(`/api/v1/calendar/plans/${id}/apply`).set(as(c)).send(body);

  it('generates a balanced 30-day plan in the background and previews it with proposed times', async () => {
    const start = h.day(3, tz);
    const occasions = [{ date: addDays(start, 9), name: 'Opening anniversary' }, { date: addDays(start, 20), name: 'Customer appreciation day' }];
    const res = await submit(owner, { occasions }).expect(202);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.task).toBe('CONTENT_PLAN');
    const done = (await h.settled(owner, res.body.id)).body;
    expect([done.status, done.errorMessage]).toEqual(['SUCCEEDED', null]);
    const p = (await preview(owner, res.body.id).expect(200)).body;

    const target = Math.round((5 * 30) / 7);
    expect(p.items.length).toBeGreaterThanOrEqual(target);
    expect(p.items.length).toBeLessThanOrEqual(target + 4);
    // A balanced mix, not one pillar.
    const nonSeasonal = Object.entries(p.balance as Record<string, number>).filter(([k]) => k !== 'SEASONAL');
    expect(nonSeasonal.length).toBeGreaterThanOrEqual(4);
    const total = nonSeasonal.reduce((a, [, n]) => a + n, 0);
    for (const [, n] of nonSeasonal) expect(n / total).toBeLessThanOrEqual(0.5);
    // Seasonal posts exist only for the occasions the merchant supplied, on their exact days.
    const seasonal = p.items.filter((i: { pillar: string }) => i.pillar === 'SEASONAL');
    expect(seasonal.map((i: { occasion: string }) => i.occasion).sort()).toEqual(['Customer appreciation day', 'Opening anniversary']);
    for (const s of seasonal) expect(s.day).toBe(diffDays(start, occasions.find((o) => o.name === s.occasion)!.date) + 1);
    // Posts are about the business's own products and services.
    const catalog = new Set([owner.productId, owner.serviceId]);
    expect(p.items.filter((i: { itemId: string | null }) => i.itemId).every((i: { itemId: string }) => catalog.has(i.itemId))).toBe(true);
    // Proposed times: in the business timezone, in the future, labelled as estimates (no audience data exists).
    for (const i of p.items) {
      expect(i.proposed.source).toBe('ESTIMATE');
      expect(i.proposed.note).toMatch(/not your audience data/i);
      expect(new Date(i.proposed.scheduledAt).getTime()).toBeGreaterThan(Date.now());
      expect(utcToZoned(new Date(i.proposed.scheduledAt), tz).date).toBe(i.proposed.date);
    }
    expect(p.timezone).toBe(tz);
    expect(p.appliedPlanId).toBeNull();
    // The planner was told the occasions and the real dates; nothing about holidays was supplied by us.
    const req = fake.requests.find((r) => r.user.includes('"CONTENT_PLAN"'))!;
    expect(req.user).toContain('Opening anniversary');
    expect(req.system).toMatch(/NO seasonal posts|Never mention any other holiday/);
    expect(req.user).toContain(`"startDate": "${start}"`);
    expect(req.user).toMatch(/"connectedPlatforms":\s*\[\]/); // no connected accounts yet
  });

  it('puts the plan on the calendar as drafts that still need approval, once', async () => {
    const start = h.day(40, tz);
    const gen = (await submit(owner, { startDate: start, days: 14, postsPerWeek: 4, occasions: [{ date: addDays(start, 5), name: 'Opening anniversary' }] }).expect(202)).body;
    await h.settled(owner, gen.id);
    const before = await prisma.calendarEvent.count({ where: { businessId: owner.businessId } });
    expect(before).toBe(await prisma.calendarEvent.count({ where: { businessId: owner.businessId } })); // preview creates nothing
    await preview(owner, gen.id).expect(200);
    expect(await prisma.calendarEvent.count({ where: { businessId: owner.businessId } })).toBe(before);

    await apply(viewer, gen.id).expect(403);
    const applied = (await apply(editor, gen.id, { skip: [0] }).expect(201)).body;
    expect(applied.created).toBeGreaterThan(5);
    expect(applied.skipped).toBe(1);
    const rows = await prisma.calendarEvent.findMany({ where: { planId: applied.planId }, include: { content: true } });
    expect(rows).toHaveLength(applied.created);
    for (const r of rows) {
      expect(r.content?.status).toBe('DRAFT'); // nothing is approved or scheduled automatically
      expect(r.content?.origin).toBe('AI_ASSISTED');
      expect(r.authorizedAt).toBeNull();
      expect(r.dispatchState).toBe('NONE');
      expect(r.timeSource).toBe('ESTIMATE');
      expect(r.timezone).toBe(tz);
      expect(r.platform).toBeTruthy();
    }
    expect(rows.some((r) => r.pillar === 'SEASONAL' && r.occasion === 'Opening anniversary')).toBe(true);
    // No two plan posts collide on one platform.
    const list = (await h.list(owner, start, addDays(start, 13)).expect(200)).body;
    expect(list.conflicts.filter((c: { code: string }) => c.code === 'SLOT_TOO_CLOSE')).toEqual([]);

    const again = await apply(owner, gen.id).expect(409);
    expect(again.body.code).toBe('PLAN_ALREADY_APPLIED');
    expect(again.body.planId).toBe(applied.planId);
    expect((await preview(owner, gen.id).expect(200)).body.appliedPlanId).toBe(applied.planId);
    const plans = (await request(h.http).get('/api/v1/calendar/plans/applied').set(as(owner)).expect(200)).body.items;
    expect(plans[0]).toMatchObject({ id: applied.planId, generationId: gen.id });
  });

  it('applies a plan exactly once when two people apply it at the same time', async () => {
    const start = h.day(60, tz);
    const gen = (await submit(owner, { startDate: start, days: 7, postsPerWeek: 3 }).expect(202)).body;
    await h.settled(owner, gen.id);
    const results = await Promise.all([apply(owner, gen.id), apply(editor, gen.id), apply(owner, gen.id)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.contentPlan.count({ where: { generationId: gen.id } })).toBe(1);
    const created = results.find((r) => r.status === 201)!.body.created;
    expect(await prisma.calendarEvent.count({ where: { plan: { generationId: gen.id } } })).toBe(created);
  });

  it('creates no seasonal posts when the merchant supplied no occasions', async () => {
    const gen = (await submit(owner, { startDate: h.day(80, tz), days: 14 }).expect(202)).body;
    await h.settled(owner, gen.id);
    const p = (await preview(owner, gen.id).expect(200)).body;
    expect(p.items.some((i: { pillar: string }) => i.pillar === 'SEASONAL')).toBe(false);
    expect(fake.requests.at(-1)!.user).toMatch(/"occasions":\s*\[\]/);
  });

  it('rejects a model answer that invents a holiday, a promotion or a product, and puts nothing on the calendar', async () => {
    const tamper = (edit: (plan: { items: Array<Record<string, unknown>> }) => void) => (req: Parameters<typeof fakeDefaultAnswer>[0]) => {
      const plan = fakeDefaultAnswer(req) as unknown as { items: Array<Record<string, unknown>> };
      edit(plan);
      return JSON.stringify(plan);
    };
    const cases: Array<[string, (p: { items: Array<Record<string, unknown>> }) => void, RegExp]> = [
      ['holiday', (p) => { p.items[1]!.brief = 'Celebrate Ramadan with a special table for the whole family.'; }, /Ramadan|ramadan/],
      ['promotion', (p) => { p.items[2]!.title = 'Half price weekend: 50% off everything'; }, /promotion or discount/],
      ['seasonal post without an occasion', (p) => { p.items[3] = { ...p.items[3]!, pillar: 'SEASONAL', occasion: 'Summer festival' }; }, /SEASONAL post must use one of the occasions/],
      ['unknown product', (p) => { p.items[0] = { ...p.items[0]!, pillar: 'PRODUCT_SHOWCASE', itemType: 'PRODUCT', itemId: 'cnotarealproduct00000000' }; }, /not an active product or service/],
    ];
    for (const [name, edit, pattern] of cases) {
      fake.reset();
      fake.enqueue(tamper(edit), tamper(edit), tamper(edit), tamper(edit), tamper(edit), tamper(edit));
      const before = await prisma.calendarEvent.count({ where: { businessId: owner.businessId } });
      const gen = (await submit(owner, { startDate: h.day(100, tz), days: 14 }).expect(202)).body;
      const res = (await h.settled(owner, gen.id)).body;
      expect([name, res.status]).toEqual([name, 'FAILED']);
      expect(res.errorCode).toBe('AI_INVALID_OUTPUT');
      expect(res.errorMessage).toMatch(pattern);
      await preview(owner, gen.id).expect(409); // not finished successfully
      await apply(owner, gen.id).expect(409);
      expect(await prisma.calendarEvent.count({ where: { businessId: owner.businessId } })).toBe(before);
    }
  });

  it('validates the request', async () => {
    await submit(owner, { startDate: addDays(h.day(0, tz), -1) }).expect(400); // past
    await submit(owner, { startDate: '2026-02-30' }).expect(400);
    await submit(owner, { days: 31 }).expect(400);
    await submit(owner, { days: 3 }).expect(400);
    await submit(owner, { postsPerWeek: 0 }).expect(400);
    await submit(owner, { platforms: [] }).expect(400);
    await submit(owner, { platforms: ['MYSPACE'] }).expect(400);
    await submit(owner, { occasions: [{ date: addDays(h.day(3, tz), 40), name: 'Too far' }] }).expect(400);
    await submit(owner, { occasions: [{ date: h.day(5, tz), name: 'Twice' }, { date: h.day(6, tz), name: 'twice' }] }).expect(400);
    await submit(owner, { occasions: [{ date: 'nope', name: 'Bad date' }] }).expect(400);
    await submit(viewer).expect(403);
  });

  it('keeps plans private to their business', async () => {
    const gen = (await submit(owner, { startDate: h.day(120, tz), days: 7, postsPerWeek: 3 }).expect(202)).body;
    await h.settled(owner, gen.id);
    await preview(other, gen.id).expect(404);
    await apply(other, gen.id).expect(404);
    const theirs = (await request(h.http).get('/api/v1/calendar/plans').set(as(other)).expect(200)).body;
    expect(theirs.items.map((g: { id: string }) => g.id)).not.toContain(gen.id);
    const mine = (await request(h.http).get('/api/v1/calendar/plans').set(as(owner)).expect(200)).body;
    expect(mine.items.map((g: { id: string }) => g.id)).toContain(gen.id);
    // Their own plan uses their own timezone and data, never ours.
    await h.setTimezone(other, 'America/New_York');
    const g2 = (await submit(other, { startDate: h.day(5, 'America/New_York'), days: 7, postsPerWeek: 3 }).expect(202)).body;
    await h.settled(other, g2.id);
    const p2 = (await preview(other, g2.id).expect(200)).body;
    expect(p2.timezone).toBe('America/New_York');
    expect(JSON.stringify(p2)).not.toContain(owner.productId);
  });

  it('uses the connected platforms and the brand kit it is given, and counts toward AI usage', async () => {
    await prisma.socialAccount.create({ data: { businessId: owner.businessId, platform: 'INSTAGRAM', externalAccountId: 'plan-acc', accessTokenEnc: 'x', status: 'CONNECTED' } });
    await request(h.http).put('/api/v1/creative/brand-kit').set(as(owner)).send({ visualStyle: 'NATURAL', guidelines: 'Always show the product' }).expect(200);
    const gen = (await submit(owner, { startDate: h.day(130, tz), days: 7, postsPerWeek: 3 }).expect(202)).body;
    const res = (await h.settled(owner, gen.id)).body;
    expect(res.status).toBe('SUCCEEDED');
    const req = fake.requests.find((r) => r.user.includes('"CONTENT_PLAN"'))!;
    expect(req.user).toMatch(/"connectedPlatforms":\s*\[\s*"INSTAGRAM"\s*\]/);
    expect(req.user).toContain('Always show the product');
    const usage = await prisma.aIUsage.findMany({ where: { generationId: gen.id } });
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.agent === 'SCHEDULER' || u.agent === 'BUSINESS_ANALYST')).toBe(true);
    expect(usage.some((u) => u.agent === 'SCHEDULER')).toBe(true);
  });
});
