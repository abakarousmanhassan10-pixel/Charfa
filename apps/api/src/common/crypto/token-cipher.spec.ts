import { randomBytes } from 'crypto';
import { TokenCipher, safeEqual, sha256 } from './token-cipher';

describe('TokenCipher', () => {
  const cipher = new TokenCipher(randomBytes(32).toString('base64'));

  it('round-trips and uses a random IV', () => {
    const a = cipher.encrypt('secret-token');
    const b = cipher.encrypt('secret-token');
    expect(a).not.toEqual(b);
    expect(a).not.toContain('secret-token');
    expect(cipher.decrypt(a)).toBe('secret-token');
  });

  it('detects tampering', () => {
    const parts = cipher.encrypt('secret-token').split(':');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
  });

  it('fails with another key', () => {
    const other = new TokenCipher(randomBytes(32).toString('base64'));
    expect(() => other.decrypt(cipher.encrypt('x'))).toThrow();
  });

  it('rejects wrong key length', () => {
    expect(() => new TokenCipher(randomBytes(16).toString('base64'))).toThrow();
  });

  it('helpers', () => {
    expect(sha256('a')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});
