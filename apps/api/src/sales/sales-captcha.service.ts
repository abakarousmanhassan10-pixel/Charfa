import { Injectable, Logger } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Optional bot protection for starting a customer chat (Cloudflare Turnstile). Off unless configured; fails CLOSED when on. */
@Injectable()
export class SalesCaptchaService {
  private readonly logger = new Logger('SalesCaptcha');
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  get enabled() {
    return this.env.CHAT_CAPTCHA_PROVIDER === 'turnstile';
  }

  /** What the browser needs to show the challenge (the site key is public by design; the secret never leaves the server). */
  publicConfig() {
    return this.enabled ? { provider: 'turnstile' as const, siteKey: this.env.TURNSTILE_SITE_KEY ?? '' } : null;
  }

  /** True when no challenge is required or the token is valid. A provider outage counts as "not verified". */
  async verify(token: string | undefined, ip?: string): Promise<boolean> {
    if (!this.enabled) return true;
    if (!token) return false;
    try {
      const body = new URLSearchParams({ secret: this.env.TURNSTILE_SECRET ?? '', response: token, ...(ip ? { remoteip: ip } : {}) });
      const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return false;
      return ((await res.json()) as { success?: boolean }).success === true;
    } catch {
      this.logger.warn('captcha verification could not reach the provider');
      return false;
    }
  }
}
