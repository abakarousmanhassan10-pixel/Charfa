import { PAST_DUE_GRACE_DAYS, TRIAL_HOURS, resolveEntitlement, trialEndsAt } from './billing';

const now = new Date('2026-12-01T12:00:00Z');
const h = (n: number) => new Date(now.getTime() + n * 3_600_000);

describe('billing entitlement', () => {
  it('trial lasts exactly 72 hours', () => {
    expect(TRIAL_HOURS).toBe(72);
    expect(trialEndsAt(now).getTime() - now.getTime()).toBe(72 * 3_600_000);
  });
  it('the founder has lifetime free access and is never chargeable, whatever the subscription says', () => {
    for (const status of ['CANCELED', 'UNPAID', 'PAST_DUE', 'INCOMPLETE'] as const) {
      expect(resolveEntitlement({ now, isFounder: true, subscription: { status, trialEndsAt: null, currentPeriodEnd: h(-1000), cancelAtPeriodEnd: false } })).toEqual({ state: 'FOUNDER_LIFETIME', hasAccess: true, chargeable: false, accessUntil: null });
    }
    expect(resolveEntitlement({ now, isFounder: true }).hasAccess).toBe(true);
  });
  it('no subscription means no access (trial not started)', () => {
    expect(resolveEntitlement({ now, isFounder: false })).toMatchObject({ state: 'NONE', hasAccess: false });
  });
  it('trial grants access until its end, then expires', () => {
    const sub = (e: Date) => ({ status: 'TRIALING' as const, trialEndsAt: e, currentPeriodEnd: null, cancelAtPeriodEnd: false });
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub(h(1)) }).state).toBe('TRIALING');
    expect(resolveEntitlement({ now, isFounder: false, subscription: sub(h(0)) }).state).toBe('EXPIRED');
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...sub(h(1)), trialEndsAt: null } }).hasAccess).toBe(false);
  });
  it('active, past due (grace), canceled (until period end)', () => {
    const base = { trialEndsAt: null, cancelAtPeriodEnd: false };
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...base, status: 'ACTIVE', currentPeriodEnd: h(24) } }).state).toBe('ACTIVE');
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...base, status: 'PAST_DUE', currentPeriodEnd: h(-24) } }).state).toBe('PAST_DUE_GRACE');
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...base, status: 'PAST_DUE', currentPeriodEnd: h(-24 * (PAST_DUE_GRACE_DAYS + 1)) } }).state).toBe('EXPIRED');
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...base, status: 'CANCELED', currentPeriodEnd: h(5) } }).state).toBe('CANCELED_UNTIL_PERIOD_END');
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...base, status: 'CANCELED', currentPeriodEnd: h(-5) } }).hasAccess).toBe(false);
    expect(resolveEntitlement({ now, isFounder: false, subscription: { ...base, status: 'UNPAID', currentPeriodEnd: h(5) } }).hasAccess).toBe(false);
  });
});
