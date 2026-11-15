import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { isTrialPeriod, resolveEntitlement, trialEndsAt, type BillingIntervalName, type BillingMode } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { PAYMENT_PROVIDER } from './billing-provider';
import { BillingEngine } from './billing-engine.service';
import { EntitlementsService } from './entitlements.service';
import { FounderService } from './founder.service';
import { ProviderUnavailableError, type PaymentProvider } from './payment-provider';
import { auditSubscription, lockSubscription } from './subscription-state';

type Ex = typeof ConflictException | typeof NotFoundException | typeof ServiceUnavailableException | typeof BadRequestException;
const err = (Cls: Ex, code: string, message: string) => new Cls({ code, message });
type PlanCode = 'STARTER' | 'PRO' | 'BUSINESS';
const priceOf = (p: { priceAmountMinor: number; yearlyPriceAmountMinor: number }, i: BillingIntervalName) => (i === 'YEARLY' ? p.yearlyPriceAmountMinor : p.priceAmountMinor);

/**
 * Customer-facing subscription operations (N24, extended in N26). Nothing here touches a bank or card: card capture and payment pages are hosted by the
 * provider, a subscription turns ACTIVE only from a VERIFIED provider payment confirmation (see BillingEngine), and the founder is never charged.
 * Reads never modify a subscription; every change is an explicit owner action and is audited.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: BillingEngine,
    private readonly founders: FounderService,
    private readonly plan: EntitlementsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  isFounder(businessId: string) { return this.founders.isFounder(businessId); }

  private requireProvider(): PaymentProvider {
    if (!this.provider) throw err(ServiceUnavailableException, 'BILLING_PROVIDER_NOT_CONFIGURED', 'No payment provider is configured on this server');
    return this.provider;
  }
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof ProviderUnavailableError) throw err(ServiceUnavailableException, e.code, e.message);
      throw err(ServiceUnavailableException, 'PROVIDER_UNAVAILABLE', 'The payment provider is unavailable. Nothing was charged; try again later.');
    }
  }
  private async noFounder(businessId: string, what: string) {
    if (await this.isFounder(businessId)) throw err(ConflictException, 'FOUNDER_FREE_ACCESS', `This account has free lifetime access: ${what}`);
  }

  /**
   * Server-side subscription authorization for paid actions. A no-op unless BILLING_ENFORCEMENT_ENABLED=true; then the business needs access (trial,
   * paid period, grace period, paid period of a canceled one) or must belong to the founder. Decided from the database, never from the browser.
   */
  async assertAccess(businessId: string): Promise<void> {
    if (!this.env.BILLING_ENFORCEMENT_ENABLED) return;
    const [sub, founder] = await Promise.all([this.prisma.subscription.findUnique({ where: { businessId } }), this.isFounder(businessId)]);
    const ent = resolveEntitlement({ now: new Date(), isFounder: founder, graceDays: this.env.BILLING_GRACE_DAYS, subscription: sub });
    if (!ent.hasAccess) throw new HttpException({ code: 'SUBSCRIPTION_REQUIRED', message: 'An active trial or subscription is required for this action', state: ent.state }, HttpStatus.PAYMENT_REQUIRED);
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  async status(t: TenantContext) {
    const now = new Date();
    const [sub, founder, plans] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: true, pendingPlan: true } }),
      this.isFounder(t.businessId),
      this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, description: true, currency: true, priceAmountMinor: true, yearlyPriceAmountMinor: true } }),
    ]);
    const ent = resolveEntitlement({ now, isFounder: founder, graceDays: this.env.BILLING_GRACE_DAYS, subscription: sub });
    const caps = this.provider?.capabilities() ?? null;
    let nextPayment: { at: Date | null; amountMinor: number; currency: string; mode: string; plan: string; interval: string } | null = null;
    if (sub && !founder && sub.status !== 'EXPIRED') {
      const q = this.engine.quote(sub, now);
      nextPayment = { at: sub.status === 'PENDING' ? null : sub.currentPeriodEnd, amountMinor: q.amountMinor, currency: q.currency, mode: sub.billingMode, plan: q.planCode, interval: q.interval };
    }
    const renewalOpen = !!sub && !founder && (sub.status === 'PENDING' || sub.status === 'EXPIRED' || !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() - now.getTime() <= this.env.BILLING_REMINDER_DAYS * 86_400_000);
    return {
      enabled: this.env.BILLING_ENABLED,
      /** True on the mock provider: nothing real is charged and revenue figures are not real money. */
      simulation: this.provider?.id === 'simulated',
      /** True on a provider's SANDBOX adapter (test credentials, test cards): no real payment either. */
      sandbox: Boolean(caps?.sandboxOnly),
      environment: this.env.PAYMENT_ENVIRONMENT,
      graceDays: this.env.BILLING_GRACE_DAYS,
      reminderDays: this.env.BILLING_REMINDER_DAYS,
      plans,
      provider: caps,
      entitlement: ent,
      subscription: sub ? {
        status: sub.status, plan: sub.plan.code, billingMode: sub.billingMode, billingInterval: sub.billingInterval, amountMinor: sub.amountMinor, currency: sub.currency,
        trial: isTrialPeriod(sub) && sub.status === 'ACTIVE', trialEndsAt: sub.trialEndsAt, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        autoRenewConsentAt: sub.autoRenewConsentAt, cardSaved: Boolean(sub.paymentMethodRef), subscribed: Boolean(sub.providerSubscriptionId), failedPayments: sub.failedPaymentCount,
        pendingChange: sub.pendingPlanId || sub.pendingBillingInterval ? { plan: sub.pendingPlan?.code ?? sub.plan.code, billingInterval: sub.pendingBillingInterval ?? sub.billingInterval } : null,
      } : null,
      nextPayment,
      renewalOpen,
      entitlements: await this.plan.summary(t.businessId),
      /** True when the saved customer/card belongs to another provider than the one now configured: a new card must be captured (see docs/BILLING.md). */
      providerMigration: { required: Boolean(sub && this.provider && sub.provider !== 'none' && sub.provider !== this.provider.id), from: sub?.provider ?? null },
    };
  }

  /** Payments and subscription events of one business, newest first (ids, amounts and states only; never card data or secrets). */
  async history(t: TenantContext) {
    const [payments, events] = await Promise.all([
      this.prisma.payment.findMany({ where: { businessId: t.businessId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, amountMinor: true, currency: true, status: true, kind: true, simulated: true, paidAt: true, createdAt: true } }),
      this.prisma.subscriptionAuditLog.findMany({ where: { businessId: t.businessId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, action: true, fromStatus: true, toStatus: true, reason: true, createdAt: true } }),
    ]);
    return { payments, events: events.map((e) => ({ id: e.id, action: e.action, from: e.fromStatus, to: e.toStatus, reason: e.reason, at: e.createdAt })) };
  }

  /** Invoices of this business only. Another business's invoice id answers 404. */
  async invoices(t: TenantContext) {
    return this.prisma.invoice.findMany({ where: { businessId: t.businessId }, orderBy: { issuedAt: 'desc' }, take: 100, select: { id: true, number: true, status: true, amountMinor: true, currency: true, planCode: true, description: true, periodStart: true, periodEnd: true, issuedAt: true, paidAt: true, simulated: true } });
  }
  async invoice(t: TenantContext, id: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, businessId: t.businessId }, select: { id: true, number: true, status: true, amountMinor: true, currency: true, planCode: true, description: true, periodStart: true, periodEnd: true, issuedAt: true, paidAt: true, simulated: true } });
    if (!inv) throw err(NotFoundException, 'NOT_FOUND', 'Invoice not found');
    return inv;
  }

  // ─── Creating a subscription ────────────────────────────────────────────

  /**
   * Creates the business's subscription. With `trial` (default) it starts the 72-hour free trial: ACTIVE for the trial period, nothing charged, no card.
   * Without it, the subscription is PENDING until a payment is confirmed by the provider. AUTO needs the customer's explicit consent to automatic renewal.
   */
  async createSubscription(t: TenantContext, userId: string, dto: { plan: PlanCode; billingMode?: BillingMode; billingInterval?: BillingIntervalName; autoRenewConsent?: boolean; trial?: boolean }) {
    await this.noFounder(t.businessId, 'no trial or payment is needed');
    const mode: BillingMode = dto.billingMode ?? 'MANUAL';
    const interval: BillingIntervalName = dto.billingInterval ?? 'MONTHLY';
    if (mode === 'AUTO' && dto.autoRenewConsent !== true) throw err(BadRequestException, 'CONSENT_REQUIRED', 'Automatic renewal needs your explicit consent');
    const plan = await this.prisma.plan.findFirst({ where: { code: dto.plan, isActive: true } });
    if (!plan) throw err(NotFoundException, 'PLAN_NOT_FOUND', 'Plan not found');
    const trial = dto.trial ?? true;
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const end = trialEndsAt(now);
        const sub = await tx.subscription.create({
          data: {
            businessId: t.businessId, userId, planId: plan.id, status: trial ? 'ACTIVE' : 'PENDING', provider: this.provider?.id ?? 'none', billingMode: mode, billingInterval: interval, currency: plan.currency, amountMinor: priceOf(plan, interval),
            autoRenewConsentAt: mode === 'AUTO' ? now : null, ...(trial ? { trialEndsAt: end, currentPeriodStart: now, currentPeriodEnd: end } : {}),
          },
        });
        await auditSubscription(tx, sub, trial ? 'trial_started' : 'created', { actorId: userId, reason: trial ? 'free trial started' : 'subscription created, waiting for the first payment', metadata: { plan: plan.code, billingMode: mode, billingInterval: interval } }, { to: sub.status });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw err(ConflictException, trial ? 'TRIAL_ALREADY_USED' : 'SUBSCRIPTION_EXISTS', 'This business already has a subscription or has used its trial');
      throw e;
    }
    await this.audit.record({ action: trial ? 'billing.trial_started' : 'billing.subscription_created', actorId: userId, businessId: t.businessId, entityType: 'Subscription', metadata: { plan: dto.plan, billingMode: mode, billingInterval: interval } });
    return this.status(t);
  }

  // ─── Mode, plan ──────────────────────────────────────────────────────────

  /** Switches AUTO <-> MANUAL. AUTO needs explicit consent; MANUAL cancels the recurring schedule at the provider and withdraws the consent. */
  async setMode(t: TenantContext, userId: string, dto: { billingMode: BillingMode; autoRenewConsent?: boolean }) {
    await this.noFounder(t.businessId, 'nothing to configure');
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'Choose a plan first');
    if (dto.billingMode === sub.billingMode) return this.status(t);
    if (dto.billingMode === 'AUTO') {
      if (dto.autoRenewConsent !== true) throw err(BadRequestException, 'CONSENT_REQUIRED', 'Automatic renewal needs your explicit consent');
      await this.prisma.$transaction(async (tx) => {
        await lockSubscription(tx, sub.id);
        await tx.subscription.update({ where: { id: sub.id }, data: { billingMode: 'AUTO', autoRenewConsentAt: new Date() } });
        await auditSubscription(tx, sub, 'mode_changed', { actorId: userId, reason: 'automatic renewal enabled with consent', metadata: { to: 'AUTO' } });
      });
    } else {
      // Stop the provider's recurring schedule first: a failure leaves everything unchanged.
      if (sub.providerSubscriptionId) {
        const provider = this.requireProvider();
        if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `This subscription belongs to ${sub.provider}: cancel it with that provider`);
        await this.guarded(() => provider.cancelSubscription({ subscriptionRef: sub.providerSubscriptionId!, atPeriodEnd: true }));
      }
      await this.prisma.$transaction(async (tx) => {
        await lockSubscription(tx, sub.id);
        await tx.subscription.update({ where: { id: sub.id }, data: { billingMode: 'MANUAL', autoRenewConsentAt: null, providerSubscriptionId: null } });
        await auditSubscription(tx, sub, 'mode_changed', { actorId: userId, reason: 'automatic renewal disabled', metadata: { to: 'MANUAL' } });
      });
    }
    await this.audit.record({ action: 'billing.mode_changed', actorId: userId, businessId: t.businessId, entityType: 'Subscription', entityId: sub.id, metadata: { to: dto.billingMode } });
    return this.status(t);
  }

  /** Requests another plan and/or interval. It takes effect at the next renewal (no proration, no refund); choosing the current plan withdraws a pending request. */
  async changePlan(t: TenantContext, userId: string, dto: { plan: PlanCode; billingInterval?: BillingIntervalName }) {
    await this.noFounder(t.businessId, 'nothing to change');
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: true } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'Choose a plan first');
    if (sub.status === 'EXPIRED' || sub.status === 'CANCELED') throw err(ConflictException, 'SUBSCRIPTION_NOT_CHANGEABLE', 'Renew first, then change the plan');
    const target = await this.prisma.plan.findFirst({ where: { code: dto.plan, isActive: true } });
    if (!target) throw err(NotFoundException, 'PLAN_NOT_FOUND', 'Plan not found');
    const interval = dto.billingInterval ?? sub.billingInterval;
    const same = target.id === sub.planId && interval === sub.billingInterval;
    await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: same ? { pendingPlanId: null, pendingBillingInterval: null } : { pendingPlanId: target.id, pendingBillingInterval: interval } });
      await auditSubscription(tx, sub, 'plan_change_requested', { actorId: userId, reason: same ? 'pending change withdrawn' : 'takes effect at the next renewal', metadata: { plan: target.code, billingInterval: interval } });
    });
    return this.status(t);
  }

  // ─── Card (automatic renewal) ───────────────────────────────────────────

  /** Step 1 of saving a card: a provider-hosted page. TOUMA receives a URL, never card data. */
  async cardSetup(t: TenantContext, userId: string, returnUrl: string) {
    const provider = this.requireProvider();
    await this.noFounder(t.businessId, 'no card is needed');
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'Choose a plan first');
    if (provider.capabilities().subscriptionModel === 'checkout') throw err(ConflictException, 'CAPABILITY_UNSUPPORTED', 'This payment provider saves the card during its hosted checkout: use Subscribe');
    const migrating = sub.provider !== 'none' && sub.provider !== provider.id;
    if (migrating && sub.providerSubscriptionId) throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `A subscription is still active at ${sub.provider}: cancel it there first, then capture a new card`);
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

  /** Step 2 (AUTO only): schedules the recurring charge at the provider. Needs consent and a saved card. Access still starts only from a confirmed payment. */
  async subscribe(t: TenantContext) {
    const provider = this.requireProvider();
    await this.noFounder(t.businessId, 'no payment is needed');
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: true, pendingPlan: true } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'Choose a plan first');
    if (sub.billingMode !== 'AUTO' || !sub.autoRenewConsentAt) throw err(ConflictException, 'CONSENT_REQUIRED', 'Choose automatic renewal and give your consent first');
    if (provider.capabilities().subscriptionModel === 'checkout') return this.subscribeByCheckout(t, sub, provider);
    if (!sub.providerCustomerId || !sub.paymentMethodRef) throw err(ConflictException, 'CARD_REQUIRED', 'Save a card first');
    if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_REQUIRED', 'Capture a card with the current payment provider first');
    if (sub.providerSubscriptionId) throw err(ConflictException, 'ALREADY_SUBSCRIBED', 'A subscription already exists');
    const q = this.engine.quote(sub, new Date());
    const created = await this.guarded(() => provider.createSubscription({ customerRef: sub.providerCustomerId!, paymentMethodRef: sub.paymentMethodRef!, amountMinor: q.amountMinor, currency: q.currency, interval: q.interval, firstChargeAt: q.periodStart }));
    await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: { providerSubscriptionId: created.subscriptionRef } });
      await auditSubscription(tx, sub, 'provider_subscription_scheduled', { actorId: t.userId, reason: 'recurring charge scheduled', metadata: { amountMinor: q.amountMinor, currency: q.currency, interval: q.interval, firstChargeAt: q.periodStart } });
    });
    return this.status(t);
  }

  /**
   * "checkout" providers (e.g. Paddle): the customer completes a hosted checkout of the recurring price. The subscription exists at the provider only after they do,
   * and our subscription becomes ACTIVE only when the provider's verified notifications confirm the first payment.
   */
  private async subscribeByCheckout(t: TenantContext, sub: { id: string; businessId: string; provider: string; providerSubscriptionId: string | null; providerCustomerId: string | null; currentPeriodEnd: Date | null; plan: { code: string }; pendingPlan: { code: string } | null; billingInterval: BillingIntervalName; pendingBillingInterval: BillingIntervalName | null }, provider: PaymentProvider) {
    if (sub.providerSubscriptionId) throw err(ConflictException, 'ALREADY_SUBSCRIBED', 'A subscription already exists');
    if (sub.provider !== 'none' && sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_REQUIRED', 'The payment provider changed: start the subscription again with the current provider');
    const full = await this.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true, pendingPlan: true } });
    const q = this.engine.quote(full, new Date());
    let customerRef = sub.providerCustomerId;
    if (!customerRef) {
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true } });
      customerRef = await this.guarded(async () => (await provider.createCustomer({ businessId: t.businessId, email: user.email })).customerRef);
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { providerCustomerId: customerRef, provider: provider.id } });
    }
    const key = await this.engine.nextRenewalKey(full);
    const checkout = await this.guarded(() => provider.createRecurringCheckout({ customerRef: customerRef!, planCode: q.planCode, interval: q.interval, amountMinor: q.amountMinor, currency: q.currency, reference: key, returnUrl: `${this.env.WEB_URL}/dashboard/billing` }));
    await this.prisma.$transaction(async (tx) => {
      await auditSubscription(tx, sub, 'recurring_checkout_created', { actorId: t.userId, reason: 'hosted checkout opened; nothing is active until the provider confirms', metadata: { amountMinor: q.amountMinor, currency: q.currency, interval: q.interval } });
    });
    return { ...(await this.status(t)), checkoutUrl: checkout.hostedUrl };
  }

  // ─── Renewal (manual) ────────────────────────────────────────────────────

  renew(t: TenantContext, userId: string, returnUrl: string) {
    return this.engine.createRenewalPayment(t, userId, returnUrl, 'RENEWAL_MANUAL');
  }

  // ─── Cancellation ────────────────────────────────────────────────────────

  /** Cancels at the end of the paid period; access stays until then. */
  async cancel(t: TenantContext) {
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub) throw err(NotFoundException, 'NO_SUBSCRIPTION', 'No subscription');
    if (sub.providerSubscriptionId) {
      const provider = this.requireProvider();
      if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `This subscription belongs to ${sub.provider}: cancel it with that provider`);
      await this.guarded(() => provider.cancelSubscription({ subscriptionRef: sub.providerSubscriptionId!, atPeriodEnd: true }));
    }
    await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
      await auditSubscription(tx, sub, 'cancel_requested', { actorId: t.userId, reason: 'cancel at the end of the paid period' });
    });
    await this.audit.record({ action: 'billing.cancel_requested', actorId: t.userId, businessId: t.businessId, entityType: 'Subscription', entityId: sub.id });
    return this.status(t);
  }

  /** Takes back a cancellation scheduled for the end of the period (only while it has not ended). */
  async resume(t: TenantContext) {
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub || !sub.cancelAtPeriodEnd || !['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'].includes(sub.status)) throw err(ConflictException, 'NOTHING_TO_RESUME', 'There is no pending cancellation to undo');
    if (sub.providerSubscriptionId) {
      const provider = this.requireProvider();
      if (sub.provider !== provider.id) throw err(ConflictException, 'PROVIDER_MIGRATION_BLOCKED', `This subscription belongs to ${sub.provider}: resume it with that provider`);
      await this.guarded(() => provider.resumeSubscription({ subscriptionRef: sub.providerSubscriptionId! }));
    }
    await this.prisma.$transaction(async (tx) => {
      await lockSubscription(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
      await auditSubscription(tx, sub, 'cancel_withdrawn', { actorId: t.userId, reason: 'cancellation withdrawn' });
    });
    await this.audit.record({ action: 'billing.resume_requested', actorId: t.userId, businessId: t.businessId, entityType: 'Subscription', entityId: sub.id });
    return this.status(t);
  }

  /** Reminders, grace and expiry (see BillingEngine.processDue). */
  processDue(now = new Date()) { return this.engine.processDue(now); }
  /** @deprecated kept for existing callers: the trial reminders are part of processDue. */
  sweepTrials(now = new Date()) { return this.engine.processDue(now); }
}
