import { Injectable } from '@nestjs/common';
import type { AuthTokenType } from '@touma/database';
import { randomToken, sha256 } from '../common/crypto/token-cipher';
import { PrismaService } from '../prisma/prisma.service';

export const TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  EMAIL_VERIFICATION: 24 * 3600_000,
  PASSWORD_RESET: 30 * 60_000,
};

/** Single-use, expiring tokens. Only SHA-256 hashes are stored; issuing a new token invalidates older ones. */
@Injectable()
export class AuthTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: string, type: AuthTokenType, email: string, ipAddress: string | null) {
    const token = randomToken(32);
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { expiresAt: new Date() } }),
      this.prisma.authToken.create({ data: { userId, type, email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS[type]), ipAddress } }),
    ]);
    return token;
  }

  async lastIssuedAt(userId: string, type: AuthTokenType) {
    const t = await this.prisma.authToken.findFirst({ where: { userId, type }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return t?.createdAt ?? null;
  }

  /** Atomically marks the token used. Returns null for unknown, expired, used or wrong-type tokens. */
  async consume(token: string, type: AuthTokenType) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date()) return null;
    const claimed = await this.prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return claimed.count === 1 ? row : null;
  }
}
