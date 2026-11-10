import { compareMoney, defaultCategories, productInputSchema, serviceInputSchema, slugify } from './catalog';
import { roleHasPermission } from './rbac';
import { businessInputSchema } from './business.schemas';

describe('money', () => {
  it('compares decimal strings exactly', () => {
    expect(compareMoney('19.99', '20')).toBe(-1);
    expect(compareMoney('20.00', '20')).toBe(0);
    expect(compareMoney('100', '99.99')).toBe(1);
    expect(compareMoney('0.1', '0.10')).toBe(0);
    expect(compareMoney('007.5', '7.50')).toBe(0);
  });
});

describe('productInputSchema', () => {
  it('accepts a full product', () => {
    const p = productInputSchema.parse({
      name: ' Bissap juice ',
      price: '1500',
      discountPrice: '1200.50',
      currency: 'xaf',
      stockQuantity: '30',
      features: ['Natural', 'Cold-pressed'],
    });
    expect(p).toMatchObject({ name: 'Bissap juice', currency: 'XAF', stockQuantity: 30, availability: 'IN_STOCK', status: 'DRAFT' });
  });
  it.each([
    [{ name: 'x', price: '12.345' }],
    [{ name: 'x', price: '-1' }],
    [{ name: 'x', price: '1e5' }],
    [{ name: 'x', price: '10', discountPrice: '10' }],
    [{ name: 'x', discountPrice: '5' }],
    [{ name: 'x', stockQuantity: -1 }],
    [{ name: 'x', features: Array(21).fill('a') }],
    [{ name: '' }],
  ])('rejects %#', (input) => {
    expect(productInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('serviceInputSchema', () => {
  it('validates duration and booking url', () => {
    expect(serviceInputSchema.safeParse({ name: 'Haircut', durationMinutes: 45 }).success).toBe(true);
    expect(serviceInputSchema.safeParse({ name: 'Haircut', durationMinutes: 0 }).success).toBe(false);
    expect(serviceInputSchema.safeParse({ name: 'Haircut', bookingUrl: 'javascript:x' }).success).toBe(false);
  });
});

describe('defaultCategories', () => {
  it('uses the business language and stable English slugs', () => {
    const fr = defaultCategories('RESTAURANT', 'PRODUCT', 'fr');
    expect(fr[0]).toEqual({ name: 'Entrées', slug: 'starters', sortOrder: 0 });
    expect(defaultCategories('AGENCY', 'PRODUCT', 'en')).toEqual([{ name: 'General', slug: 'general', sortOrder: 0 }]);
    expect(slugify('Menus & combos')).toBe('menus-and-combos');
  });
});

describe('Phase 2 permissions', () => {
  it('viewers read media/knowledge, editors write, only admins+ verify knowledge', () => {
    expect(roleHasPermission('VIEWER', 'media.read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'media.write')).toBe(false);
    expect(roleHasPermission('EDITOR', 'knowledge.write')).toBe(true);
    expect(roleHasPermission('EDITOR', 'knowledge.verify')).toBe(false);
    expect(roleHasPermission('ADMIN', 'knowledge.verify')).toBe(true);
    expect(roleHasPermission('OWNER', 'knowledge.verify')).toBe(true);
  });
});

describe('business contact fields', () => {
  it('validates email and phone', () => {
    expect(businessInputSchema.safeParse({ name: 'Ab', type: 'OTHER', contactEmail: 'Shop@Example.com', contactPhone: '+235 66 00 00 00' }).success).toBe(true);
    expect(businessInputSchema.safeParse({ name: 'Ab', type: 'OTHER', contactEmail: 'nope' }).success).toBe(false);
    expect(businessInputSchema.safeParse({ name: 'Ab', type: 'OTHER', contactPhone: 'call me' }).success).toBe(false);
  });
});
