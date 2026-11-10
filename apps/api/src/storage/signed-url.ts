import { createHmac, hkdfSync } from 'crypto';
import { safeEqual } from '../common/crypto/token-cipher';

/**
 * Signed, expiring media URLs served by the API (the bucket stays private and the browser never
 * sees storage credentials). Expiry is rounded up to a window so URLs are stable and cacheable.
 */
export class MediaUrlSigner {
  private readonly key: Buffer;

  constructor(
    masterKeyBase64: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(masterKeyBase64, 'base64'), Buffer.alloc(0), 'touma-media-url-v1', 32));
  }

  private sig(mediaId: string, exp: number) {
    return createHmac('sha256', this.key).update(`${mediaId}.${exp}`).digest('base64url');
  }

  sign(mediaId: string, now = Date.now()): { exp: number; sig: string } {
    const window = this.ttlSeconds * 1000;
    const exp = Math.ceil((now + window) / window) * window; // between ttl and 2×ttl from now
    return { exp, sig: this.sig(mediaId, exp) };
  }

  url(mediaId: string, now = Date.now()) {
    const { exp, sig } = this.sign(mediaId, now);
    return `/api/v1/media/${mediaId}/content?exp=${exp}&sig=${sig}`;
  }

  verify(mediaId: string, exp: number, sig: string, now = Date.now()): boolean {
    if (!Number.isFinite(exp) || exp < now || exp > now + 3 * this.ttlSeconds * 1000) return false;
    return safeEqual(this.sig(mediaId, exp), sig);
  }
}
