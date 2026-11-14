import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { FakeTextProvider } from '@touma/ai-engine';
import { TEXT_PROVIDER } from '../src/ai/ai-provider';
import { aiHelpers, as } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Diagnostic suite for "analysis and description generation do not work": the whole path API → queue → worker → (mock) provider → stored
 * result, for the situations a new merchant is really in. Real PostgreSQL, Redis and BullMQ; only the AI provider is the TEST-ONLY one.
 */
describe('AI analysis and description generation, as a merchant experiences it (e2e)', () => {
  let app: INestApplication;
  let fake: FakeTextProvider;
  let h: ReturnType<typeof aiHelpers>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    fake = app.get(TEXT_PROVIDER);
    h = aiHelpers(app);
  });
  beforeEach(() => fake.reset());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const run = async (path: string, c: Parameters<typeof as>[0], body: Record<string, unknown>) => {
    const accepted = await request(h.http).post(`/api/v1/ai/${path}`).set(as(c)).send(body).expect(202);
    return (await h.settled(c, accepted.body.id)).body;
  };

  it('business analysis, product analysis and marketing strategy complete for a business with an active product', async () => {
    const t = await h.tenant();
    expect(await run('business-analysis', t, { language: 'en' })).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    const pa = await run('product-analysis', t, { language: 'en', itemType: 'PRODUCT', itemId: t.productId });
    expect(pa).toMatchObject({ status: 'SUCCEEDED' });
    expect(pa.output.summary).toBeTruthy();
    const st = await run('marketing-strategy', t, { language: 'en', platforms: ['INSTAGRAM'] });
    expect(st).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('generates a product DESCRIPTION for an active product, citing the product as its source', async () => {
    const t = await h.tenant();
    const g = await run('content', t, { format: 'PRODUCT_DESCRIPTION', purpose: 'PROMOTIONAL', tone: 'FRIENDLY', language: 'en', itemType: 'PRODUCT', itemId: t.productId });
    expect(g).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    expect(g.output.format).toBe('PRODUCT_DESCRIPTION');
    expect(g.output.description.length).toBeGreaterThan(20);
    expect(g.output.claims.some((c: { source: string }) => c.source === `product:${t.productId}`)).toBe(true);
    expect(g.output.hashtags).toEqual([]);
  });

  it('REGRESSION: a business with no active product or service can still generate (it failed with "duplicate hashtags")', async () => {
    const t = await h.tenant();
    await prisma.product.updateMany({ where: { businessId: t.businessId }, data: { status: 'DRAFT' } });
    await prisma.service.updateMany({ where: { businessId: t.businessId }, data: { status: 'DRAFT' } });
    for (const format of ['INSTAGRAM_CAPTION', 'FACEBOOK_PROMOTIONAL_POST', 'TIKTOK_VIDEO_SCRIPT', 'PRODUCT_DESCRIPTION']) {
      const g = await run('content', t, { format, purpose: 'PROMOTIONAL', tone: 'FRIENDLY', language: 'en' });
      expect({ format, status: g.status, errorCode: g.errorCode }).toEqual({ format, status: 'SUCCEEDED', errorCode: null });
    }
  });

  it('a DRAFT product is refused with a clear code, and works once the merchant activates it', async () => {
    const t = await h.tenant();
    const draft = (await request(h.http).post('/api/v1/products').set(as(t)).send({ name: 'Draft hat', price: '4500' }).expect(201)).body;
    expect(draft.status).toBe('DRAFT'); // new products start as drafts
    const refused = await request(h.http).post('/api/v1/ai/product-analysis').set(as(t)).send({ language: 'en', itemType: 'PRODUCT', itemId: draft.id });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('ITEM_NOT_ACTIVE');
    expect(refused.body.message).toMatch(/Activate it first/);
    await request(h.http).patch(`/api/v1/products/${draft.id}`).set(as(t)).send({ status: 'ACTIVE' }).expect(200);
    expect(await run('product-analysis', t, { language: 'en', itemType: 'PRODUCT', itemId: draft.id })).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('does not need a verified e-mail address, but does need the right role', async () => {
    const t = await h.tenant();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: t.userEmail } });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    expect(await run('business-analysis', t, { language: 'en' })).toMatchObject({ status: 'SUCCEEDED' });
    const viewer = await h.member(t, 'VIEWER');
    expect((await h.submitAnalysis(viewer)).status).toBe(403);
    expect((await h.submitContent(viewer)).status).toBe(403);
    const editor = await h.member(t, 'EDITOR');
    expect((await h.submitContent(editor)).status).toBe(202);
  });

  it('tells the merchant clearly when AI is not configured, without leaking configuration', async () => {
    const t = await h.tenant();
    fake.configured = false;
    const res = await h.submitAnalysis(t);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|api[_-]?key|secret|password/i);
    const status = (await request(h.http).get('/api/v1/ai/status').set(as(t)).expect(200)).body;
    expect(status.configured).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/sk-|api[_-]?key/i);
  });

  it('a provider that repeats a hashtag in another case does not fail the generation', async () => {
    const t = await h.tenant();
    const ok = await run('content', t, { format: 'INSTAGRAM_CAPTION', purpose: 'PROMOTIONAL', tone: 'FRIENDLY', language: 'en', itemType: 'PRODUCT', itemId: t.productId });
    fake.enqueue(JSON.stringify({ ...ok.output, hashtags: ['#Bissap', '#BISSAP', '#bissap', '#Cafe'] }));
    const again = await run('content', t, { format: 'INSTAGRAM_CAPTION', purpose: 'PROMOTIONAL', tone: 'FRIENDLY', language: 'en', itemType: 'PRODUCT', itemId: t.productId, instructions: 'second try' });
    expect(again).toMatchObject({ status: 'SUCCEEDED' });
    expect(again.output.hashtags).toEqual(['#Bissap', '#Cafe']);
  });
});
