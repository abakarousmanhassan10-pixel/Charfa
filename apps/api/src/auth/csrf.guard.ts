import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppEnv, InjectEnv } from '../config';

export const CSRF_HEADER = 'x-aima-csrf';

/**
 * CSRF protection for endpoints authenticated by the refresh cookie (refresh, logout).
 * Defence in depth on top of SameSite=Strict cookies:
 *  1. A custom header is required. Browsers cannot attach custom headers cross-origin without a
 *     CORS preflight, which our CORS policy rejects for unknown origins.
 *  2. If an Origin header is present it must be an allowed origin.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'Missing CSRF header' });
    }
    const origin = req.headers.origin;
    if (origin && !this.env.CORS_ORIGINS.includes(origin) && origin !== this.env.WEB_URL) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'Origin not allowed' });
    }
    return true;
  }
}
