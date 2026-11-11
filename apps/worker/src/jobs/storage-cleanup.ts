import type { PrismaClient } from '@touma/database';
import type { ObjectStorage } from '@touma/storage';

export const MAX_DELETE_ATTEMPTS = 20;

/** Exponential backoff: 1 min, 2, 4 ... capped at 6 h. */
export function nextDelayMs(attempts: number) {
  return Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Retries storage deletions that failed in the API (e.g. storage outage). A missing object counts
 * as deleted. After MAX_DELETE_ATTEMPTS the row stays pending with its last error for an operator.
 */
export async function processPendingDeletions(prisma: PrismaClient, storage: ObjectStorage, now = new Date(), batch = 100) {
  const due = await prisma.storageDeletion.findMany({
    where: { completedAt: null, nextAttemptAt: { lte: now }, attempts: { lt: MAX_DELETE_ATTEMPTS } },
    orderBy: { nextAttemptAt: 'asc' },
    take: batch,
  });
  let deleted = 0;
  let failed = 0;
  for (const row of due) {
    try {
      await storage.delete(row.storageKey);
      await prisma.storageDeletion.update({ where: { id: row.id }, data: { completedAt: new Date(), attempts: { increment: 1 }, lastError: null } });
      deleted++;
    } catch (err) {
      const attempts = row.attempts + 1;
      await prisma.storageDeletion.update({
        where: { id: row.id },
        data: { attempts, lastError: (err as Error).message.slice(0, 300), nextAttemptAt: new Date(now.getTime() + nextDelayMs(attempts)) },
      });
      failed++;
    }
  }
  return { processed: due.length, deleted, failed };
}

/** Removes expired or used auth tokens older than a day (they are useless and only add risk). */
export async function purgeAuthTokens(prisma: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 3600_000);
  const res = await prisma.authToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] } });
  return res.count;
}
