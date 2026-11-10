import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { loadEnv } from '@touma/config';
import { AuthService, MAX_FAILED_LOGINS } from './auth.service';
import { PasswordService } from './password.service';
import { sha256 } from '../common/crypto/token-cipher';

const env = loadEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
});
const meta = { ipAddress: '127.0.0.1', userAgent: 'jest' };

function baseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@example.com',
    passwordHash: 'hash',
    fullName: 'A',
    locale: 'en',
    timezone: 'UTC',
    platformRole: 'USER',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function setup() {
  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    session: {
      create: jest.fn().mockResolvedValue({ id: 's-new' }),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const passwords = {
    hash: jest.fn().mockResolvedValue('hashed'),
    verify: jest.fn(),
    verifyDummy: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<PasswordService>;
  const audit = { record: jest.fn() };
  const service = new AuthService(prisma as never, new JwtService({}), passwords, audit as never, env);
  return { prisma, passwords, audit, service };
}

describe('AuthService', () => {
  it('registers a user, hashes the password and stores only the refresh token hash', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(baseUser());
    const res = await service.register({ email: 'a@example.com', password: 'Abcdefghijk1', fullName: 'A' }, meta);
    expect(prisma.user.create.mock.calls[0][0].data.passwordHash).toBe('hashed');
    const stored = prisma.session.create.mock.calls[0][0].data.refreshTokenHash;
    expect(stored).toBe(sha256(res.refreshToken));
    expect(stored).not.toBe(res.refreshToken);
    expect(res.user).not.toHaveProperty('passwordHash');
  });

  it('rejects duplicate emails', async () => {
    const { prisma, service } = setup();
    prisma.user.findUnique.mockResolvedValue(baseUser());
    await expect(
      service.register({ email: 'a@example.com', password: 'Abcdefghijk1', fullName: 'A' }, meta),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('performs dummy verification for unknown users (timing) and returns a generic error', async () => {
    const { prisma, passwords, service } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.login({ email: 'x@example.com', password: 'p' }, meta)).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS' },
    });
    expect(passwords.verifyDummy).toHaveBeenCalled();
  });

  it('locks the account after too many failed attempts', async () => {
    const { prisma, passwords, service } = setup();
    prisma.user.findUnique.mockResolvedValue(baseUser({ failedLoginCount: MAX_FAILED_LOGINS - 1 }));
    passwords.verify.mockResolvedValue(false);
    await expect(service.login({ email: 'a@example.com', password: 'bad' }, meta)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.update.mock.calls[0][0].data.lockedUntil).toBeInstanceOf(Date);
  });

  it('refuses login while locked even with the right password', async () => {
    const { prisma, passwords, service } = setup();
    prisma.user.findUnique.mockResolvedValue(baseUser({ lockedUntil: new Date(Date.now() + 60_000) }));
    passwords.verify.mockResolvedValue(true);
    await expect(service.login({ email: 'a@example.com', password: 'ok' }, meta)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_LOCKED' },
    });
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it('refuses suspended accounts', async () => {
    const { prisma, passwords, service } = setup();
    prisma.user.findUnique.mockResolvedValue(baseUser({ status: 'SUSPENDED' }));
    passwords.verify.mockResolvedValue(true);
    await expect(service.login({ email: 'a@example.com', password: 'ok' }, meta)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_DISABLED' },
    });
  });

  it('revokes the whole family when a rotated refresh token is reused after the grace window', async () => {
    const { prisma, audit, service } = setup();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      familyId: 'f1',
      userId: 'u1',
      revokedAt: new Date(Date.now() - 60_000),
      replacedById: 's2',
      expiresAt: new Date(Date.now() + 60_000),
      user: baseUser(),
    });
    await expect(service.refresh('stolen', meta)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'f1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.refresh_reuse_detected' }));
  });

  it('does not revoke the family on a concurrent-refresh race inside the grace window', async () => {
    const { prisma, service } = setup();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      familyId: 'f1',
      userId: 'u1',
      revokedAt: new Date(),
      replacedById: 's2',
      expiresAt: new Date(Date.now() + 60_000),
      user: baseUser(),
    });
    await expect(service.refresh('t', meta)).rejects.toMatchObject({ response: { code: 'REFRESH_RACE' } });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('rotates a valid refresh token within the same family', async () => {
    const { prisma, service } = setup();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      familyId: 'f1',
      userId: 'u1',
      revokedAt: null,
      replacedById: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: baseUser(),
    });
    const res = await service.refresh('valid', meta);
    expect(prisma.session.create.mock.calls[0][0].data.familyId).toBe('f1');
    expect(prisma.session.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { replacedById: 's-new' } });
    expect(res).not.toHaveProperty('sessionId');
    const payload = await service.verifyAccessToken(res.accessToken);
    expect(payload).toMatchObject({ sub: 'u1', sid: 's-new' });
  });

  it('loses the race if the session was claimed concurrently', async () => {
    const { prisma, service } = setup();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      familyId: 'f1',
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: baseUser(),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.refresh('valid', meta)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('rejects access tokens signed with another secret', async () => {
    const { service } = setup();
    const forged = await new JwtService({}).signAsync(
      { sub: 'u1', sid: 's1' },
      { secret: 'x'.repeat(32), issuer: 'touma-api', audience: 'touma-web' },
    );
    await expect(service.verifyAccessToken(forged)).rejects.toThrow();
  });
});
