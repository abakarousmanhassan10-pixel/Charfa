import { randomBytes } from 'crypto';
import { MediaUrlSigner } from './signed-url';

describe('MediaUrlSigner', () => {
  const signer = new MediaUrlSigner(randomBytes(32).toString('base64'), 3600);
  const now = Date.UTC(2026, 0, 1, 10, 15);

  it('signs and verifies, with stable URLs within a window', () => {
    const a = signer.sign('m1', now);
    expect(signer.verify('m1', a.exp, a.sig, now)).toBe(true);
    expect(signer.sign('m1', now + 60_000)).toEqual(a);
  });

  it('rejects other ids, tampered signatures, expiry and far-future expiries', () => {
    const a = signer.sign('m1', now);
    expect(signer.verify('m2', a.exp, a.sig, now)).toBe(false);
    expect(signer.verify('m1', a.exp, a.sig.slice(0, -1) + 'A', now)).toBe(false);
    expect(signer.verify('m1', a.exp, a.sig, a.exp + 1)).toBe(false);
    expect(signer.verify('m1', now + 10 * 3600_000, a.sig, now)).toBe(false);
  });

  it('signatures from another key are rejected', () => {
    const other = new MediaUrlSigner(randomBytes(32).toString('base64'), 3600);
    const a = other.sign('m1', now);
    expect(signer.verify('m1', a.exp, a.sig, now)).toBe(false);
  });
});
