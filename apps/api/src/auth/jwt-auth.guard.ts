import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';

/**
 * Global guard: every route requires a valid access token unless marked @Public().
 * Besides verifying the JWT signature it checks that the session is still active and the
 * user is not suspended, so logout and account suspension take effect immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }

    let payload;
    try {
      payload = await this.auth.verifyAccessToken(header.slice(7));
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_ACCESS_TOKEN', message: 'Invalid or expired token' });
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: { revokedAt: true, expiresAt: true, user: { select: { status: true, deletedAt: true, platformRole: true } } },
    });
    // Rotated or logged-out sessions are revoked: their access tokens stop working immediately.
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== 'ACTIVE' ||
      session.user.deletedAt
    ) {
      throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'Session is no longer valid' });
    }

    req.user = { id: payload.sub, email: payload.email, platformRole: session.user.platformRole, sessionId: payload.sid };
    return true;
  }
}
