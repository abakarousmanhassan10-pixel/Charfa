import { safeRequestId, safeUrl } from './safe-log';

describe('safe-log', () => {
  it('keeps the path and parameter names but never query values', () => {
    expect(safeUrl('/api/v1/public/chat/shop/messages?token=SECRET123')).toBe('/api/v1/public/chat/shop/messages?token=[redacted]');
    expect(safeUrl('/api/v1/social/oauth/callback/x?code=abc&state=def&code=again')).toBe('/api/v1/social/oauth/callback/x?code=[redacted]&state=[redacted]');
    expect(safeUrl('/health')).toBe('/health');
    expect(safeUrl(undefined)).toBe('-');
    expect(safeUrl('/p?a=1&' + 'b'.repeat(500) + '=x')).not.toContain('b'.repeat(41));
    expect(safeUrl('/x?' + 'q=1&'.repeat(5) + Array.from({ length: 30 }, (_, i) => `k${i}=v`).join('&')).split('&').length).toBeLessThanOrEqual(10);
  });
  it('accepts only clean request ids', () => {
    expect(safeRequestId('abc-123', 'zzz')).toBe('abc-123');
    expect(safeRequestId(undefined, 'good_id-1')).toBe('good_id-1');
    expect(safeRequestId(undefined, 'bad id\nforged line')).toBeUndefined();
    expect(safeRequestId(undefined, 'x'.repeat(65))).toBeUndefined();
    expect(safeRequestId(undefined, ['a'])).toBeUndefined();
  });
});
