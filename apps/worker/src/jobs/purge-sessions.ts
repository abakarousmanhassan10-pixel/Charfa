import type { PrismaClient } from '@touma/database';

/** Deletes refresh sessions that expired or were revoked more than `retentionDays` ago. */
export async function purgeExpiredSessions(prisma: PrismaClient, retentionDays = 30, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  const res = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return res.count;
}
