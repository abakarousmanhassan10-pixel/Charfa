import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessAccessGuard } from './business-access.guard';

const BID = 'ckbusiness00000000000001';

function ctx(req: Record<string, unknown>) {
  return { getHandler: () => () => undefined, switchToHttp: () => ({ getRequest: () => req }) } as never;
}

function setup(permission: string | undefined, membership: unknown) {
  const reflector = { get: jest.fn().mockReturnValue(permission) } as unknown as Reflector;
  const prisma = { membership: { findFirst: jest.fn().mockResolvedValue(membership) } };
  return { guard: new BusinessAccessGuard(reflector, prisma as never), prisma };
}

describe('BusinessAccessGuard', () => {
  const user = { id: 'u1' };

  it('returns 404 for non-members (does not leak existence)', async () => {
    const { guard } = setup('business.read', null);
    await expect(guard.canActivate(ctx({ params: { businessId: BID }, user }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 for malformed ids without querying', async () => {
    const { guard, prisma } = setup('business.read', null);
    await expect(guard.canActivate(ctx({ params: { businessId: "x' OR 1=1" }, user }))).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
  });

  it('queries only ACTIVE memberships of the caller in non-deleted businesses', async () => {
    const { guard, prisma } = setup('business.read', { id: 'm1', role: 'VIEWER' });
    await guard.canActivate(ctx({ params: { businessId: BID }, user }));
    expect(prisma.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: BID, userId: 'u1', status: 'ACTIVE', business: { deletedAt: null } } }),
    );
  });

  it('returns 403 when the role lacks the permission', async () => {
    const { guard } = setup('business.update', { id: 'm1', role: 'EDITOR' });
    await expect(guard.canActivate(ctx({ params: { businessId: BID }, user }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attaches the verified tenant context', async () => {
    const { guard } = setup('business.update', { id: 'm1', role: 'ADMIN' });
    const req: Record<string, unknown> = { params: { businessId: BID }, user };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ businessId: BID, membershipId: 'm1', role: 'ADMIN', userId: 'u1' });
  });

  it('denies by default when no permission metadata is set', async () => {
    const { guard } = setup(undefined, { id: 'm1', role: 'OWNER' });
    await expect(guard.canActivate(ctx({ params: { businessId: BID }, user }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
