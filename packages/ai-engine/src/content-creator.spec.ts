import { AI_FORMATS, FORMAT_RULES } from '@touma/shared';
import { contentCreator, type ContentInput } from './agents/content-creator';
import { runAgent, type EngineConfig } from './engine';
import { ctx } from './fixtures.spec-helper';
import { FakeTextProvider } from './testing/fake-provider';
import type { TextModelProvider } from './provider';

const config: EngineConfig = { model: 'm', maxOutputTokens: 2000, timeoutMs: 5000, maxProviderRetries: 0, maxRepairAttempts: 0 };
const sleep = async () => undefined;
const base = (format: ContentInput['format'], over: Partial<ContentInput> = {}): ContentInput => ({ language: 'en', platform: FORMAT_RULES[format].platform, format, purpose: 'PROMOTIONAL', tone: 'FRIENDLY', item: null, angle: null, brandVoice: null, ...over });
const run = (provider: TextModelProvider, input: ContentInput, context = ctx()) => runAgent(contentCreator, { provider, context, input, config, sleep });

describe('content generation: descriptions and captions', () => {
  it('generates every format for a business with NO product or service (regression: "duplicate hashtags" failed the whole generation)', async () => {
    const empty = ctx({ products: [], services: [] });
    for (const format of AI_FORMATS) {
      const r = await run(new FakeTextProvider(), base(format), empty);
      expect(r.output.format).toBe(format);
      const tags = r.output.hashtags.map((h) => h.toLowerCase());
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it('generates a product description for a selected product, with its verified facts', async () => {
    const r = await run(new FakeTextProvider(), base('PRODUCT_DESCRIPTION', { item: { type: 'PRODUCT', id: 'p1' } }));
    expect(r.output.description).toBeTruthy();
    expect(r.output.claims.some((c) => c.source === 'product:p1')).toBe(true);
  });

  it('does not fail a generation because a model repeated a hashtag in a different case', async () => {
    const good = (await run(new FakeTextProvider(), base('INSTAGRAM_CAPTION', { item: { type: 'PRODUCT', id: 'p1' } }))).output;
    const noisy = new FakeTextProvider();
    noisy.enqueue(JSON.stringify({ ...good, hashtags: ['#Touma', '#TOUMA', '#touma', ' #Awa ', '#Awa'] }));
    const r = await run(noisy, base('INSTAGRAM_CAPTION', { item: { type: 'PRODUCT', id: 'p1' } }));
    expect(r.output.hashtags).toEqual(['#Touma', '#Awa']);
  });

  it('still rejects real problems: too many hashtags is not hidden by the clean-up', async () => {
    const good = (await run(new FakeTextProvider(), base('INSTAGRAM_CAPTION', { item: { type: 'PRODUCT', id: 'p1' } }))).output;
    const many = new FakeTextProvider();
    many.enqueue(JSON.stringify({ ...good, hashtags: Array.from({ length: 40 }, (_, i) => `#tag${i}`) }));
    await expect(run(many, base('INSTAGRAM_CAPTION', { item: { type: 'PRODUCT', id: 'p1' } }))).rejects.toThrow();
  });
});
