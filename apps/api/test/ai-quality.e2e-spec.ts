import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { fakeDefaultAnswer, type FakeTextProvider } from '@touma/ai-engine';
import { KNOWLEDGE_CATEGORIES } from '@touma/shared';
import { TEXT_PROVIDER } from '../src/ai/ai-provider';
import { AiApprovalService } from '../src/ai/ai-approval.service';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * AI quality: fabrication detection inside the real pipeline, preservation of verified facts, and human
 * approval before publication. Real PostgreSQL, Redis and BullMQ; only the AI provider is the test-only one.
 */
describe('AI quality and human approval (e2e)', () => {
  let app: INestApplication;
  let fake: FakeTextProvider;
  let approval: AiApprovalService;
  let h: ReturnType<typeof aiHelpers>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    fake = app.get(TEXT_PROVIDER);
    approval = app.get(AiApprovalService);
    h = aiHelpers(app);
  });
  beforeEach(() => fake.reset());
  afterEach(() => h.releaseAll());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const post = (c: Ctx, path: string, body: Record<string, unknown> = {}) => request(h.http).post(`/api/v1${path}`).set(as(c)).send(body);

  /** A finished content generation (analyses already cached, so scripted answers hit the content step). */
  async function generated(t: Ctx & { productId: string }, extra: Record<string, unknown> = {}) {
    const g = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId, ...extra }).expect(202)).body.id);
    expect(g.body.status).toBe('SUCCEEDED');
    return g.body as { id: string; output: Record<string, unknown> };
  }
  const draft = (t: Ctx, id: string, output?: Record<string, unknown>) => post(t, `/ai/generations/${id}/draft`, output ? { output } : {});
  const contentOf = (id: string) => prisma.content.findUniqueOrThrow({ where: { id } });
  /** Scripts the next answer: the deterministic default with some fields replaced. */
  const answer = (over: Record<string, unknown>) => (req: Parameters<typeof fakeDefaultAnswer>[0]) => JSON.stringify({ ...fakeDefaultAnswer(req), ...over });

  describe('fabrication detection in the pipeline', () => {
    async function warm(t: Ctx & { productId: string }) {
      await generated(t); // caches the analyses
      fake.reset();
    }
    it.each([
      ['an invented delivery promise', 'Same-day delivery across the city!', /delivery time/],
      ['an invented phone number', 'Order on +235 99 88 77 66', /Phone number not present/],
      ['an invented specification', 'Our 500 ml bottle', /500 ml/],
      ['an invented year', 'Serving you since 2015', /Year "2015"/],
      ['an invented health claim', 'Clinically proven to detox', /medical claim/],
      ['an invented social handle', 'Follow @bissap_official', /Social handle/],
      ['a different currency', 'Only 1500 €', /Currency/],
    ])('rejects %s, stores the failure, and nothing is saved', async (_n, caption, pattern) => {
      const t = await h.tenant();
      await warm(t);
      const bad = answer({ caption });
      fake.enqueue(bad, bad);
      const g = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      expect(g.body).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_OUTPUT', output: null });
      expect(g.body.errorMessage).toMatch(pattern);
      await post(t, `/ai/generations/${g.body.id}/draft`).expect(400); // a failed generation can never become a draft
    });

    it('accepts text built only from verified facts, and reports which facts were verified', async () => {
      const t = await h.tenant();
      await warm(t);
      fake.enqueue(answer({ caption: 'Our Bissap juice, 1 500 XAF, made with hibiscus flowers and served cold.', claims: [{ claim: 'Price is 1500 XAF', source: `product:${t.productId}` }] }));
      const g = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      expect(g.body.status).toBe('SUCCEEDED');
      expect(g.body.quality).toMatchObject({ passed: true, issues: [] });
      expect(g.body.quality.verified.amounts).toContain('1 500 XAF');
      expect(g.body.quality.verified.sources).toContain(`product:${t.productId}`);
      expect(g.body.quality.checks).toEqual(expect.arrayContaining(['amounts', 'currency', 'claims', 'sources']));
    });

    it("rejects content that says an out-of-stock item is available, or uses another item's price", async () => {
      const t = await h.tenant();
      const oos = await post(t, '/products', { name: 'Sold-out syrup', price: '3000', status: 'ACTIVE', availability: 'OUT_OF_STOCK' }).expect(201);
      await warm(t);
      const soldOut = answer({ caption: 'Sold-out syrup: order now!' });
      const analysis = (req: Parameters<typeof fakeDefaultAnswer>[0]) => JSON.stringify(fakeDefaultAnswer(req)); // the new item's product analysis
      fake.enqueue(analysis, soldOut, soldOut); // analysis, content, repair attempt
      const a = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: oos.body.id }).expect(202)).body.id);
      expect(a.body).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_OUTPUT' });
      expect(a.body.errorMessage).toMatch(/available now|out of stock/);
      // Another item's price attributed to this one.
      const wrong = answer({ caption: 'Bissap juice for 3 000 XAF' });
      fake.enqueue(wrong, wrong);
      const b = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      expect(b.body.status).toBe('FAILED');
      expect(b.body.errorMessage).toMatch(/belongs to another item/);
    });

    it('accepts the real discount percentage between two real prices', async () => {
      const t = await h.tenant();
      await request(h.http).patch(`/api/v1/products/${t.productId}`).set(as(t)).send({ discountPrice: '1200' }).expect(200);
      await warm(t);
      fake.enqueue(answer({ caption: 'Bissap juice now 20% off: 1 200 XAF instead of 1 500 XAF' }));
      const ok = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      expect(ok.body.status).toBe('SUCCEEDED');
      const bad = answer({ caption: 'Bissap juice now 30% off' });
      fake.enqueue(bad, bad);
      const no = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      expect(no.body.errorMessage).toMatch(/30%/);
    });
  });

  describe('verified business facts are preserved', () => {
    it('only verified knowledge and ACTIVE items reach the provider; the facts are never modified by the AI', async () => {
      const t = await h.tenant();
      const cat = KNOWLEDGE_CATEGORIES[0];
      const verified = await post(t, '/business-knowledge', { category: cat, title: 'Opening', body: 'We are open Monday to Saturday from 8am.' }).expect(201);
      await post(t, `/business-knowledge/${verified.body.id}/verify`).expect(200);
      await post(t, '/business-knowledge', { category: cat, title: 'Rumour', body: 'UNVERIFIED-RUMOUR we won an award in Paris.' }).expect(201);
      await post(t, '/products', { name: 'Hidden draft product', status: 'DRAFT' }).expect(201);

      const snapshot = async () =>
        JSON.stringify({
          business: await prisma.business.findUnique({ where: { id: t.businessId } }),
          products: await prisma.product.findMany({ where: { businessId: t.businessId }, orderBy: { id: 'asc' } }),
          services: await prisma.service.findMany({ where: { businessId: t.businessId }, orderBy: { id: 'asc' } }),
          knowledge: await prisma.knowledgeEntry.findMany({ where: { businessId: t.businessId }, orderBy: { id: 'asc' } }),
        });
      const before = await snapshot();

      await h.settled(t, (await h.submitAnalysis(t).expect(202)).body.id);
      await h.settled(t, (await post(t, '/ai/product-analysis', { language: 'en', itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      await h.settled(t, (await post(t, '/ai/marketing-strategy', { language: 'en', platforms: ['INSTAGRAM'] }).expect(202)).body.id);
      const g = await generated(t);
      await draft(t, g.id).expect(200);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      await post(t, `/ai/generations/${g.id}/approve`).expect(200);

      expect(await snapshot()).toBe(before);
      const sent = fake.requests.map((r) => r.user).join('\n');
      expect(sent).toContain('We are open Monday to Saturday');
      expect(sent).not.toContain('UNVERIFIED-RUMOUR');
      expect(sent).not.toContain('Hidden draft product');
    });

    it('an unverified fact cannot be used to justify content', async () => {
      const t = await h.tenant();
      await post(t, '/business-knowledge', { category: KNOWLEDGE_CATEGORIES[0], title: 'Award', body: 'We are an award-winning restaurant.' }).expect(201); // not verified
      await generated(t);
      fake.reset();
      const bad = answer({ caption: 'Our award-winning bissap' });
      fake.enqueue(bad, bad);
      const g = await h.settled(t, (await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202)).body.id);
      expect(g.body).toMatchObject({ status: 'FAILED' });
      expect(g.body.errorMessage).toMatch(/award/);
    });
  });

  describe('human approval before publication', () => {
    it('DRAFT → IN_REVIEW → APPROVED by a person with content.approve, recorded and audited', async () => {
      const owner = await h.tenant();
      const editor = await h.member(owner, 'EDITOR');
      const admin = await h.member(owner, 'ADMIN');
      const viewer = await h.member(owner, 'VIEWER');
      const g = await generated(owner);
      const saved = await draft(editor, g.id).expect(200);
      expect(saved.body.content).toMatchObject({ status: 'DRAFT', origin: 'AI_GENERATED', version: 1 });
      expect(saved.body.generation.content).toMatchObject({ status: 'DRAFT', approved: false });

      // Nothing is publishable yet.
      await expect(approval.assertPublishable(owner.businessId, saved.body.content.id)).rejects.toMatchObject({ status: 409 });
      // A draft cannot jump to APPROVED, and a viewer cannot even submit it.
      await post(admin, `/ai/generations/${g.id}/approve`).expect(409);
      await post(viewer, `/ai/generations/${g.id}/submit-review`).expect(403);
      const review = await post(editor, `/ai/generations/${g.id}/submit-review`).expect(200);
      expect(review.body.content).toMatchObject({ status: 'IN_REVIEW', approved: false });
      // The editor wrote it but cannot approve; neither can a viewer.
      await post(editor, `/ai/generations/${g.id}/approve`).expect(403);
      await post(viewer, `/ai/generations/${g.id}/approve`).expect(403);
      await expect(approval.assertPublishable(owner.businessId, saved.body.content.id)).rejects.toMatchObject({ status: 409 });

      const done = await post(admin, `/ai/generations/${g.id}/approve`).expect(200);
      expect(done.body.content).toMatchObject({ status: 'APPROVED', approved: true, version: 1 });
      const row = await contentOf(saved.body.content.id);
      expect(row).toMatchObject({ status: 'APPROVED', approvedVersion: 1, approvedById: admin.userId, origin: 'AI_GENERATED' });
      expect(row.approvedAt).not.toBeNull();
      await expect(approval.assertPublishable(owner.businessId, row.id)).resolves.toMatchObject({ id: row.id });
      const actions = (await prisma.auditLog.findMany({ where: { businessId: owner.businessId, entityId: row.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['ai.draft_saved', 'ai.content_submitted', 'ai.content_approved']);
    });

    it('requires a saved draft first, and only an in-review draft can be approved or rejected', async () => {
      const t = await h.tenant();
      const g = await generated(t);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(400); // no draft yet
      await post(t, `/ai/generations/${g.id}/approve`).expect(400);
      await draft(t, g.id).expect(200);
      await post(t, `/ai/generations/${g.id}/reject`, { reason: 'Not on brand' }).expect(409);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(409); // already in review
    });

    it('rejection records the reason; the draft can be fixed and resubmitted', async () => {
      const t = await h.tenant();
      const g = await generated(t);
      const saved = await draft(t, g.id).expect(200);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      await post(t, `/ai/generations/${g.id}/reject`, { reason: 'x' }).expect(400); // a real reason is required
      const rej = await post(t, `/ai/generations/${g.id}/reject`, { reason: 'Tone is too casual for our brand' }).expect(200);
      expect(rej.body.content).toMatchObject({ status: 'REJECTED', approved: false, rejectionReason: 'Tone is too casual for our brand' });
      await expect(approval.assertPublishable(t.businessId, saved.body.content.id)).rejects.toMatchObject({ status: 409 });
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      const ok = await post(t, `/ai/generations/${g.id}/approve`).expect(200);
      expect(ok.body.content).toMatchObject({ status: 'APPROVED', approved: true, rejectionReason: null });
    });

    it('editing the text withdraws the approval: a person approves exactly what is published', async () => {
      const t = await h.tenant();
      const g = await generated(t);
      const saved = await draft(t, g.id).expect(200);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      await post(t, `/ai/generations/${g.id}/approve`).expect(200);
      const id = saved.body.content.id as string;
      await expect(approval.assertPublishable(t.businessId, id)).resolves.toBeTruthy();

      // Saving the same text again changes nothing: the approval stands.
      const same = await draft(t, g.id).expect(200);
      expect(same.body.content).toMatchObject({ status: 'APPROVED', version: 1 });

      const edited = { ...g.output, caption: 'Our Bissap juice, made with hibiscus flowers and served cold.' };
      const res = await draft(t, g.id, edited).expect(200);
      expect(res.body.content).toMatchObject({ status: 'DRAFT', version: 2, origin: 'AI_ASSISTED' });
      expect(await contentOf(id)).toMatchObject({ status: 'DRAFT', approvedById: null, approvedAt: null, approvedVersion: null });
      await expect(approval.assertPublishable(t.businessId, id)).rejects.toMatchObject({ status: 409 });
      const gen = await request(h.http).get(`/api/v1/ai/generations/${g.id}`).set(as(t)).expect(200);
      expect(gen.body.content).toMatchObject({ status: 'DRAFT', approved: false });
    });

    it('a human edit with an invented price is saved but cannot be approved until corrected', async () => {
      const t = await h.tenant();
      const g = await generated(t);
      const invented = { ...g.output, caption: 'Bissap juice, today only 999 XAF!' };
      const res = await draft(t, g.id, invented).expect(200);
      expect(res.body.content.quality).toMatchObject({ passed: false });
      expect(res.body.content.quality.issues.join()).toMatch(/999 XAF/);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      const blocked = await post(t, `/ai/generations/${g.id}/approve`).expect(422);
      expect(blocked.body).toMatchObject({ code: 'APPROVAL_BLOCKED' });
      expect(blocked.body.issues.join()).toMatch(/999 XAF/);
      expect((await contentOf(res.body.content.id)).status).toBe('IN_REVIEW');
      expect(await prisma.auditLog.count({ where: { businessId: t.businessId, action: 'ai.approval_blocked' } })).toBe(1);

      // Correct the text and go through review again.
      await draft(t, g.id, { ...g.output, caption: 'Bissap juice, 1 500 XAF, served cold.' }).expect(200);
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      await post(t, `/ai/generations/${g.id}/approve`).expect(200);
    });

    it('approval re-checks the text against the facts as they are now', async () => {
      const t = await h.tenant();
      const g = await generated(t);
      await draft(t, g.id, { ...g.output, caption: 'Bissap juice for 1 500 XAF.' }).expect(200); // true today
      await post(t, `/ai/generations/${g.id}/submit-review`).expect(200);
      await request(h.http).patch(`/api/v1/products/${t.productId}`).set(as(t)).send({ price: '1800' }).expect(200); // the price changed meanwhile
      const blocked = await post(t, `/ai/generations/${g.id}/approve`).expect(422);
      expect(blocked.body.issues.join()).toMatch(/1 500 XAF/);
    });

    it('human-written content is not held back by the AI approval gate; unknown content is 404', async () => {
      const t = await h.tenant();
      const human = await prisma.content.create({ data: { businessId: t.businessId, type: 'TEXT', origin: 'HUMAN', status: 'DRAFT', language: 'en', hashtags: [] } });
      await expect(approval.assertPublishable(t.businessId, human.id)).resolves.toBeTruthy();
      await expect(approval.assertPublishable(t.businessId, 'c'.repeat(25))).rejects.toMatchObject({ status: 404 });
    });

    it('is private to the business: other tenants cannot see, submit, approve or reject', async () => {
      const a = await h.tenant('Appr A');
      const b = await h.tenant('Appr B');
      const g = await generated(a);
      const saved = await draft(a, g.id).expect(200);
      await post(a, `/ai/generations/${g.id}/submit-review`).expect(200);
      for (const action of ['submit-review', 'approve']) await post(b, `/ai/generations/${g.id}/${action}`).expect(404);
      await post(b, `/ai/generations/${g.id}/reject`, { reason: 'Not allowed to do this' }).expect(404);
      const spoof = { Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId };
      await request(h.http).post(`/api/v1/ai/generations/${g.id}/approve`).set(spoof).send({}).expect(404);
      // Another business's content is never publishable from this one.
      await expect(approval.assertPublishable(b.businessId, saved.body.content.id)).rejects.toMatchObject({ status: 404 });
      expect((await contentOf(saved.body.content.id)).status).toBe('IN_REVIEW');
    });
  });
});
