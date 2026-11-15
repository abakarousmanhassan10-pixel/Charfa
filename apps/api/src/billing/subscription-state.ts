import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@touma/database';
import { InvalidTransitionError, assertTransition, type SubscriptionState } from '@touma/shared';

export type Tx = Prisma.TransactionClient;

/** Serializes everything that changes one subscription (renewals, webhooks, the due sweep): concurrent calls queue on the row lock. */
export async function lockSubscription(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${id} FOR UPDATE`;
}

export interface AuditContext {
  actorId?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}

/** Writes a subscription audit row (who, what, why). Never receives secrets or card data. */
export async function auditSubscription(tx: Tx, sub: { id: string; businessId: string }, action: string, ctx: AuditContext, change?: { from?: string; to?: string }): Promise<void> {
  await tx.subscriptionAuditLog.create({ data: { businessId: sub.businessId, subscriptionId: sub.id, actorId: ctx.actorId ?? null, action, fromStatus: change?.from ?? null, toStatus: change?.to ?? null, reason: ctx.reason, metadata: (ctx.metadata ?? {}) as Prisma.InputJsonValue } });
}

/**
 * The ONLY place a subscription status is written. The transition is validated against the state machine (a refused one is a 409 and nothing changes)
 * and every real change is recorded in SubscriptionAuditLog. `extra` carries the other columns of the same update (periods, counters).
 */
export async function setStatus(tx: Tx, sub: { id: string; businessId: string; status: string }, to: SubscriptionState, ctx: AuditContext, extra: Prisma.SubscriptionUncheckedUpdateInput = {}): Promise<void> {
  const from = sub.status as SubscriptionState;
  try {
    assertTransition(from, to);
  } catch (e) {
    if (e instanceof InvalidTransitionError) throw new ConflictException({ code: 'INVALID_TRANSITION', message: e.message });
    throw e;
  }
  await tx.subscription.update({ where: { id: sub.id }, data: { ...extra, status: to } });
  if (from !== to) await auditSubscription(tx, sub, 'status_changed', ctx, { from, to });
}
