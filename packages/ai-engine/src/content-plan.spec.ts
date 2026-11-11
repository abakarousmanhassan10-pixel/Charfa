import type { BusinessContext } from './context';
import type { ContentPlan } from './schemas';
import { contentPlanSchema } from './schemas';
import { checkContentPlan, type PlanRequest } from './validation';

const ctx: BusinessContext = {
  businessId: 'b1',
  business: { name: 'Maquis Awa', currency: 'XAF', description: 'Grilled chicken and fresh juices in N\'Djamena' },
  products: [{ id: 'p1', name: 'Bissap juice', price: '1500' }, { id: 'p2', name: 'Grilled chicken', price: '4500' }],
  services: [],
  knowledge: [{ id: 'k1', category: 'FAQ', title: 'Hours', body: 'Open every day from 10:00 to 22:00' }],
  missingInformation: [],
};
const req: PlanRequest = { language: 'en', startDate: '2026-12-01', days: 14, postsPerWeek: 5, platforms: ['INSTAGRAM', 'FACEBOOK'], occasions: [{ name: 'Opening anniversary', date: '2026-12-10', day: 10 }] };

const pillars = ['PRODUCT_SHOWCASE', 'EDUCATIONAL', 'ENGAGEMENT', 'PROMOTIONAL', 'BRAND_AWARENESS'];
function plan(over: Partial<ContentPlan> = {}): ContentPlan {
  const items = Array.from({ length: 10 }, (_, i) => ({
    day: 1 + i,
    platform: (i % 2 ? 'FACEBOOK' : 'INSTAGRAM') as 'INSTAGRAM',
    pillar: pillars[i % 5]!,
    contentType: 'IMAGE' as const,
    title: `Post number ${i + 1}`,
    brief: 'Show the dish and tell customers where to find it in town.',
    itemType: pillars[i % 5] === 'PRODUCT_SHOWCASE' || pillars[i % 5] === 'PROMOTIONAL' ? ('PRODUCT' as const) : null,
    itemId: pillars[i % 5] === 'PRODUCT_SHOWCASE' || pillars[i % 5] === 'PROMOTIONAL' ? 'p1' : null,
    occasion: null,
  }));
  items[9] = { ...items[9]!, day: 10, pillar: 'SEASONAL', itemType: null, itemId: null, occasion: 'Opening anniversary', title: 'Opening anniversary' };
  return { language: 'en', startDate: '2026-12-01', days: 14, summary: 'A balanced two-week plan.', items, claims: [], warnings: [], missingInformation: [], ...over };
}

describe('checkContentPlan', () => {
  it('accepts a balanced, grounded plan', () => {
    expect(contentPlanSchema.safeParse(plan()).success).toBe(true);
    expect(checkContentPlan(plan(), ctx, req)).toEqual([]);
  });

  it('rejects seasonal posts for occasions the merchant did not provide', () => {
    const p = plan();
    p.items[2] = { ...p.items[2]!, pillar: 'SEASONAL', occasion: 'Ramadan' };
    expect(checkContentPlan(p, ctx, req).join('|')).toMatch(/SEASONAL post must use one of the occasions/);
  });

  it('rejects any seasonal post when no occasions were provided', () => {
    const p = plan();
    const issues = checkContentPlan(p, ctx, { ...req, occasions: [] });
    expect(issues.join('|')).toMatch(/none were provided/);
  });

  it('rejects invented holidays in free text', () => {
    const p = plan();
    p.items[1] = { ...p.items[1]!, brief: 'Celebrate Black Friday with our team and the whole family in town.' };
    expect(checkContentPlan(p, ctx, req).join('|')).toMatch(/black friday.*did not provide/i);
  });

  it('rejects invented promotions and discounts, but allows what the business data says', () => {
    const p = plan();
    p.items[3] = { ...p.items[3]!, title: 'Get 20% off today' };
    expect(checkContentPlan(p, ctx, req).join('|')).toMatch(/promotion or discount/);
    const withDiscount = { ...ctx, knowledge: [...ctx.knowledge, { id: 'k2', category: 'PRICING', title: 'Offer', body: 'Free delivery for orders above 10000' }] };
    const q = plan();
    q.items[3] = { ...q.items[3]!, brief: 'Mention that delivery is free delivery above the minimum order, as in the data.' };
    expect(checkContentPlan(q, withDiscount, req)).toEqual([]);
  });

  it('requires a product for promotional and showcase posts, and real ids', () => {
    const p = plan();
    p.items[0] = { ...p.items[0]!, itemId: null, itemType: null };
    p.items[3] = { ...p.items[3]!, itemId: 'ghost', itemType: 'PRODUCT' };
    const msg = checkContentPlan(p, ctx, req).join('|');
    expect(msg).toMatch(/must be about a product or service/);
    expect(msg).toMatch(/not an active product or service/);
  });

  it('enforces balance, count, days, platforms and per-day limits', () => {
    const one = plan();
    one.items = one.items.map((i) => (i.pillar === 'SEASONAL' ? i : { ...i, pillar: 'EDUCATIONAL', itemId: null, itemType: null }));
    expect(checkContentPlan(one, ctx, req).join('|')).toMatch(/at least 3 different content pillars|more than half/);
    const few = plan({ items: plan().items.slice(0, 2) });
    expect(checkContentPlan(few, ctx, req).join('|')).toMatch(/but about \d+ were requested/);
    const bad = plan();
    bad.items[0] = { ...bad.items[0]!, day: 20, platform: 'TIKTOK' };
    expect(checkContentPlan(bad, ctx, req).join('|')).toMatch(/outside the 14-day plan[\s\S]*platform TIKTOK was not requested/);
    const crowded = plan();
    crowded.items.push({ ...crowded.items[0]!, title: 'x1' }, { ...crowded.items[0]!, title: 'x2' });
    expect(checkContentPlan(crowded, ctx, req).join('|')).toMatch(/too many posts/);
  });

  it('requires every provided occasion to be used on its exact day', () => {
    const p = plan();
    p.items[9] = { ...p.items[9]!, day: 11 };
    expect(checkContentPlan(p, ctx, req).join('|')).toMatch(/is on day 10, not day 11/);
    const q = plan();
    q.items = q.items.filter((i) => i.pillar !== 'SEASONAL');
    expect(checkContentPlan(q, ctx, req).join('|')).toMatch(/must have a SEASONAL post/);
  });

  it('rejects duplicate titles and wrong language/start/days', () => {
    const p = plan({ language: 'fr', startDate: '2026-12-02', days: 15 });
    p.items[2] = { ...p.items[2]!, title: p.items[0]!.title, platform: p.items[0]!.platform };
    const msg = checkContentPlan(p, ctx, req).join('|');
    expect(msg).toMatch(/language must be en/);
    expect(msg).toMatch(/startDate must be 2026-12-01/);
    expect(msg).toMatch(/days must be 14/);
    expect(msg).toMatch(/duplicate title/);
  });
});
