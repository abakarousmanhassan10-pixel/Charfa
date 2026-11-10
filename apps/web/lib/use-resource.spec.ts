import { formatBytes, formatMoney, qs } from './use-resource';

describe('helpers', () => {
  it('builds query strings without empty values', () => {
    expect(qs({ q: 'mango', page: 2, status: '', categoryId: undefined })).toBe('?q=mango&page=2');
    expect(qs({})).toBe('');
  });
  it('formats money with the business currency and locale', () => {
    expect(formatMoney('1500.00', 'XAF', 'fr')).toMatch(/1\s?500\s?FCFA/);
    expect(formatMoney('19.99', 'USD', 'en')).toBe('$19.99');
    expect(formatMoney(null, 'USD', 'en')).toBeNull();
  });
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
