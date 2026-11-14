import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { resolveEntitlement, trialEndsAt } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PAYMENT_PROVIDER } from './billing-provider';
import { ProviderUnavailableError, type NormalizedBillingEvent, type PaymentProvider } from './payment-provider';

const err = (Cls: typeof ConflictException | typeof NotFoundException | typeof ServiceUnavailableException, code: string, message: string) => new Cls({ code, message });

/**
 * Subscription lifecycle on top of a PaymentProvider (N24). Nothing here touches a bank or card: card capture is hosted by the
 * provider, subscription state changes only from VERIFIED provider webhooks, and the founder is never charged.
 * Existing subscriptions are never modified by reads; a trial is created only by an explicit owner action.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /** Founder = an OWNER of the business whose VERIFIED, active account e-mail is on the server allow-list. */
  async isFounder(businessId: string): Promise<boolean> {
    if (this.env.FOUNDER_EMAILS.length === 0) return false;
    const owners = await this.prisma.membership.findMany({ where: { businessId, role: 'OWNER', status: 'ACTIVE', user: { status: 'ACTIVE', emailVerifiedAt: { not: null }, deletedAt: null } }, select: { user: { select: { email: true } } } });
    return owners.some((o) => this.env.FOUNDER_EMAILS.includes(o.user.email.toLowerCase()));
  }

  private requireProvider(): PaymentProvider {
    if (!this.provider) throw err(ServiceUnavailableException, 'BILLING_PROVIDER_NOT_CONFIGURED', 'No payment provider is configured on this server');
    return this.provider;
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw err(ServiceUnavailableException, e.code, e.message);
      throw e;
    }
  }

  async status(t: TenantContext) {
    const [sub, founder] = await Promise.all([this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: { select: { code: true, name: true, priceAmount: true, currency: true, interval: true } } } }), this.isFounder(t.businessId)]);
    const ent = resolveEntitlement({ now: new Date(), isFounder: founder, subscription: sub });
    return {
      enabled: this.env.BILLING_ENABLED,
      provider: this.provider?.capabilities() ?? null,
      entitlement: ent,
      subscription: sub ? { status: sub.status, plan: sub.plan.code, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, cardSaved: Boolean(sub.paymentMethodRef), failedPayments: sub.failedPaymentCount } : null,
      /** True when the saved customer/card belongs to another provider than the one now configured: a new card must be captured (see docs/BILLING.md). */
      providerMigration: { required: Boolean(sub && this.provider && sub.provider !== 'none' && sub.provider !== this.provider.id), from: sub?.provider ?? null },
    };
  }

  /** Starts the 72-hour trial. Once per business, no card needed, nothing charged. A founder has nothing to start. */
  async startTrial(t: TenantContext, planCode: 'STARTER' | 'PRO' | 'BUSINESS') {
    if (await this.isFounder(t.businessId)) throw err(ConflictException, 'FOUNDER_FREE_ACCESS', 'This account has free lifetime access: no trial or payment is needed');
    const plan = await this.prisma.plan.findFirst({ where: { code: planCode, isActive: true } });
    if (!plan) throw err(NotFoundException, 'PLAN_NOT_FOUND', 'Plan not found');
    const now = new Date();
    try {
      await this.prisma.subscription.create({ data: { businessId: t.businessId, planId: plan.id, status: 'TRIALING', provider: this.provider?.id ?? 'none', trialEndsAt: trialEndsAt(now) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw err(ConflictException, 'TRIAL_ALREADY_USED', 'This business already has a subscription or has used its trial');
      throw e;
    }
    return this.status(t);
  }

  /** Step 1 of saving a card: a provider-hosted page. TOUMA receives a URL, never card data. */
  async cardSetup(t: TenantContext, userId: string, returnUrl: string) {
    const provider = this.requireProvider();
    if (await this.isFounder(t.businessId)) throw err(ConflictException, 'FOUNDER_FREE_ACCESS', 'This account has free lifetime access: no card is needed');
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'Start the trial first');
    const migrating = sub.provider !== 'none' && sub.provider !== provider.id;
    if (migrating && sub.providerSubscriptionId) {
      throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `A subscription is still active at ${sub.provider}: cancel it there first, then capture a new card`);
    }
    return this.guarded(async () => {
      let customerRef = migrating ? null : sub.providerCustomerId;
      if (!customerRef) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
        customerRef = (await provider.createCustomer({ businessId: t.businessId, email: user.email })).customerRef;
        // A new customer at the new provider: the old customer and card reference are dropped (card tokens cannot be moved between providers by TOUMA).
        await this.prisma.subscription.update({ where: { id: sub.id }, data: { providerCustomerId: customerRef, provider: provider.id, ...(migrating ? { paymentMethodRef: null, providerMigratedFrom: sub.provider } : {}) } });
      }
      const setup = await provider.createCardSetup({ customerRef, returnUrl });
      return { hostedUrl: setup.hostedUrl };
    });
  }

  /** Step 2: schedules the monthly subscription at the provider, first charge when the trial ends. Becomes ACTIVE only on the provider's verified webhook. */
  async subscribe(t: TenantContext) {
    const provider = this.requireProvider();
    if (await this.isFounder(t.businessId)) throw err(ConflictException, 'FOUNDER_FREE_ACCESS', 'This account has free lifetime access: no payment is needed');
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: true } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'Start the trial first');
    if (!sub.providerCustomerId || !sub.paymentMethodRef) throw err(ConflictException, 'CARD_REQUIRED', 'Save a card first');
    if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_REQUIRED', 'Capture a card with the current payment provider first');
    if (sub.providerSubscriptionId) throw err(ConflictException, 'ALREADY_SUBSCRIBED', 'A subscription already exists');
    const created = await this.guarded(() => provider.createSubscription({ customerRef: sub.providerCustomerId!, paymentMethodRef: sub.paymentMethodRef!, amount: sub.plan.priceAmount.toFixed(2), currency: sub.plan.currency, interval: 'MONTH', firstChargeAt: sub.trialEndsAt }));
    await this.prisma.subscription.update({ where: { id: sub.id }, data: { providerSubscriptionId: created.subscriptionRef } });
    return this.status(t);
  }

  /** Cancels at the end of the paid period; access stays until then. */
  async cancel(t: TenantContext) {
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'No subscription');
    if (sub.providerSubscriptionId) {
      const provider = this.requireProvider();
      if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `This subscription belongs to ${sub.provider}: cancel it with that provider`);
      await this.guarded(() => provider.cancelSubscription({ subscriptionRef: sub.providerSubscriptionId!, atPeriodEnd: true }));
    }
    await this.prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    return this.status(t);
  }

  /** Takes back a cancellation scheduled for the end of the period (only while it has not ended). */
  async resume(t: TenantContext) {
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub || !sub.cancelAtPeriodEnd || sub.status === 'CANCELED' || sub.status === 'UNPAID') throw err(ConflictException, 'NOTHING_TO_RESUME', 'There is no pending cancellation to undo');
    if (sub.providerSubscriptionId) {
      const provider = this.requireProvider();
      if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `This subscription belongs to ${sub.provider}: resume it with that provider`);
      await this.guarded(() => provider.resumeSubscription({ subscriptionRef: sub.providerSubscriptionId! }));
    }
    await this.prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
    return this.status(t);
  }

  /**
   * Trial reminders: one in-app notification to the owner(s) 24 hours before a trial ends and one when it has ended without a subscription.
   * Read-only on subscriptions (it changes no status; access follows the dates) and a no-op for founders. Safe to run repeatedly (dedupe keys).
   * Not scheduled anywhere yet: a worker cron calls it when billing goes live.
   */
  async sweepTrials(now = new Date()) {
    const soon = new Date(now.getTime() + 24 * 3_600_000);
    const subs = await this.prisma.subscription.findMany({ where: { status: 'TRIALING', providerSubscriptionId: null, trialEndsAt: { not: null, lte: soon } }, select: { id: true, businessId: true, trialEndsAt: true } });
    let sent = 0;
    for (const s of subs) {
      if (await this.isFounder(s.businessId)) continue;
      const ended = s.trialEndsAt!.getTime() <= now.getTime();
      sent += await this.notifications.notify({ businessId: s.businessId, permission: 'billing.manage', type: ended ? 'billing.trial_ended' : 'billing.trial_ending', title: ended ? 'Your free trial has ended' : 'Your free trial ends within 24 hours', data: { trialEndsAt: s.trialEndsAt }, dedupeKey: `billing:${ended ? 'ended' : 'ending'}:${s.id}` });
    }
    return { checked: subs.length, notified: sent };
  }

  /** Applies one VERIFIED, already de-duplicated provider event. Returns false when it matches no subscription (ignored). */
  async apply(e: NormalizedBillingEvent): Promise<boolean> {
    // Only subscriptions of the provider that sent the event: a reference from another provider can never match.
    const sub = await this.prisma.subscription.findFirst({ where: { provider: this.provider?.id ?? 'none', OR: [...(e.subscriptionRef ? [{ providerSubscriptionId: e.subscriptionRef }] : []), ...(e.customerRef ? [{ providerCustomerId: e.customerRef }] : [])] } });
    if (!sub) return false;
    switch (e.type) {
      case 'payment_method.attached':
        if (e.paymentMethodRef) await this.prisma.subscription.update({ where: { id: sub.id }, data: { paymentMethodRef: e.paymentMethodRef } });
        break;
      case 'subscription.activated':
        await this.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', currentPeriodStart: e.periodStart ?? e.occurredAt, currentPeriodEnd: e.periodEnd ?? null } });
        break;
      case 'payment.succeeded':
      case 'payment.failed': {
        const ok = e.type === 'payment.succeeded';
        if (e.paymentRef && e.amount && e.currency) {
          await this.prisma.payment.upsert({
            where: { providerPaymentId: e.paymentRef },
            create: { businessId: sub.businessId, subscriptionId: sub.id, provider: this.provider?.id ?? 'none', providerPaymentId: e.paymentRef, amount: e.amount, currency: e.currency, status: ok ? 'SUCCEEDED' : 'FAILED', paidAt: ok ? e.occurredAt : null },
            update: { status: ok ? 'SUCCEEDED' : 'FAILED', paidAt: ok ? e.occurredAt : null },
          });
        }
        if (ok) {
          await this.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', failedPaymentCount: 0, lastPaymentFailureAt: null, currentPeriodStart: e.periodStart ?? sub.currentPeriodStart, currentPeriodEnd: e.periodEnd ?? sub.currentPeriodEnd } });
        } else {
          // A failed renewal: access continues during the grace period, then ends after BILLING_MAX_FAILED_PAYMENTS consecutive failures.
          const count = sub.failedPaymentCount + 1;
          const unpaid = count >= this.env.BILLING_MAX_FAILED_PAYMENTS;
          await this.prisma.subscription.update({ where: { id: sub.id }, data: { status: unpaid ? 'UNPAID' : 'PAST_DUE', failedPaymentCount: count, lastPaymentFailureAt: e.occurredAt } });
          await this.notifications.notify({ businessId: sub.businessId, permission: 'billing.manage', type: unpaid ? 'billing.unpaid' : 'billing.payment_failed', title: unpaid ? 'Subscription suspended after repeated payment failures' : 'A subscription payment failed', data: { attempt: count }, dedupeKey: `billing:failed:${e.id}` });
        }
        break;
      }
      case 'subscription.canceled':
        await this.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', canceledAt: e.occurredAt, cancelAtPeriodEnd: true } });
        await this.notifications.notify({ businessId: sub.businessId, permission: 'billing.manage', type: 'billing.canceled', title: 'Your subscription has been canceled', dedupeKey: `billing:canceled:${e.id}` });
        break;
    }
    return true;
  }
}
