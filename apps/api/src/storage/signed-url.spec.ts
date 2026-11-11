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

describe('MediaUrlSigner variants', () => {
  const signer = new MediaUrlSigner(Buffer.alloc(32, 3).toString('base64'), 3600);
  it('a thumbnail signature cannot be used for the original and vice versa', () => {
    const now = Date.now();
    const t = signer.sign('m1', now, 'thumb');
    expect(signer.verify('m1', t.exp, t.sig, now, 'thumb')).toBe(true);
    expect(signer.verify('m1', t.exp, t.sig, now, 'original')).toBe(false);
    const o = signer.sign('m1', now);
    expect(signer.verify('m1', o.exp, o.sig, now, 'thumb')).toBe(false);
    expect(signer.url('m1', now, 'thumb')).toMatch(/&variant=thumb$/);
  });
});
