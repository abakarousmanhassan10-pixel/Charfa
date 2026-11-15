import { DEFAULT_GRACE_DAYS, InvalidTransitionError, SUBSCRIPTION_STATES, SUBSCRIPTION_TRANSITIONS, TRIAL_HOURS, addInterval, addMonthsUtc, assertMinor, assertTransition, canTransition, currencyExponent, formatMinor, majorToMinor, minorToMajorString, resolveEntitlement, trialEndsAt } from './billing';

const now = new Date('2026-12-01T12:00:00Z');
const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
const d = (n: number) => h(n * 24);

describe('billing state machine', () => {
  it('every state has a transition table; no state can reach itself by accident or an unknown state', () => {
    for (const s of SUBSCRIPTION_STATES) {
      expect(SUBSCRIPTION_TRANSITIONS[s]).toBeDefined();
      for (const to of SUBSCRIPTION_TRANSITIONS[s]) expect(SUBSCRIPTION_STATES).toContain(to);
    }
  });
  it('allows the lifecycle and refuses shortcuts', () => {
    expect(canTransition('PENDING', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'PAST_DUE')).toBe(true);
    expect(canTransition('PAST_DUE', 'GRACE_PERIOD')).toBe(true);
    expect(canTransition('GRACE_PERIOD', 'ACTIVE')).toBe(true);
    expect(canTransition('EXPIRED', 'ACTIVE')).toBe(true); // a confirmed payment restarts it
    expect(canTransition('PENDING', 'PAST_DUE')).toBe(false);
    expect(canTransition('PENDING', 'GRACE_PERIOD')).toBe(false);
    expect(canTransition('EXPIRED', 'GRACE_PERIOD')).toBe(false);
    expect(canTransition('EXPIRED', 'CANCELED')).toBe(false);
    expect(canTransition('CANCELED', 'PAST_DUE')).toBe(false);
    expect(() => assertTransition('PENDING', 'PAST_DUE')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('ACTIVE', 'EXPIRED')).not.toThrow();
  });
});

describe('money in minor units', () => {
  it('converts exactly, without floating point', () => {
    expect(majorToMinor('19.99', 'USD')).toBe(1999);
    expect(majorToMinor('0.10', 'USD')).toBe(10);
    expect(majorToMinor('19', 'USD')).toBe(1900);
    expect(majorToMinor('1500', 'XAF')).toBe(1500);
    expect(majorToMinor('1.234', 'KWD')).toBe(1234);
    expect(minorToMajorString(1999, 'USD')).toBe('19.99');
    expect(minorToMajorString(5, 'USD')).toBe('0.05');
    expect(minorToMajorString(1500, 'XAF')).toBe('1500');
    expect(currencyExponent('jpy')).toBe(0);
  });
  it('refuses floats, negatives, too many decimals and unsafe integers', () => {
    expect(() => majorToMinor('19.999', 'USD')).toThrow();
    expect(() => majorToMinor('1.5', 'XAF')).toThrow();
    expect(() => majorToMinor('-1', 'USD')).toThrow();
    expect(() => majorToMinor('1e3', 'USD')).toThrow();
    expect(() => assertMinor(1.5)).toThrow();
    expect(() => assertMinor(-1)).toThrow();
    expect(() => assertMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(formatMinor(1999, 'USD', 'en')).toBe('$19.99');
  });
});

describe('periods', () => {
  it('trial lasts exactly 72 hours', () => {
    expect(TRIAL_HOURS).toBe(72);
    expect(trialEndsAt(now).getTime() - now.getTime()).toBe(72 * 3_600_000);
  });
  it('adds months in UTC with end-of-month clamping, never drifting', () => {
    expect(addMonthsUtc(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonthsUtc(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addInterval(new Date('2026-12-15T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(addInterval(new Date('2028-02-29T00:00:00Z'), 'YEARLY').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
});

describe('billing entitlement', () => {
  const sub = (status: string, end: Date | null, trialEndsAt: Date | null = null) => ({ status, trialEndsAt, currentPeriodEnd: end, cancelAtPeriodEnd: false });
  it('the founder has lifetime free access and is never chargeable, whatever the subscription says', () => {
    for (const status of ['CANCELED', 'EXPIRED', 'PAST_DUE', 'PENDING']) {
      expect(resolveEntitlement({ now, isFounder: true, subscription: sub(status, h(-1000)) })).toEqual({ state: 'FOUNDER_LIFETIME', hasAccess: true, chargeable: false, accessUntil: null });
    }
    expect(resolveEntitlement({ now, isFounder: true }).hasAccess).toBe(true);
  });
  it('no subscription or a pending one means no access', () => {
    expect(resolveEntitlement({ now, isFounder: false })).toMatchObject({ state: 'NONE', hasAccess: false });
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('PENDING', null) })).toMatchObject({ state: 'PENDING', hasAccess: false });
  });
  it('a trial is ACTIVE with a trial end date: access until it ends, no grace afterwards', () => {
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('ACTIVE', h(1), h(1)) }).state).toBe('TRIALING');
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('ACTIVE', h(0), h(0)) })).toMatchObject({ state: 'EXPIRED', hasAccess: false });
  });
  it('a paid period ends into the configurable grace period, then expires', () => {
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('ACTIVE', d(2), d(-30)) }).state).toBe('ACTIVE'); // paid: period end beyond the old trial end
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('ACTIVE', h(-1), h(-100)) }).state).toBe('GRACE_PERIOD');
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('ACTIVE', d(-DEFAULT_GRACE_DAYS - 1), h(-9000)) }).state).toBe('EXPIRED');
    expect(resolveEntitlement({ now, isFounder: false, graceDays: 0, subscription: sub('ACTIVE', h(-1), h(-100)) }).hasAccess).toBe(false);
    expect(resolveEntitlement({ now, isFounder: false, graceDays: 10, subscription: sub('ACTIVE', d(-8), h(-9000)) }).hasAccess).toBe(true);
  });
  it('past due and grace keep access until the grace days run out; canceled keeps the paid period; expired has none', () => {
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('PAST_DUE', d(-1)) })).toMatchObject({ state: 'PAST_DUE', hasAccess: true });
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('GRACE_PERIOD', d(-1)) })).toMatchObject({ state: 'GRACE_PERIOD', hasAccess: true });
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('GRACE_PERIOD', d(-5)) }).state).toBe('EXPIRED');
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('CANCELED', d(5)) }).state).toBe('CANCELED_UNTIL_PERIOD_END');
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('CANCELED', d(-5)) }).hasAccess).toBe(false);
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('EXPIRED', d(5)) }).hasAccess).toBe(false);
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub('UNPAID', d(5)) }).hasAccess).toBe(false); // legacy value: never grants access
  });
});
