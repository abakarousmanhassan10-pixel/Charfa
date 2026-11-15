/**
 * Billing rules that do not depend on any payment provider (N24, reworked in N26).
 * Pure functions: they read nothing and charge nothing.
 */

/** The free trial is 72 hours, once per business. */
export const TRIAL_HOURS = 72;
/** Default grace period after a period ends unpaid; the server makes it configurable (BILLING_GRACE_DAYS). */
export const DEFAULT_GRACE_DAYS = 3;
/** @deprecated use DEFAULT_GRACE_DAYS */
export const PAST_DUE_GRACE_DAYS = DEFAULT_GRACE_DAYS;

// ─── Subscription state machine ────────────────────────────────────────────

export const SUBSCRIPTION_STATES = ['PENDING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export const BILLING_MODES = ['AUTO', 'MANUAL'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const BILLING_INTERVALS = ['MONTHLY', 'YEARLY'] as const;
export type BillingIntervalName = (typeof BILLING_INTERVALS)[number];

/**
 * Allowed transitions. PENDING = created, nothing confirmed yet. ACTIVE = access (a trial is ACTIVE until its end date).
 * PAST_DUE = an automatic renewal failed and the provider is retrying. GRACE_PERIOD = the period ended unpaid (or retries ran out) and access
 * continues for the grace days. CANCELED = ended by the customer or the provider, access until the paid period ends. EXPIRED = no access.
 * A subscription becomes ACTIVE only from a payment confirmed by a verified provider event, never from a browser return.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionState, readonly SubscriptionState[]> = {
  PENDING: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  ACTIVE: ['PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED'],
  PAST_DUE: ['ACTIVE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED'],
  GRACE_PERIOD: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  CANCELED: ['ACTIVE', 'EXPIRED'],
  EXPIRED: ['ACTIVE'],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Subscription cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
export function canTransition(from: SubscriptionState, to: SubscriptionState): boolean {
  return from === to || SUBSCRIPTION_TRANSITIONS[from].includes(to);
}
export function assertTransition(from: SubscriptionState, to: SubscriptionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

// ─── Money: integer minor units only ───────────────────────────────────────

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export function currencyExponent(currency: string): 0 | 2 | 3 {
  const c = currency.toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
}
export function assertMinor(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Amounts are non-negative integers in minor units');
  return n;
}
/** "19.99" -> 1999 (USD). Exact string arithmetic; throws on more decimals than the currency has or on anything that is not a plain decimal. */
export function majorToMinor(value: string, currency: string): number {
  const exp = currencyExponent(currency);
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new RangeError('Invalid amount');
  const frac = m[2] ?? '';
  if (frac.length > exp) throw new RangeError('Too many decimals for this currency');
  return assertMinor(Number(m[1] + frac.padEnd(exp, '0')));
}
export function minorToMajorString(minor: number, currency: string): string {
  assertMinor(minor);
  const exp = currencyExponent(currency);
  if (exp === 0) return String(minor);
  const s = String(minor).padStart(exp + 1, '0');
  return `${s.slice(0, -exp)}.${s.slice(-exp)}`;
}
/** Display only. The decimal string goes to Intl as a string, so no floating-point value is ever computed. */
export function formatMinor(minor: number, currency: string, locale = 'en'): string {
  const exp = currencyExponent(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minorToMajorString(minor, currency) as unknown as number);
  } catch {
    return `${minorToMajorString(minor, currency)} ${currency.toUpperCase()}`;
  }
}

// ─── Periods (UTC; display in the business time zone) ──────────────────────

/** Adds calendar months in UTC, clamping to the end of a shorter month (31 Jan + 1 month = 28/29 Feb), so renewals never drift or skip. */
export function addMonthsUtc(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}
export function addInterval(from: Date, interval: BillingIntervalName): Date {
  return addMonthsUtc(from, interval === 'YEARLY' ? 12 : 1);
}
export function trialEndsAt(from: Date): Date {
  return new Date(from.getTime() + TRIAL_HOURS * 3_600_000);
}

// ─── Entitlement ───────────────────────────────────────────────────────────

export type EntitlementState = 'FOUNDER_LIFETIME' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'GRACE_PERIOD' | 'CANCELED_UNTIL_PERIOD_END' | 'PENDING' | 'EXPIRED' | 'NONE';

export interface EntitlementInput {
  now: Date;
  /** The founder (verified owner e-mail on the server allow-list) keeps free access for life. */
  isFounder: boolean;
  /** Days of access after a period ends unpaid. */
  graceDays?: number;
  subscription?: {
    status: string;
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

export function isTrialPeriod(s: { trialEndsAt: Date | null; currentPeriodEnd: Date | null }): boolean {
  return !!s.trialEndsAt && !!s.currentPeriodEnd && s.currentPeriodEnd.getTime() <= s.trialEndsAt.getTime();
}

export function resolveEntitlement({ now, isFounder, graceDays = DEFAULT_GRACE_DAYS, subscription: s }: EntitlementInput): Entitlement {
  if (isFounder) return { state: 'FOUNDER_LIFETIME', hasAccess: true, chargeable: false, accessUntil: null };
  if (!s) return { state: 'NONE', hasAccess: false, chargeable: true, accessUntil: null };
  const t = now.getTime();
  const end = s.currentPeriodEnd;
  const graceEnd = end ? new Date(end.getTime() + graceDays * DAY) : null;
  const no = (state: EntitlementState, until: Date | null = null): Entitlement => ({ state, hasAccess: false, chargeable: true, accessUntil: until });
  switch (s.status) {
    case 'PENDING':
      return no('PENDING');
    case 'ACTIVE': {
      if (!end) return no('EXPIRED');
      const trial = isTrialPeriod(s);
      if (t < end.getTime()) return { state: trial ? 'TRIALING' : 'ACTIVE', hasAccess: true, chargeable: true, accessUntil: end };
      // Past the end without renewal: a trial simply ends; a paid period keeps the grace days (the sweep will record the state change).
      if (!trial && graceEnd && t < graceEnd.getTime()) return { state: 'GRACE_PERIOD', hasAccess: true, chargeable: true, accessUntil: graceEnd };
      return no('EXPIRED', end);
    }
    case 'PAST_DUE':
    case 'GRACE_PERIOD': {
      const ok = !!graceEnd && t < graceEnd.getTime();
      return ok ? { state: s.status, hasAccess: true, chargeable: true, accessUntil: graceEnd } : no('EXPIRED', graceEnd);
    }
    case 'CANCELED': {
      const ok = !!end && t < end.getTime();
      return ok ? { state: 'CANCELED_UNTIL_PERIOD_END', hasAccess: true, chargeable: true, accessUntil: end } : no('EXPIRED', end);
    }
    default:
      return no('EXPIRED');
  }
}

/** Provider-independent vocabulary. Provider adapters translate their own events into these. */
export const BILLING_EVENT_TYPES = ['payment_method.attached', 'subscription.activated', 'payment.succeeded', 'payment.failed', 'subscription.canceled'] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];
