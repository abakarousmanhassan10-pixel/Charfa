import { createHmac, hkdfSync } from 'crypto';
import { safeEqual } from '../common/crypto/token-cipher';

export type MediaVariant = 'original' | 'thumb';

/**
 * Signed, expiring media URLs served by the API (the bucket stays private and the browser never
 * sees storage credentials). The signature covers the media id, the variant and the expiry.
 * Expiry is rounded up to a window so URLs are stable and cacheable.
 */
export class MediaUrlSigner {
  private readonly key: Buffer;

  constructor(
    masterKeyBase64: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(masterKeyBase64, 'base64'), Buffer.alloc(0), 'touma-media-url-v1', 32));
  }

  private sig(mediaId: string, variant: MediaVariant, exp: number) {
    const payload = variant === 'original' ? `${mediaId}.${exp}` : `${mediaId}.${variant}.${exp}`;
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  sign(mediaId: string, now = Date.now(), variant: MediaVariant = 'original'): { exp: number; sig: string } {
    const window = this.ttlSeconds * 1000;
    const exp = Math.ceil((now + window) / window) * window;
    return { exp, sig: this.sig(mediaId, variant, exp) };
  }

  url(mediaId: string, now = Date.now(), variant: MediaVariant = 'original') {
    const { exp, sig } = this.sign(mediaId, now, variant);
    return `/api/v1/media/${mediaId}/content?exp=${exp}&sig=${sig}${variant === 'original' ? '' : `&variant=${variant}`}`;
  }

  verify(mediaId: string, exp: number, sig: string, now = Date.now(), variant: MediaVariant = 'original'): boolean {
    if (!Number.isFinite(exp) || exp < now || exp > now + 3 * this.ttlSeconds * 1000) return false;
    return safeEqual(this.sig(mediaId, variant, exp), sig);
  }
}
