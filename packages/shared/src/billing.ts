/**
 * Billing rules that do not depend on any payment provider (N24).
 * Pure functions: they read nothing and charge nothing. They answer "what does this business have access to, and could it be charged?".
 */

/** The free trial is 72 hours, once per business. */
export const TRIAL_HOURS = 72;
/** After a failed renewal the merchant keeps access this long while the provider retries. */
export const PAST_DUE_GRACE_DAYS = 3;

export type EntitlementState = 'FOUNDER_LIFETIME' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE_GRACE' | 'CANCELED_UNTIL_PERIOD_END' | 'EXPIRED' | 'NONE';

export interface EntitlementInput {
  now: Date;
  /** The founder (verified owner e-mail on the server allow-list) keeps free access for life. */
  isFounder: boolean;
  subscription?: {
    status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' | 'UNPAID';
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

export interface Entitlement {
  state: EntitlementState;
  hasAccess: boolean;
  /** False for the founder: no payment may ever be requested. */
  chargeable: boolean;
  accessUntil: Date | null;
}

const DAY = 86_400_000;

export function trialEndsAt(from: Date): Date {
  return new Date(from.getTime() + TRIAL_HOURS * 3_600_000);
}

export function resolveEntitlement({ now, isFounder, subscription: s }: EntitlementInput): Entitlement {
  if (isFounder) return { state: 'FOUNDER_LIFETIME', hasAccess: true, chargeable: false, accessUntil: null };
  if (!s) return { state: 'NONE', hasAccess: false, chargeable: true, accessUntil: null };
  const t = now.getTime();
  switch (s.status) {
    case 'TRIALING': {
      const ok = !!s.trialEndsAt && t < s.trialEndsAt.getTime();
      return { state: ok ? 'TRIALING' : 'EXPIRED', hasAccess: ok, chargeable: true, accessUntil: s.trialEndsAt };
    }
    case 'ACTIVE': {
      const end = s.currentPeriodEnd;
      // An active subscription whose period ended long ago without renewal is not trusted forever.
      const ok = !end || t < end.getTime() + PAST_DUE_GRACE_DAYS * DAY;
      return { state: ok ? 'ACTIVE' : 'EXPIRED', hasAccess: ok, chargeable: true, accessUntil: end };
    }
    case 'PAST_DUE': {
      const until = s.currentPeriodEnd ? new Date(s.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY) : null;
      const ok = !!until && t < until.getTime();
      return { state: ok ? 'PAST_DUE_GRACE' : 'EXPIRED', hasAccess: ok, chargeable: true, accessUntil: until };
    }
    case 'CANCELED': {
      const ok = !!s.currentPeriodEnd && t < s.currentPeriodEnd.getTime();
      return { state: ok ? 'CANCELED_UNTIL_PERIOD_END' : 'EXPIRED', hasAccess: ok, chargeable: true, accessUntil: s.currentPeriodEnd };
    }
    default:
      return { state: 'EXPIRED', hasAccess: false, chargeable: true, accessUntil: null };
  }
}

/** Provider-independent vocabulary. Provider adapters translate their own events into these. */
export const BILLING_EVENT_TYPES = ['payment_method.attached', 'subscription.activated', 'payment.succeeded', 'payment.failed', 'subscription.canceled'] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];
