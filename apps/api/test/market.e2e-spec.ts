import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';

/** Market intelligence, first slice: provenance, duplicates, freshness, deterministic profitability and score, isolation, RBAC, quotas. */
describe('Market intelligence (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let h: ReturnType<typeof aiHelpers>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
    h = aiHelpers(app);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000).toISOString();
  const word = () => randomUUID().replace(/-/g, '').slice(0, 8);
  /** A fully evidenced record (supplier paid in CNY, sold in USD). */
  const rec = (over: Record<string, unknown> = {}) => ({
    name: `Item ${word()}`, category: 'Beverages', country: 'TD', supplierName: 'Acme Foods', sourceUrl: `https://supplier.example.com/p/${word()}`, sourceName: 'Supplier catalog', observedAt: daysAgo(3),
    costCurrency: 'CNY', unitCost: '20.00', shippingCost: '5.00', sellingCurrency: 'USD', sellingPrice: '49.90', estimatedDeliveryDays: 12,
    supplierRating: '4.50', supplierRatingSource: 'Marketplace profile', monthlySearches: 12000, demandSource: 'Keyword tool export', competitorCount: 22, competitorSource: 'Manual count of listings', ...over,
  });
  const ASSUME = { paymentFeePercent: '2.9', paymentFixedFee: '0.30', returnsAllowancePercent: '5', advertisingCostPerAcquisition: '12.00', fx: { source: 'Bank rate sheet', asOf: '2026-11-12', rates: { CNY: '0.14' } } };
  const imp = (c: Ctx, body: unknown = rec()) => request(http).post('/api/v1/market/products').set(as(c)).send(body as object);
  const analyze = (c: Ctx, id: string, assumptions: unknown = ASSUME) => request(http).post(`/api/v1/market/products/${id}/analyses`).set(as(c)).send({ assumptions });
  const list = (c: Ctx, qs = '') => request(http).get(`/api/v1/market/products${qs}`).set(as(c));

  describe('access control and isolation', () => {
    it('lets every member read, editors and above import and analyze, and nobody else in', async () => {
      const t = await h.tenant('Café Awa');
      await request(http).get('/api/v1/market/products').expect(401);
      await request(http).post('/api/v1/market/products').send(rec()).expect(401);
      const outsider = await register(app);
      await list({ token: outsider.accessToken, businessId: t.businessId }).expect(404);
      const viewer = await h.member(t, 'VIEWER');
      const editor = await h.member(t, 'EDITOR');
      await imp(viewer).expect(403);
      const created = (await imp(editor).expect(201)).body;
      await analyze(viewer, created.id).expect(403);
      await analyze(editor, created.id).expect(201);
      expect((await list(viewer).expect(200)).body.total).toBe(1);
      await request(http).get(`/api/v1/market/products/${created.id}`).set(as(viewer)).expect(200);
      await request(http).get(`/api/v1/market/products/${created.id}/analyses`).set(as(viewer)).expect(200);
    });

    it('never shows, analyzes or counts another business\'s research', async () => {
      const a = await h.tenant('Café A');
      const b = await h.tenant('Café B');
      const p = (await imp(a).expect(201)).body;
      await analyze(a, p.id).expect(201);
      await request(http).get(`/api/v1/market/products/${p.id}`).set(as(b)).expect(404);
      await request(http).get(`/api/v1/market/products/${p.id}/analyses`).set(as(b)).expect(404);
      await analyze(b, p.id).expect(404);
      expect((await list(b).expect(200)).body.total).toBe(0);
      expect((await list(a).expect(200)).body.total).toBe(1);
      await request(http).get(`/api/v1/market/products/${p.id}`).set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId }).expect(404);
      // The same product can be researched by both businesses independently.
      const same = rec({ name: p.name, sourceUrl: p.source.url, supplierName: p.supplierName });
      await imp(b, same).expect(201);
      expect(await prisma.marketAnalysis.count({ where: { businessId: b.businessId } })).toBe(0);
    });
  });

  describe('import and provenance', () => {
    it('stores the record with its source and observation date, and shows how fresh it is', async () => {
      const t = await h.tenant('Café Awa');
      const body = rec({ observedAt: daysAgo(20), sourceUrl: 'https://Supplier.example.com/p/777/?utm_source=ad&ref=x', sourceName: 'Supplier PDF, page 4' });
      const res = (await imp(t, body).expect(201)).body;
      expect(res).toMatchObject({ source: { type: 'MANUAL', name: 'Supplier PDF, page 4' }, observedAt: body.observedAt, freshness: { days: 20, level: 'RECENT' }, unitCost: '20.00', sellingPrice: '49.90', supplierRating: '4.50', country: 'TD', latestAnalysis: null });
      expect(res.possibleDuplicates).toEqual([]);
      const row = await prisma.marketProduct.findUniqueOrThrow({ where: { id: res.id } });
      expect(row.observedAt.toISOString()).toBe(body.observedAt);
      expect(row.sourceUrlKey).toBe('https://supplier.example.com/p/777');
      expect(row.createdAt.getTime()).toBeGreaterThan(row.observedAt.getTime()); // the figures' date and the import date are different things
      const audit = await prisma.auditLog.findMany({ where: { entityId: res.id } });
      expect(audit.map((x) => x.action)).toEqual(['market.product_imported']);
      expect(JSON.stringify(audit)).not.toContain('supplier.example.com');
    });

    it('accepts a record with only the essentials and keeps everything else unknown (null, never zero)', async () => {
      const t = await h.tenant('Café Awa');
      const res = (await imp(t, { name: 'Bare product', country: 'FR', sourceUrl: 'https://shop.example.com/x', observedAt: daysAgo(1), costCurrency: 'EUR', sellingCurrency: 'EUR' }).expect(201)).body;
      for (const k of ['unitCost', 'shippingCost', 'sellingPrice', 'estimatedDeliveryDays', 'supplierRating', 'monthlySearches', 'competitorCount', 'supplierName', 'category']) expect(res[k]).toBeNull();
    });

    it('refuses bad sources, dates, money, ratings and unsourced evidence', async () => {
      const t = await h.tenant('Café Awa');
      const bad: Array<[string, Record<string, unknown>]> = [
        ['javascript url', { sourceUrl: 'javascript:alert(1)' }], ['ftp url', { sourceUrl: 'ftp://files.example.com/x' }], ['credentials in url', { sourceUrl: 'https://user:pass@shop.example.com/x' }],
        ['no dot host', { sourceUrl: 'http://localhost/x' }], ['not a url', { sourceUrl: 'hello' }], ['future date', { observedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }], ['not a date', { observedAt: 'yesterday' }],
        ['money as number', { unitCost: 20 }], ['money 3 decimals', { sellingPrice: '1.234' }], ['negative money', { shippingCost: '-1.00' }], ['lowercase currency', { costCurrency: 'cny' }], ['lowercase country', { country: 'td' }],
        ['rating above 5', { supplierRating: '5.5' }], ['rating without source', { supplierRatingSource: undefined }], ['searches without source', { demandSource: undefined }], ['competitors without source', { competitorSource: undefined }],
        ['delivery 0', { estimatedDeliveryDays: 0 }], ['float searches', { monthlySearches: 10.5 }], ['name of symbols', { name: '!!!' }], ['unknown field', { surprise: 'x' }], ['empty name', { name: '' }],
      ];
      for (const [label, over] of bad) {
        const r = await imp(t, rec(over));
        expect([label, r.status]).toEqual([label, 400]);
      }
      expect(await prisma.marketProduct.count({ where: { businessId: t.businessId } })).toBe(0);
    });
  });

  describe('duplicate detection', () => {
    it('refuses the same product (any word order, case, accents) for the same market and supplier, and the same source page', async () => {
      const t = await h.tenant('Café Awa');
      const first = (await imp(t, rec({ name: 'Café Filtre Bissap 500ml', sourceUrl: 'https://supplier.example.com/p/1' })).expect(201)).body;
      const dup = await imp(t, rec({ name: '500ML  bissap, FILTRE cafe', sourceUrl: 'https://supplier.example.com/p/2' })).expect(409);
      expect(dup.body).toMatchObject({ code: 'DUPLICATE_PRODUCT', existingId: first.id });
      const sameUrl = await imp(t, rec({ name: 'Totally other name', sourceUrl: 'https://SUPPLIER.example.com/p/1/?utm_campaign=z' })).expect(409);
      expect(sameUrl.body).toMatchObject({ code: 'DUPLICATE_SOURCE_URL', existingId: first.id });
      // Another market or another supplier is another research item.
      await imp(t, rec({ name: 'Café Filtre Bissap 500ml', country: 'FR' })).expect(201);
      await imp(t, rec({ name: 'Café Filtre Bissap 500ml', supplierName: 'Other Foods' })).expect(201);
      expect(await prisma.marketProduct.count({ where: { businessId: t.businessId } })).toBe(3);
    });

    it('reports near duplicates without blocking them, and only within the same market', async () => {
      const t = await h.tenant('Café Awa');
      const first = (await imp(t, rec({ name: 'Wireless Bluetooth Earbuds Pro' })).expect(201)).body;
      const near = (await imp(t, rec({ name: 'Bluetooth Wireless Earbuds', supplierName: 'Other' })).expect(201)).body;
      expect(near.possibleDuplicates).toEqual([{ id: first.id, name: 'Wireless Bluetooth Earbuds Pro', similarity: 0.75 }]);
      const otherMarket = (await imp(t, rec({ name: 'Wireless Bluetooth Earbuds Pro Max', country: 'FR' })).expect(201)).body;
      expect(otherMarket.possibleDuplicates).toEqual([]);
    });

    it('creates one record when the same import is sent several times at once', async () => {
      const t = await h.tenant('Café Awa');
      const body = rec({ name: 'Raced product' });
      const results = await Promise.all(Array.from({ length: 5 }, () => imp(t, body)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => ['DUPLICATE_PRODUCT', 'DUPLICATE_SOURCE_URL'].includes(r.body.code))).toBe(true);
      expect(await prisma.marketProduct.count({ where: { businessId: t.businessId } })).toBe(1);
    });
  });

  describe('profitability and score', () => {
    it('computes profitability with the supplied exchange rate and an explainable score', async () => {
      const t = await h.tenant('Café Awa');
      const p = (await imp(t).expect(201)).body;
      const a = (await analyze(t, p.id).expect(201)).body;
      expect(a.profitability).toMatchObject({
        currency: 'USD', revenue: { amount: '49.90' }, acquisitionCost: { amount: '2.80' }, shippingCost: { amount: '0.70' }, paymentFees: { amount: '1.75' }, returnsAllowance: { amount: '2.50' },
        contributionBeforeAds: { amount: '42.15' }, advertisingCost: { amount: '12.00' }, contributionAfterAds: { amount: '30.15' }, marginPercent: { amount: '60.42' }, breakEvenAdCost: { amount: '42.15' }, missing: [],
        fx: { used: [{ currency: 'CNY', rate: '0.14' }], source: 'Bank rate sheet', asOf: '2026-11-12' },
      });
      expect(a.score).toMatchObject({ score: 83, verdict: 'PROMISING', coverage: 100, confidence: 'HIGH', modelVersion: '1' });
      expect(a.score.components.map((c: { key: string; points: number }) => [c.key, c.points])).toEqual([['demand', 80], ['margin', 100], ['competition', 45], ['supplier', 90], ['shipping', 75], ['quality', 100]]);
      expect(a.score.components.every((c: { evidence: string }) => c.evidence.length > 0)).toBe(true);
      expect(a.quality.freshness.level).toBe('FRESH');
      expect(a.assumptions).toEqual(ASSUME); // the assumptions used are kept with the result
      const got = (await request(http).get(`/api/v1/market/products/${p.id}`).set(as(t)).expect(200)).body;
      expect(got.latestAnalysis.id).toBe(a.id);
    });

    it('gives the same result for the same inputs, and keeps each run as history, newest first', async () => {
      const t = await h.tenant('Café Awa');
      const p = (await imp(t).expect(201)).body;
      const first = (await analyze(t, p.id).expect(201)).body;
      const second = (await analyze(t, p.id).expect(201)).body;
      for (const k of ['profitability', 'score', 'quality', 'assumptions', 'modelVersion']) expect(second[k]).toEqual(first[k]);
      expect(second.id).not.toBe(first.id);
      const cheaper = (await analyze(t, p.id, { ...ASSUME, advertisingCostPerAcquisition: '30.00' }).expect(201)).body;
      expect(cheaper.profitability.contributionAfterAds.amount).toBe('12.15');
      const hist = (await request(http).get(`/api/v1/market/products/${p.id}/analyses`).set(as(t)).expect(200)).body;
      expect(hist.items.map((x: { id: string }) => x.id)).toEqual([cheaper.id, second.id, first.id]);
      expect(hist.total).toBe(3);
    });

    it('reports UNKNOWN instead of inventing figures, and shows no score without enough evidence', async () => {
      const t = await h.tenant('Café Awa');
      const sparse = (await imp(t, { name: 'Sparse', country: 'TD', sourceUrl: 'https://shop.example.com/sparse', observedAt: daysAgo(40), costCurrency: 'USD', sellingCurrency: 'USD', unitCost: '10.00', sellingPrice: '30.00' }).expect(201)).body;
      const a = (await analyze(t, sparse.id, {}).expect(201)).body;
      expect(a.score).toMatchObject({ score: null, verdict: 'INSUFFICIENT_EVIDENCE', coverage: 10, confidence: 'LOW' });
      expect(a.score.flags).toContain('STALE_DATA');
      for (const k of ['shippingCost', 'paymentFees', 'returnsAllowance', 'advertisingCost', 'contributionBeforeAds', 'contributionAfterAds', 'marginPercent', 'breakEvenAdCost']) {
        expect(a.profitability[k]).toMatchObject({ status: 'UNKNOWN', amount: null });
      }
      expect(a.score.components.filter((c: { status: string }) => c.status === 'UNKNOWN').every((c: { points: number | null }) => c.points === null)).toBe(true);
      // No exchange rate: the converted lines are UNKNOWN, not guessed.
      const p = (await imp(t).expect(201)).body;
      const noFx = (await analyze(t, p.id, { ...ASSUME, fx: undefined }).expect(201)).body;
      expect(noFx.profitability.acquisitionCost).toMatchObject({ status: 'UNKNOWN', note: 'no exchange rate CNY→USD was supplied' });
      expect(noFx.score.components.find((c: { key: string }) => c.key === 'margin')).toMatchObject({ status: 'UNKNOWN', points: null });
    });

    it('refuses malformed assumptions and stores nothing', async () => {
      const t = await h.tenant('Café Awa');
      const p = (await imp(t).expect(201)).body;
      const bad: unknown[] = [
        { paymentFeePercent: 2.9 }, { paymentFeePercent: '101' }, { returnsAllowancePercent: '-1' }, { advertisingCostPerAcquisition: '1.234' }, { surprise: '1' },
        { fx: { source: 'x', asOf: '2026-11-12', rates: { CNY: '0.14' } } }, { fx: { source: 'Rate sheet', asOf: 'today', rates: { CNY: '0.14' } } }, { fx: { source: 'Rate sheet', asOf: '2026-11-12', rates: { cny: '0.14' } } },
        { fx: { source: 'Rate sheet', asOf: '2026-11-12', rates: { CNY: '0' } } }, { fx: { source: 'Rate sheet', asOf: '2026-11-12', rates: {}, extra: 1 } }, 'text', [],
      ];
      for (const assumptions of bad) expect([JSON.stringify(assumptions), (await analyze(t, p.id, assumptions)).status]).toEqual([JSON.stringify(assumptions), 400]);
      await request(http).post(`/api/v1/market/products/${p.id}/analyses`).set(as(t)).send({}).expect(400);
      expect(await prisma.marketAnalysis.count({ where: { productId: p.id } })).toBe(0);
    });
  });

  describe('freshness and filters', () => {
    it('labels data age with exact limits and filters by freshness, market, category and name', async () => {
      const t = await h.tenant('Café Awa');
      const ids: Record<string, string> = {};
      for (const [label, age, extra] of [['fresh', 3, {}], ['recent', 20, { country: 'FR', category: 'Gadgets' }], ['stale', 60, { category: 'Gadgets' }], ['outdated', 200, { name: 'Ancient lamp' }]] as const) {
        ids[label] = (await imp(t, rec({ observedAt: daysAgo(age), ...extra })).expect(201)).body.id;
      }
      const all = (await list(t).expect(200)).body.items as Array<{ id: string; freshness: { level: string } }>;
      expect(Object.fromEntries(all.map((x) => [x.id, x.freshness.level]))).toEqual({ [ids.fresh!]: 'FRESH', [ids.recent!]: 'RECENT', [ids.stale!]: 'STALE', [ids.outdated!]: 'OUTDATED' });
      const only = async (qs: string) => (await list(t, qs).expect(200)).body.items.map((x: { id: string }) => x.id).sort();
      expect(await only('?freshness=FRESH')).toEqual([ids.fresh]);
      expect(await only('?freshness=RECENT')).toEqual([ids.recent]);
      expect(await only('?freshness=STALE')).toEqual([ids.stale]);
      expect(await only('?freshness=OUTDATED')).toEqual([ids.outdated]);
      expect(await only('?country=FR')).toEqual([ids.recent]);
      expect(await only('?category=gadgets')).toEqual([ids.recent, ids.stale].sort());
      expect(await only('?q=ancient')).toEqual([ids.outdated]);
      expect(await only('?category=gadgets&freshness=STALE')).toEqual([ids.stale]);
      await list(t, '?freshness=OLD').expect(400);
      await list(t, '?country=france').expect(400);
      expect((await list(t, '?pageSize=2&page=2').expect(200)).body).toMatchObject({ total: 4, pageSize: 2, items: expect.any(Array) });
    });

    it('measures the boundary days exactly', async () => {
      const t = await h.tenant('Café Awa');
      const level = async (age: number) => (await imp(t, rec({ observedAt: daysAgo(age) })).expect(201)).body.freshness;
      expect(await level(7)).toMatchObject({ days: 7, level: 'FRESH' });
      expect(await level(8)).toMatchObject({ days: 8, level: 'RECENT' });
      expect(await level(30)).toMatchObject({ days: 30, level: 'RECENT' });
      expect(await level(31)).toMatchObject({ days: 31, level: 'STALE' });
    });
  });

  describe('quotas', () => {
    it('limits researched products and analyses per business', async () => {
      const t = await h.tenant('Café Awa');
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push((await imp(t).expect(201)).body.id);
      expect((await imp(t).expect(429)).body.code).toBe('MARKET_LIMIT_REACHED');
      for (let i = 0; i < 6; i++) await analyze(t, ids[0]!).expect(201);
      expect((await analyze(t, ids[1]!).expect(429)).body.code).toBe('MARKET_ANALYSIS_LIMIT');
      const other = await h.tenant('Café B');
      await imp(other).expect(201); // quotas are per business
    });
  });
});
