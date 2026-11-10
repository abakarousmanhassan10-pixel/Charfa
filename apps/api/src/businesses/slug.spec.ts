import { businessSlug } from './slug';

describe('businessSlug', () => {
  it('transliterates accents and adds a random suffix', () => {
    expect(businessSlug('Café Àwa & Fils')).toMatch(/^cafe-awa-fils-[a-f0-9]{6}$/);
    expect(businessSlug('Café')).not.toEqual(businessSlug('Café'));
  });
  it('falls back for non-latin names', () => {
    expect(businessSlug('مطعم')).toMatch(/^business-[a-f0-9]{6}$/);
  });
});
