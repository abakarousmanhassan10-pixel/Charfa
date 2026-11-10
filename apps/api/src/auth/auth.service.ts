import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import type { User } from '@aima/database';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256 } from '../common/crypto/token-cipher';
import type { RequestMeta } from '../common/request-meta';
import { PasswordService } from './password.service';
import type { AuthUserResponse, LoginDto, RegisterDto } from './dto/auth.dto';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const REFRESH_REUSE_GRACE_MS = 10_000;

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: User['platformRole'];
  email: string;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: AuthUserResponse;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  static toUserResponse(user: User): AuthUserResponse {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      locale: user.locale,
      timezone: user.timezone,
      platformRole: user.platformRole,
      emailVerified: Boolean(user.emailVerifiedAt),
      createdAt: user.createdAt.toISOString(),
    };
  }

  async register(dto: RegisterDto, meta: RequestMeta): Promise<IssuedTokens> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      await this.audit.record({ action: 'auth.register_conflict', ...meta, metadata: { email: dto.email } });
      throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'An account with this email already exists' });
    }
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await this.passwords.hash(dto.password),
        fullName: dto.fullName,
        locale: dto.locale ?? 'en',
      },
    });
    await this.audit.record({ action: 'auth.register', actorId: user.id, entityType: 'User', entityId: user.id, ...meta });
    return this.issueTokens(user, meta);
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const invalid = () =>
      new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });

    if (!user || user.deletedAt) {
      // Spend the same time as a real verification to avoid user enumeration by timing.
      await this.passwords.verifyDummy(dto.password);
      await this.audit.record({ action: 'auth.login_failed', ...meta, metadata: { email: dto.email, reason: 'unknown_user' } });
      throw invalid();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({ action: 'auth.login_locked', actorId: user.id, ...meta });
      throw new UnauthorizedException({
        code: 'ACCOUNT_LOCKED',
        message: 'Too many failed attempts. Try again later.',
      });
    }

    const ok = await this.passwords.verify(user.passwordHash, dto.password);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : undefined,
        },
      });
      await this.audit.record({
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        actorId: user.id,
        ...meta,
        metadata: { reason: 'bad_password', failedCount: failed },
      });
      throw invalid();
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({ action: 'auth.login_blocked', actorId: user.id, ...meta, metadata: { status: user.status } });
      throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'This account is not active' });
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ action: 'auth.login', actorId: user.id, ...meta });
    return this.issueTokens(updated, meta);
  }

  /**
   * Rotating refresh tokens with reuse detection.
   * A refresh token can be exchanged exactly once. Presenting an already-rotated token
   * revokes the entire session family (likely token theft).
   */
  async refresh(refreshToken: string | undefined, meta: RequestMeta): Promise<IssuedTokens> {
    const unauthorized = () =>
      new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', message: 'Session expired. Please sign in again.' });
    if (!refreshToken || refreshToken.length > 512) throw unauthorized();

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!session) throw unauthorized();

    if (session.revokedAt) {
      // Two tabs refreshing at the same moment: the loser presents a just-rotated token.
      // Inside a short grace window this is not treated as theft; the client retries with the new cookie.
      const justRotated =
        session.replacedById && Date.now() - session.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS;
      if (justRotated) {
        throw new UnauthorizedException({ code: 'REFRESH_RACE', message: 'Session was just refreshed; retry.' });
      }
      await this.prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        action: 'auth.refresh_reuse_detected',
        actorId: session.userId,
        ...meta,
        metadata: { familyId: session.familyId },
      });
      throw unauthorized();
    }
    if (session.expiresAt <= new Date() || session.user.status !== 'ACTIVE' || session.user.deletedAt) {
      throw unauthorized();
    }

    // Atomically claim the session; a concurrent refresh with the same token loses the race.
    const claimed = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() },
    });
    if (claimed.count !== 1) throw unauthorized();

    const tokens = await this.issueTokens(session.user, meta, session.familyId);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { replacedById: tokens.sessionId },
    });
    const { sessionId: _sid, ...rest } = tokens;
    return rest;
  }

  async logout(refreshToken: string | undefined, sessionId: string | undefined, meta: RequestMeta & { userId?: string }) {
    const where = sessionId
      ? { id: sessionId }
      : refreshToken
        ? { refreshTokenHash: sha256(refreshToken) }
        : null;
    if (!where) return;
    const session = await this.prisma.session.findFirst({ where });
    if (!session) return;
    await this.prisma.session.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ action: 'auth.logout', actorId: session.userId, ipAddress: meta.ipAddress, userAgent: meta.userAgent });
  }

  async logoutAll(userId: string, meta: RequestMeta) {
    const res = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ action: 'auth.logout_all', actorId: userId, ...meta, metadata: { sessions: res.count } });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.env.JWT_ACCESS_SECRET,
      algorithms: ['HS256'],
      issuer: 'aima-api',
      audience: 'aima-web',
    });
  }

  private async issueTokens(
    user: User,
    meta: RequestMeta,
    familyId: string = randomUUID(),
  ): Promise<IssuedTokens & { sessionId: string }> {
    const refreshToken = randomToken(48);
    const refreshTokenExpiresAt = new Date(Date.now() + this.env.JWT_REFRESH_TTL_SECONDS * 1000);
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: sha256(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
    const payload: AccessTokenPayload = { sub: user.id, sid: session.id, role: user.platformRole, email: user.email };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.env.JWT_ACCESS_SECRET,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
      algorithm: 'HS256',
      issuer: 'aima-api',
      audience: 'aima-web',
    });
    return {
      accessToken,
      accessTokenExpiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt,
      sessionId: session.id,
      user: AuthService.toUserResponse(user),
    };
  }
}
