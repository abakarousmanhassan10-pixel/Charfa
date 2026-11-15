import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type Payment } from '@touma/database';
import { addInterval, isTrialPeriod, majorToMinor, minorToMajorString, type BillingIntervalName, type SubscriptionState } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PAYMENT_PROVIDER } from './billing-provider';
import { FounderService } from './founder.service';
import { ProviderUnavailableError, type NormalizedBillingEvent, type PaymentProvider } from './payment-provider';
import { auditSubscription, lockSubscription, setStatus, type Tx } from './subscription-state';

const DAY = 86_400_000;
const fail = (Cls: typeof ConflictException | typeof NotFoundException | typeof ServiceUnavailableException, code: string, message: string) => new Cls({ code, message });

type SubWithPlans = Prisma.SubscriptionGetPayload<{ include: { plan: true; pendingPlan: true } }>;

export interface PeriodQuote { periodStart: Date; periodEnd: Date; amountMinor: number; currency: string; planCode: string; interval: BillingIntervalName }

/**
 * The money side of the subscription lifecycle (N26): which period a payment pays for, how a payment confirmation changes the subscription,
 * and how time moves it (reminders, grace, expiry). Rules that make it safe:
 *  - a subscription becomes ACTIVE only from a payment confirmed by a VERIFIED provider event (applyEvent); no browser call can do it;
 *  - every status write goes through setStatus (validated transitions, audit row);
 *  - every change to one subscription runs in a transaction holding that row's lock, so concurrent renewals/webhooks queue up;
 *  - a period is extended once: the invoice is unique per (subscription, period start), and a payment attempt has a unique idempotency key;
 *  - amounts are integer minor units end to end.
 */
@Injectable()
export class BillingEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly founders: FounderService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get graceDays() { return this.env.BILLING_GRACE_DAYS; }
  private get graceMs() { return this.env.BILLING_GRACE_DAYS * DAY; }

  // ─── Quotes ──────────────────────────────────────────────────────────────

  /** What the next payment of this subscription pays: the plan and interval that will apply (a pending plan change takes effect here) and the period it covers. */
  quote(sub: SubWithPlans, now: Date): PeriodQuote {
    const plan = sub.pendingPlan ?? sub.plan;
    const interval = (sub.pendingBillingInterval ?? sub.billingInterval) as BillingIntervalName;
    const end = sub.currentPeriodEnd;
    // The cadence is kept (the new period starts where the old one ended) unless the subscription lapsed: expired, never paid, a trial that already ended, or too late.
    const lapsed = !end || sub.status === 'EXPIRED' || sub.status === 'PENDING' || (isTrialPeriod(sub) && now.getTime() > end.getTime()) || now.getTime() > end.getTime() + this.graceMs;
    const periodStart = lapsed ? now : end;
    return { periodStart, periodEnd: addInterval(periodStart, interval), amountMinor: interval === 'YEARLY' ? plan.yearlyPriceAmountMinor : plan.priceAmountMinor, currency: plan.currency, planCode: plan.code, interval };
  }

  // ─── Manual renewal / first payment: a hosted payment session ──────────

  /**
   * Starts a payment for the next period on the provider's hosted page. Repeating the request returns the same pending session (one attempt per
   * subscription + period + attempt number). Nothing changes on the subscription until the provider confirms the payment through a verified event.
   */
  async createRenewalPayment(t: TenantContext, userId: string, returnUrl: string, kind: 'RENEWAL_MANUAL' | 'INITIAL' = 'RENEWAL_MANUAL') {
    if (await this.founders.isFounder(t.businessId)) throw fail(ConflictException, 'FOUNDER_FREE_ACCESS', 'This account has free lifetime access: no payment is needed');
    const provider = this.requireProvider();
    const found = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: true, pendingPlan: true } });
    if (!found) throw fail(NotFoundException, 'NO_SUBSCRIPTION', 'Choose a plan first');
    if (found.provider !== 'none' && found.provider !== provider.id) throw fail(ConflictException, 'PROVIDER_MIGRATION_REQUIRED', 'The payment provider changed: save a card or start a payment with the current provider first');
    if (!provider.capabilities().hostedPaymentSession || provider.capabilities().hostedPaymentSession !== 'supported') throw fail(ServiceUnavailableException, 'CAPABILITY_UNSUPPORTED', 'This payment provider does not offer hosted payment sessions');
    const now = new Date();
    this.assertRenewable(found, now);

    // A customer reference at the provider (an e-mail goes to the provider; no card data exists here).
    let customerRef = found.providerCustomerId;
    if (!customerRef) {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
      customerRef = await this.guarded(async () => (await provider.createCustomer({ businessId: t.businessId, email: user.email })).customerRef);
    }

    return this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, found.id);
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: found.id }, include: { plan: true, pendingPlan: true } });
      if (!sub.providerCustomerId) await tx.subscription.update({ where: { id: sub.id }, data: { providerCustomerId: customerRef, provider: provider.id } });
      const q = this.quote(sub, now);
      const key = await this.nextRenewalKey(sub, tx);
      const existing = await tx.payment.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (existing.status === 'SUCCEEDED') throw fail(ConflictException, 'ALREADY_PAID', 'This period is already paid');
        return this.sessionView(existing);
      }
      if (await tx.invoice.findUnique({ where: { subscriptionId_periodStart: { subscriptionId: sub.id, periodStart: q.periodStart } } })) throw fail(ConflictException, 'ALREADY_PAID', 'This period is already paid');
      const session = await this.guarded(() => provider.createPaymentSession({ customerRef: customerRef!, amountMinor: q.amountMinor, currency: q.currency, reference: key, returnUrl }));
      const payment = await tx.payment.create({
        data: {
          businessId: sub.businessId, subscriptionId: sub.id, provider: provider.id, providerPaymentId: session.sessionRef, idempotencyKey: key, kind, status: 'PENDING', simulated: provider.id === 'simulated',
          amountMinor: q.amountMinor, amount: minorToMajorString(q.amountMinor, q.currency), currency: q.currency, periodStart: q.periodStart, periodEnd: q.periodEnd, sessionUrl: session.hostedUrl, description: `${q.planCode} ${q.interval}`,
        },
      });
      await auditSubscription(tx, sub, 'payment_session_created', { actorId: userId, reason: kind, metadata: { paymentId: payment.id, amountMinor: q.amountMinor, currency: q.currency, periodStart: q.periodStart } });
      return this.sessionView(payment);
    });
  }

  /**
   * Idempotency key of the next payment attempt: subscription + the period boundary being renewed (the end of the current period, or "initial") + the
   * attempt number (failed attempts so far + 1). The boundary does not move until a payment succeeds, so concurrent or repeated requests for the
   * same renewal produce the same key and can never create two charges; a declined attempt gets a fresh key for the retry.
   */
  async nextRenewalKey(sub: { id: string; currentPeriodEnd: Date | null }, db: Tx | PrismaService = this.prisma): Promise<string> {
    const prefix = `${sub.id}|${sub.currentPeriodEnd?.toISOString() ?? 'initial'}|`;
    const failed = await db.payment.count({ where: { subscriptionId: sub.id, idempotencyKey: { startsWith: prefix }, status: 'FAILED' } });
    return `${prefix}${failed + 1}`;
  }

  private sessionView(p: Payment) {
    return { paymentId: p.id, status: p.status, hostedUrl: p.sessionUrl, amountMinor: p.amountMinor, currency: p.currency, periodStart: p.periodStart, periodEnd: p.periodEnd, simulated: p.simulated };
  }

  /** A renewal can be started within the reminder window before the period ends, or any time once it has ended / was never paid. Paying months ahead is not offered. */
  private assertRenewable(sub: SubWithPlans, now: Date) {
    if (sub.status === 'PENDING' || sub.status === 'EXPIRED' || !sub.currentPeriodEnd) return;
    const remaining = sub.currentPeriodEnd.getTime() - now.getTime();
    if (remaining > this.env.BILLING_REMINDER_DAYS * DAY) throw fail(ConflictException, 'RENEWAL_NOT_DUE', 'The current period is paid; renewal opens a few days before it ends');
  }

  // ─── Provider events (the only way a payment changes a subscription) ───

  /** Applies one VERIFIED, already de-duplicated provider event. Returns false when it matches no subscription of this provider. */
  async applyEvent(e: NormalizedBillingEvent): Promise<boolean> {
    const or: Prisma.SubscriptionWhereInput[] = [];
    if (e.subscriptionRef) or.push({ providerSubscriptionId: e.subscriptionRef });
    if (e.customerRef) or.push({ providerCustomerId: e.customerRef });
    if (e.paymentRef) or.push({ payments: { some: { providerPaymentId: e.paymentRef } } });
    if (e.reference) or.push({ payments: { some: { idempotencyKey: e.reference } } });
    if (or.length === 0) return false;
    // Only subscriptions of the provider that sent the event: a reference from another provider can never match.
    const found = await this.prisma.subscription.findFirst({ where: { provider: this.provider?.id ?? 'none', OR: or }, select: { id: true } });
    if (!found) return false;
    return this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, found.id);
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: found.id }, include: { plan: true, pendingPlan: true } });
      await auditSubscription(tx, sub, 'provider_event', { reason: e.type, metadata: { eventId: e.id, provider: sub.provider } });
      switch (e.type) {
        case 'payment_method.attached':
          if (e.paymentMethodRef) await tx.subscription.update({ where: { id: sub.id }, data: { paymentMethodRef: e.paymentMethodRef } });
          break;
        case 'subscription.activated':
          // The provider confirms its recurring schedule. Access never starts from this: only a confirmed payment does.
          await auditSubscription(tx, sub, 'provider_subscription_confirmed', { reason: 'subscription.activated' });
          break;
        case 'payment.succeeded':
          await this.onPaymentSucceeded(tx, sub, e);
          break;
        case 'payment.failed':
          await this.onPaymentFailed(tx, sub, e);
          break;
        case 'subscription.canceled':
          await this.onProviderCanceled(tx, sub, e);
          break;
      }
      return true;
    });
  }

  private async findOrCreatePayment(tx: Tx, sub: SubWithPlans, e: NormalizedBillingEvent, status: 'SUCCEEDED' | 'FAILED') {
    const existing = (e.paymentRef ? await tx.payment.findUnique({ where: { providerPaymentId: e.paymentRef } }) : null) ?? (e.reference ? await tx.payment.findUnique({ where: { idempotencyKey: e.reference } }) : null);
    if (existing) return { payment: existing, created: false };
    // A charge made by the provider on its own schedule (automatic renewal): the period and amount are what the plan says for the next period.
    const q = this.quote(sub, e.occurredAt);
    const paid = e.amount && e.currency ? { amountMinor: majorToMinor(e.amount, e.currency), currency: e.currency.toUpperCase() } : { amountMinor: q.amountMinor, currency: q.currency };
    const payment = await tx.payment.create({
      data: {
        businessId: sub.businessId, subscriptionId: sub.id, provider: sub.provider, providerPaymentId: e.paymentRef ?? `evt:${e.id}`, idempotencyKey: e.reference ?? null, kind: 'RENEWAL_AUTO', status, simulated: sub.provider === 'simulated',
        amountMinor: paid.amountMinor, amount: minorToMajorString(paid.amountMinor, paid.currency), currency: paid.currency, periodStart: q.periodStart, periodEnd: q.periodEnd, description: `${q.planCode} ${q.interval}`,
      },
    });
    return { payment, created: true };
  }

  private async onPaymentSucceeded(tx: Tx, sub: SubWithPlans, e: NormalizedBillingEvent) {
    const { payment } = await this.findOrCreatePayment(tx, sub, e, 'SUCCEEDED');
    if (payment.status === 'SUCCEEDED' && payment.paidAt) {
      await auditSubscription(tx, sub, 'duplicate_confirmation_ignored', { reason: 'payment already confirmed', metadata: { paymentId: payment.id } });
      return;
    }
    const periodStart = payment.periodStart ?? e.occurredAt;
    const q = this.quote(sub, e.occurredAt);
    const periodEnd = payment.periodEnd ?? q.periodEnd;
    // The amount confirmed by the provider must be the amount this payment was created for.
    if (e.amount && e.currency && (majorToMinor(e.amount, e.currency) !== payment.amountMinor || e.currency.toUpperCase() !== payment.currency)) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED', paidAt: e.occurredAt, failureCode: 'amount_mismatch' } });
      await auditSubscription(tx, sub, 'amount_mismatch', { reason: 'confirmed amount differs from the expected amount: not extended, needs review', metadata: { paymentId: payment.id, expectedMinor: payment.amountMinor, expectedCurrency: payment.currency } });
      return;
    }
    // One extension per period: the invoice is unique per (subscription, period start). A second payment for an already paid period is recorded and flagged, never extended.
    const already = await tx.invoice.findUnique({ where: { subscriptionId_periodStart: { subscriptionId: sub.id, periodStart } } });
    if (already) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED', paidAt: e.occurredAt } });
      await auditSubscription(tx, sub, 'duplicate_payment_for_period', { reason: 'period already paid: needs a refund review', metadata: { paymentId: payment.id, invoiceId: already.id } });
      return;
    }
    const plan = sub.pendingPlan ?? sub.plan;
    const interval = (sub.pendingBillingInterval ?? sub.billingInterval) as BillingIntervalName;
    const number = await this.nextInvoiceNumber(tx, payment.simulated);
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED', paidAt: e.occurredAt, failureCode: null } });
    await tx.invoice.create({ data: { businessId: sub.businessId, subscriptionId: sub.id, number, status: 'PAID', amountMinor: payment.amountMinor, currency: payment.currency, planCode: plan.code, description: `${plan.name} (${interval === 'YEARLY' ? 'yearly' : 'monthly'})`, periodStart, periodEnd, paidAt: e.occurredAt, paymentId: payment.id, simulated: payment.simulated } });
    await setStatus(tx, sub, 'ACTIVE', { reason: 'payment confirmed by the provider', metadata: { paymentId: payment.id } }, {
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, failedPaymentCount: 0, lastPaymentFailureAt: null, cancelAtPeriodEnd: false, canceledAt: null,
      planId: plan.id, billingInterval: interval, amountMinor: interval === 'YEARLY' ? plan.yearlyPriceAmountMinor : plan.priceAmountMinor, currency: plan.currency, pendingPlanId: null, pendingBillingInterval: null,
    });
  }

  private async onPaymentFailed(tx: Tx, sub: SubWithPlans, e: NormalizedBillingEvent) {
    const { payment } = await this.findOrCreatePayment(tx, sub, e, 'FAILED');
    if (payment.status === 'SUCCEEDED') {
      await auditSubscription(tx, sub, 'late_failure_ignored', { reason: 'failure reported for a payment already confirmed', metadata: { paymentId: payment.id } });
      return;
    }
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureCode: e.failureCode ?? 'declined' } });
    const count = sub.failedPaymentCount + 1;
    const patch = { failedPaymentCount: count, lastPaymentFailureAt: e.occurredAt };
    const from = sub.status as SubscriptionState;
    if (sub.billingMode === 'AUTO' && (from === 'ACTIVE' || from === 'PAST_DUE')) {
      // Automatic renewal failed: the provider retries (PAST_DUE) until the configured number of failures, then the customer has the grace days to pay by hand.
      const exhausted = count >= this.env.BILLING_MAX_FAILED_PAYMENTS;
      await setStatus(tx, sub, exhausted ? 'GRACE_PERIOD' : 'PAST_DUE', { reason: exhausted ? 'automatic payment failed repeatedly' : 'automatic payment failed', metadata: { attempt: count, failureCode: e.failureCode ?? 'declined' } }, patch);
      await this.notifications.notify({ businessId: sub.businessId, permission: 'billing.manage', type: exhausted ? 'billing.grace_started' : 'billing.payment_failed', title: exhausted ? 'Payment failed repeatedly: update your payment within the grace period' : 'A subscription payment failed', data: { attempt: count }, dedupeKey: `billing:failed:${e.id}` });
    } else {
      await tx.subscription.update({ where: { id: sub.id }, data: patch });
      await auditSubscription(tx, sub, 'payment_failed', { reason: 'payment declined', metadata: { paymentId: payment.id, attempt: count } });
      await this.notifications.notify({ businessId: sub.businessId, permission: 'billing.manage', type: 'billing.payment_failed', title: 'A subscription payment failed', data: { attempt: count }, dedupeKey: `billing:failed:${e.id}` });
    }
  }

  private async onProviderCanceled(tx: Tx, sub: SubWithPlans, e: NormalizedBillingEvent) {
    const from = sub.status as SubscriptionState;
    if (from === 'CANCELED' || from === 'EXPIRED') return;
    const stillPaid = !!sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > e.occurredAt.getTime();
    await setStatus(tx, sub, stillPaid && from !== 'PENDING' ? 'CANCELED' : 'EXPIRED', { reason: 'subscription canceled at the provider' }, { canceledAt: e.occurredAt, cancelAtPeriodEnd: true });
    await this.notifications.notify({ businessId: sub.businessId, permission: 'billing.manage', type: 'billing.canceled', title: 'Your subscription has been canceled', dedupeKey: `billing:canceled:${e.id}` });
  }

  private async nextInvoiceNumber(tx: Tx, simulated: boolean): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`;
    return `${simulated ? 'SIM' : 'INV'}-${new Date().getUTCFullYear()}-${String(rows[0]!.n).padStart(6, '0')}`;
  }

  // ─── Time: reminders, grace, expiry ──────────────────────────────────────

  /**
   * Moves subscriptions through time. Safe to run repeatedly and concurrently (row lock, validated transitions, dedupe keys). Founders are skipped.
   *  - trial ended without payment -> EXPIRED (no grace for a trial)
   *  - paid period ended: AUTO -> PAST_DUE (the provider's charge is awaited), MANUAL -> GRACE_PERIOD; both keep access for the grace days
   *  - grace days over -> EXPIRED; canceled and period over -> EXPIRED
   *  - reminders: 24 h before a trial ends; BILLING_REMINDER_DAYS before a manual period ends
   * Not scheduled anywhere yet: a worker job calls it when billing goes live.
   */
  async processDue(now = new Date()) {
    const horizon = new Date(now.getTime() + Math.max(this.env.BILLING_REMINDER_DAYS, 1) * DAY);
    const subs = await this.prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED'] }, currentPeriodEnd: { not: null, lte: new Date(horizon.getTime() + DAY) } }, select: { id: true, businessId: true } });
    const out = { checked: subs.length, expired: 0, graceStarted: 0, pastDue: 0, reminders: 0 };
    for (const s of subs) {
      if (await this.founders.isFounder(s.businessId)) continue;
      await this.prisma.$transaction(async (tx) => {
        await lockSubscription(tx, s.id);
        const sub = await tx.subscription.findUniqueOrThrow({ where: { id: s.id } });
        const end = sub.currentPeriodEnd;
        if (!end) return;
        const status = sub.status as SubscriptionState;
        const ended = end.getTime() <= now.getTime();
        const trial = isTrialPeriod(sub);
        const graceOver = now.getTime() >= end.getTime() + this.graceMs;
        const ctx = { reason: 'due date processing' };
        const tell = (type: string, title: string, key: string, data: Record<string, unknown> = {}) => this.notifications.notify({ businessId: sub.businessId, permission: 'billing.manage', type, title, data, dedupeKey: key });
        if (status === 'CANCELED' && ended) { await setStatus(tx, sub, 'EXPIRED', { ...ctx, reason: 'canceled subscription reached the end of its paid period' }); out.expired++; return; }
        if (status === 'ACTIVE' && sub.cancelAtPeriodEnd && ended) { await setStatus(tx, sub, 'EXPIRED', { ...ctx, reason: 'canceled at period end' }); out.expired++; return; }
        if (status === 'ACTIVE' && trial && ended) {
          await setStatus(tx, sub, 'EXPIRED', { ...ctx, reason: 'trial ended without payment' }); out.expired++;
          await tell('billing.trial_ended', 'Your free trial has ended', `billing:ended:${sub.id}`);
          return;
        }
        if (status === 'ACTIVE' && !trial && ended) {
          const to = sub.billingMode === 'AUTO' ? 'PAST_DUE' : 'GRACE_PERIOD';
          await setStatus(tx, sub, to, { ...ctx, reason: sub.billingMode === 'AUTO' ? 'period ended, awaiting the provider charge' : 'period ended unpaid' });
          if (to === 'PAST_DUE') out.pastDue++; else out.graceStarted++;
          await tell('billing.renewal_overdue', 'Your subscription period has ended: renew within the grace period', `billing:overdue:${sub.id}:${end.toISOString()}`, { until: new Date(end.getTime() + this.graceMs) });
          return;
        }
        if ((status === 'PAST_DUE' || status === 'GRACE_PERIOD') && graceOver) {
          await setStatus(tx, sub, 'EXPIRED', { ...ctx, reason: 'grace period ended' }); out.expired++;
          await tell('billing.expired', 'Your subscription has expired', `billing:expired:${sub.id}:${end.toISOString()}`);
          return;
        }
        if (status === 'ACTIVE' && !ended) {
          const left = end.getTime() - now.getTime();
          if (trial && left <= DAY) { out.reminders += await tell('billing.trial_ending', 'Your free trial ends within 24 hours', `billing:ending:${sub.id}`, { trialEndsAt: end }); }
          else if (!trial && sub.billingMode === 'MANUAL' && !sub.cancelAtPeriodEnd && left <= this.env.BILLING_REMINDER_DAYS * DAY) {
            out.reminders += await tell('billing.renewal_reminder', 'Your subscription ends soon: renew to keep access', `billing:reminder:${sub.id}:${end.toISOString()}`, { periodEnd: end });
          }
        }
      });
    }
    return out;
  }

  private requireProvider(): PaymentProvider {
    if (!this.provider) throw fail(ServiceUnavailableException, 'BILLING_PROVIDER_NOT_CONFIGURED', 'No payment provider is configured on this server');
    return this.provider;
  }
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) {
      if (err instanceof ProviderUnavailableError) throw fail(ServiceUnavailableException, err.code, err.message);
      throw err;
    }
  }
}
