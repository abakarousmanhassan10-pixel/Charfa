import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '@touma/database';

/**
 * Serializes quota decisions for one tenant and one resource. Take it inside the transaction that counts and inserts, so two
 * simultaneous requests cannot both see "one slot left". Counts are always derived from row statuses (never a stored counter),
 * so a finished, failed or cancelled job frees its slot by itself and accounting cannot drift.
 */
export async function lockTenantQuota(tx: Prisma.TransactionClient, scope: string, businessId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${scope}:${businessId}`}))`;
}

export function quotaExceeded(code: string, message: string): HttpException {
  return new HttpException({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
}
