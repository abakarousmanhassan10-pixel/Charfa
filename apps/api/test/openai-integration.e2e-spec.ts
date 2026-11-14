import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { fakeDefaultAnswer, MockOpenAIProvider, ProviderError } from '@touma/ai-engine';
import { TEXT_PROVIDER } from '../src/ai/ai-provider';
import { OpenAIProviderService } from '../src/openai/openai-provider.service';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * Phase N23: the OpenAI integration end to end. The real OpenAI SDK and the real Responses API request format are used; the HTTP layer is
 * the built-in mock (AI_PROVIDER=mock-openai), so no socket is opened, no key is needed and nothing is billed.
 * Real PostgreSQL, Redis, BullMQ, guards, quotas and the AI orchestrator.
 */
describe('OpenAI integration (mock server, real SDK) (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v; };
  let app: INestApplication;
  let mock: MockOpenAIProvider;
  let ai: OpenAIProviderService;
  let h: ReturnType<typeof aiHelpers>;
  let s: ReturnType<typeof socialHelpers>;

  beforeAll(async () => {
    set('AI_PROVIDER', 'mock-openai');
    set('AI_MODEL', 'default-model');
    set('AI_TASK_MODELS', JSON.stringify({ CONTENT: 'copy-model', PRODUCT_ANALYSIS: 'analysis-model', CAMPAIGN_ANALYSIS: 'campaign-model' }));
    set('AI_MONTHLY_GENERATIONS_PER_BUSINESS', '9');
    set('AI_JOB_BACKOFF_MS', '30');
    await resetDb();
    app = await startApp();
    mock = app.get<MockOpenAIProvider>(TEXT_PROVIDER);
    ai = app.get(OpenAIProviderService);
    h = aiHelpers(app);
    s = socialHelpers(app);
  });
  beforeEach(() => mock.reset());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  let n = 0;
  async function shop() {
    const t = await h.tenant(`OpenAI ${++n}`);
    const editor = await h.member(t, 'EDITOR');
    const viewer = await h.member(t, 'VIEWER');
    return { ...t, editor, viewer, tenantCtx: (c: Ctx & { userId?: string }) => ({ businessId: c.businessId, userId: c.userId ?? null }) as never };
  }
  const tenantOf = (c: { businessId: string; userId: string }) => ({ businessId: c.businessId, userId: c.userId }) as never;
  const item = (id: string) => ({ type: 'PRODUCT' as const, id });
  const finish = async (c: Ctx, id: string) => (await h.settled(c, id)).body;

  it('writes a product description and analyzes a product through the OpenAI Responses API, from verified data only', async () => {
    const t = await shop();
    const gen = await ai.generateProductDescription(tenantOf(t.editor), { item: item(t.productId), language: 'en' });
    const done = await finish(t.editor, gen.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
    expect(done.output.format).toBe('PRODUCT_DESCRIPTION');
    expect(done.output.claims.some((c: { source: string }) => c.source === `product:${t.productId}`)).toBe(true);
    const pa = await finish(t.editor, (await ai.analyzeProduct(tenantOf(t.editor), { item: item(t.productId), language: 'fr' })).id);
    expect(pa).toMatchObject({ status: 'SUCCEEDED' });
    // The real SDK built real Responses API requests.
    expect(mock.mock.calls.length).toBeGreaterThan(1);
    for (const call of mock.mock.calls) {
      expect(call.url).toBe('https://api.openai.com/v1/responses');
      expect(call.body).toMatchObject({ store: false, text: { format: { type: 'json_schema', strict: true } } });
      expect(call.body).not.toHaveProperty('tools');
    }
  });

  it('chooses the model of each task from configuration, never from the code', async () => {
    const t = await shop();
    await finish(t.editor, (await ai.generateProductDescription(tenantOf(t.editor), { item: item(t.productId), language: 'en' })).id);
    const models = new Set(mock.mock.calls.map((c) => c.body.model));
    expect(models).toEqual(new Set(['analysis-model', 'copy-model', 'default-model'])); // product analysis, content, and the business-analysis step that uses the default
    const rows = await prisma.aIGeneration.findMany({ where: { businessId: t.businessId } });
    expect(new Set(rows.map((r) => r.model))).toEqual(expect.objectContaining(new Set(['analysis-model', 'copy-model'])));
    expect(ai.describe()).toMatchObject({ provider: 'mock-openai', defaultModel: 'default-model', models: { CONTENT: 'copy-model', STORYBOARD: 'default-model', CAMPAIGN_ANALYSIS: 'campaign-model' } });
    const status = (await request(h.http).get('/api/v1/ai/status').set(as(t.viewer)).expect(200)).body;
    expect(status.taskModels).toMatchObject({ CONTENT: 'copy-model' });
  });

  it('suggests audiences for an item from its analysis', async () => {
    const t = await shop();
    const done = await finish(t.editor, (await ai.suggestAudience(tenantOf(t.editor), { item: item(t.productId), language: 'en' })).id);
    const audience = OpenAIProviderService.audienceOf(done.output);
    expect(audience.length).toBeGreaterThan(0);
    expect(audience[0]).toEqual({ name: expect.any(String), reason: expect.any(String) });
    expect(OpenAIProviderService.audienceOf(null)).toEqual([]);
  });

  it('sends the provider only an opaque, stable, per-business safety id and no key, name or e-mail', async () => {
    const a = await shop();
    const b = await shop();
    await finish(a.editor, (await ai.analyzeProduct(tenantOf(a.editor), { item: item(a.productId), language: 'en' })).id);
    await finish(a.editor, (await ai.analyzeProduct(tenantOf(a.editor), { item: item(a.productId), language: 'en', instructions: 'again' })).id);
    const idsA = new Set(mock.mock.calls.map((c) => c.body.safety_identifier));
    await finish(b.editor, (await ai.analyzeProduct(tenantOf(b.editor), { item: item(b.productId), language: 'en' })).id);
    const idsAll = new Set(mock.mock.calls.map((c) => c.body.safety_identifier));
    expect(idsA.size).toBe(1);
    expect(idsAll.size).toBe(2);
    const id = [...idsA][0] as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain(a.businessId);
    expect(JSON.stringify(mock.mock.calls.map((c) => ({ ...c, body: { ...c.body, input: undefined, instructions: undefined } })))).not.toMatch(/sk-|@example\.com/);
  });

  it('retries only what can succeed: rate limits are retried, an invalid key and an empty account are not', async () => {
    const t = await shop();
    mock.enqueue(new ProviderError('rate_limit', 'x'));
    const retried = await finish(t.editor, (await ai.analyzeProduct(tenantOf(t.editor), { item: item(t.productId), language: 'en' })).id);
    expect(retried).toMatchObject({ status: 'SUCCEEDED' });
    expect(mock.mock.calls).toHaveLength(2); // one refused, one answered
    mock.reset();
    mock.enqueue(new ProviderError('auth', 'x'));
    const auth = await finish(t.editor, (await ai.analyzeProduct(tenantOf(t.editor), { item: item(t.productId), language: 'en', instructions: 'a' })).id);
    expect(auth).toMatchObject({ status: 'FAILED', errorCode: 'AI_PROVIDER_AUTH' });
    expect(mock.mock.calls).toHaveLength(1);
    expect(JSON.stringify(auth)).not.toMatch(/sk-/);
    mock.reset();
    mock.enqueue(new ProviderError('quota', 'x'));
    const quota = await finish(t.editor, (await ai.analyzeProduct(tenantOf(t.editor), { item: item(t.productId), language: 'en', instructions: 'b' })).id);
    expect(quota).toMatchObject({ status: 'FAILED', errorCode: 'AI_PROVIDER_QUOTA' });
    expect(mock.mock.calls).toHaveLength(1);
  });

  it('an answer that invents a price is repaired once, then refused; nothing unsupported is stored as a result', async () => {
    const t = await shop();
    const fabricated = (req: Parameters<typeof fakeDefaultAnswer>[0]) => JSON.stringify({ ...fakeDefaultAnswer(req), caption: 'Only 777 XAF today!', description: 'Only 777 XAF today!' });
    mock.enqueue(fabricated, fabricated, fabricated, fabricated, fabricated, fabricated);
    const g = await finish(t.editor, (await ai.generateProductDescription(tenantOf(t.editor), { item: item(t.productId), language: 'en' })).id);
    expect(g).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_OUTPUT' });
    expect(g.output).toBeNull();
    expect(await prisma.aIGeneration.count({ where: { businessId: t.businessId, task: 'CONTENT', status: 'SUCCEEDED' } })).toBe(0); // the invented price was never kept as a result
  });

  it('refuses before calling OpenAI: bad input, an unknown item, a draft item and a spent quota', async () => {
    const t = await shop();
    const user = tenantOf(t.editor);
    await expect(ai.analyzeProduct(user, { item: item(t.productId), language: 'xx' })).rejects.toMatchObject({ response: { code: 'VALIDATION' } });
    await expect(ai.analyzeProduct(user, { item: { type: 'PRODUCT', id: 'not an id!' }, language: 'en' })).rejects.toMatchObject({ response: { code: 'VALIDATION' } });
    await expect(ai.generateMarketingCopy(user, { format: 'NOT_A_FORMAT', language: 'en' })).rejects.toMatchObject({ response: { code: 'VALIDATION' } });
    await expect(ai.analyzeProduct(user, { item: item(t.productId), language: 'en', instructions: 'x'.repeat(501) })).rejects.toMatchObject({ response: { code: 'VALIDATION' } });
    const draft = (await request(h.http).post('/api/v1/products').set(as(t)).send({ name: 'Draft', price: '1' }).expect(201)).body;
    await expect(ai.analyzeProduct(user, { item: item(draft.id), language: 'en' })).rejects.toMatchObject({ response: { code: 'ITEM_NOT_ACTIVE' } });
    expect(mock.mock.calls).toHaveLength(0);
    // The monthly quota (9 units here) stops the request before any provider call.
    for (let i = 0; i < 9; i++) await finish(t.editor, (await ai.analyzeProduct(user, { item: item(t.productId), language: 'en', instructions: `n${i}` })).id);
    const calls = mock.mock.calls.length;
    await expect(ai.analyzeProduct(user, { item: item(t.productId), language: 'en', instructions: 'over' })).rejects.toMatchObject({ response: { code: 'AI_LIMIT_REACHED' } });
    expect(mock.mock.calls).toHaveLength(calls);
  });

  it('isolates businesses: another business cannot analyze, read or measure what is not its own', async () => {
    const a = await shop();
    const b = await shop();
    const gen = await ai.analyzeProduct(tenantOf(a.editor), { item: item(a.productId), language: 'en' });
    await finish(a.editor, gen.id);
    await expect(ai.analyzeProduct(tenantOf(b.editor), { item: item(a.productId), language: 'en' })).rejects.toMatchObject({ response: { code: 'ITEM_NOT_FOUND' } });
    expect((await request(h.http).get(`/api/v1/ai/generations/${gen.id}`).set(as(b.editor))).status).toBe(404);
    await expect(ai.analyzeCampaign(tenantOf(b.editor), { campaignId: 'cmwabcdefghij0123456789', language: 'en' })).rejects.toMatchObject({ response: { code: 'CAMPAIGN_NOT_FOUND' } });
    // Nothing of A was in B's requests.
    const before = mock.mock.calls.length;
    await finish(b.editor, (await ai.analyzeProduct(tenantOf(b.editor), { item: item(b.productId), language: 'en' })).id);
    expect(JSON.stringify(mock.mock.calls.slice(before))).not.toContain(a.productId);
  });

  it('roles: a viewer cannot generate; an editor can', async () => {
    const t = await shop();
    expect((await request(h.http).post('/api/v1/ai/campaign-analysis').set(as(t.viewer)).send({ language: 'en', campaignId: 'cmwabcdefghij0123456789' })).status).toBe(403);
    expect((await request(h.http).post('/api/v1/ai/product-analysis').set(as(t.viewer)).send({ language: 'en', itemType: 'PRODUCT', itemId: t.productId })).status).toBe(403);
    expect((await request(h.http).post('/api/v1/ai/product-analysis').set(as(t.editor)).send({ language: 'en', itemType: 'PRODUCT', itemId: t.productId })).status).toBe(202);
  });

  describe('campaign analysis', () => {
    async function evaluated(t: Awaited<ReturnType<typeof shop>>, publish: boolean) {
      await s.connect(t, 'FACEBOOK');
      const admin = await h.member(t, 'ADMIN');
      const camp = (path: string, c: Ctx = t.editor, body: Record<string, unknown> = {}) => request(h.http).post(`/api/v1/campaigns${path}`).set(as(c)).send(body);
      const id = (await camp('', t.editor, { name: 'Launch', goalType: 'LAUNCH', productIds: [t.productId] }).expect(201)).body.id as string;
      await camp(`/${id}/plan`, t.editor, { days: 10 }).expect(200);
      await camp(`/${id}/content`).expect(200);
      if (publish) {
        await camp(`/${id}/submit`).expect(200);
        const e = (await request(h.http).get(`/api/v1/campaigns/${id}`).set(as(t.viewer)).expect(200)).body.entries[0].id as string;
        await s.act(admin, e, 'approve').expect(200);
        await s.act(admin, e, 'authorize').expect(200);
        await s.dispatch(e);
        await s.reach(e, ['PUBLISHED']);
        await camp(`/${id}/metrics`, t.editor, { refresh: true }).expect(200);
      }
      return id;
    }

    it('explains an evaluated campaign in plain words, keeps simulated data labelled, and claims no sales', async () => {
      const t = await shop();
      const id = await evaluated(t, true);
      const g = await finish(t.editor, (await ai.analyzeCampaign(tenantOf(t.editor), { campaignId: id, language: 'en' })).id);
      expect(g).toMatchObject({ status: 'SUCCEEDED' });
      expect(g.output.evidence).not.toBe('REAL');
      expect(JSON.stringify(g.output)).toMatch(/simulat|unavailable|no measurements/i);
      expect(JSON.stringify(g.output)).not.toMatch(/sales (increased|grew)|ROI|guarantee/i);
      expect(g.output.recommendations.every((r: { needsMerchantApproval: boolean }) => r.needsMerchantApproval)).toBe(true);
      expect(mock.mock.calls.some((c) => c.body.model === 'campaign-model')).toBe(true);
      expect(await prisma.publication.count({ where: { businessId: t.businessId } })).toBe(1); // analyzing published nothing more
    });

    it('needs measurements first, and refuses an answer that claims sales or proposes more ad spend', async () => {
      const t = await shop();
      const id = await evaluated(t, false);
      await expect(ai.analyzeCampaign(tenantOf(t.editor), { campaignId: id, language: 'en' })).rejects.toMatchObject({ response: { code: 'NO_EVALUATION' } });
      const t2 = await shop();
      const id2 = await evaluated(t2, true);
      const bad = (req: Parameters<typeof fakeDefaultAnswer>[0]) => JSON.stringify({ ...fakeDefaultAnswer(req), summary: 'Sales increased because of this simulated campaign.', recommendations: [{ text: 'Increase your advertising budget now.', needsMerchantApproval: true }] });
      mock.enqueue(bad, bad, bad, bad);
      const g = await finish(t2.editor, (await ai.analyzeCampaign(tenantOf(t2.editor), { campaignId: id2, language: 'en' })).id);
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_OUTPUT' });
    });
  });

  describe('customer answers: AUTO, MANUAL and PAUSED', () => {
    async function chatShop() {
      const t = await shop();
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
      const cfg = (data: { enabled: boolean; replyMode?: 'REVIEW' | 'AUTO'; authorized?: boolean }) =>
        prisma.salesAgentConfig.upsert({
          where: { businessId: t.businessId },
          create: { businessId: t.businessId, enabled: data.enabled, replyMode: data.replyMode ?? 'REVIEW', autoReplyAuthorizedAt: data.authorized ? new Date() : null },
          update: { enabled: data.enabled, replyMode: data.replyMode ?? 'REVIEW', autoReplyAuthorizedAt: data.authorized ? new Date() : null },
        });
      const send = (message: string, token?: string) => request(h.http).post(`/api/v1/public/chat/${slug}/messages`).send({ message, ...(token ? { token } : {}) });
      const product = await prisma.product.findUniqueOrThrow({ where: { id: t.productId } });
      return { t, cfg, send, question: `How much is the ${product.name}?` };
    }
    const outbound = (businessId: string) => prisma.message.findMany({ where: { businessId, direction: 'OUTBOUND' } });

    it('PAUSED: the customer chat is closed and OpenAI is never called', async () => {
      const { t, cfg, send } = await chatShop();
      await cfg({ enabled: false });
      expect((await send('How much is the juice?')).status).toBe(404);
      expect(mock.mock.calls).toHaveLength(0);
      expect(await outbound(t.businessId)).toHaveLength(0);
    });

    it('MANUAL: the agent only drafts, nothing is shown to the customer, and the draft stays pending for a person', async () => {
      const { t, cfg, send, question } = await chatShop();
      await cfg({ enabled: true, replyMode: 'REVIEW' });
      await send(question).expect(200);
      await h.waitFor(async () => (await outbound(t.businessId)).some((m) => m.authorType === 'AI_SUGGESTION') || null);
      const msgs = await outbound(t.businessId);
      expect(msgs.filter((m) => m.authorType === 'AI_REPLY')).toHaveLength(0); // nothing was answered on the merchant's behalf
      const drafts = msgs.filter((m) => m.authorType === 'AI_SUGGESTION');
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.every((m) => m.approvalStatus === 'PENDING' && m.sentAt === null)).toBe(true);
      expect(mock.mock.calls.every((c) => String(c.body.input).length > 0)).toBe(true);
      const conv = await prisma.conversation.findFirstOrThrow({ where: { businessId: t.businessId } });
      const r = await ai.answerCustomerQuestion(tenantOf(t.editor), conv.id);
      expect(r).toMatchObject({ drafted: true, mode: 'MANUAL', autoSendAllowed: false });
    });

    it('AUTO (explicitly authorized): the chat answers; the facade itself still only drafts', async () => {
      const { t, cfg, send, question } = await chatShop();
      await cfg({ enabled: true, replyMode: 'AUTO', authorized: true });
      const r = await send(question).expect(200);
      expect(r.body.token).toBeTruthy();
      await h.waitFor(async () => (await outbound(t.businessId)).some((m) => m.authorType === 'AI_REPLY' && m.approvalStatus === 'NOT_REQUIRED') || null);
      const conv = await prisma.conversation.findFirstOrThrow({ where: { businessId: t.businessId } });
      const d = await ai.answerCustomerQuestion(tenantOf(t.editor), conv.id);
      expect(d).toMatchObject({ drafted: true, mode: 'AUTO', autoSendAllowed: false });
      await cfg({ enabled: false });
      expect(await ai.answerCustomerQuestion(tenantOf(t.editor), conv.id)).toMatchObject({ drafted: false, mode: 'PAUSED' });
    });
  });
});
