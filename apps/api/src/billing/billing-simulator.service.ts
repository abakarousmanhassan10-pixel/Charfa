import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { isTrialPeriod, minorToMajorString } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { BillingEngine } from './billing-engine.service';
import { BillingWebhookProcessor } from './billing-webhook.processor';
import { PAYMENT_PROVIDER } from './billing-provider';
import { MockPaymentProvider } from './providers/simulated.provider';
import type { PaymentProvider } from './payment-provider';

export type Outcome = 'success' | 'declined';

/**
 * Local payment simulator (mock provider only: it exists only when BILLING_PROVIDER=simulated, which the server refuses outside APP_ENV=test).
 * It plays the PROVIDER: it builds a correctly signed notification and sends it through the same webhook processor a real provider would use, so
 * the subscription changes only through a verified provider event, exactly like production. No money, no card, no network.
 */
@Injectable()
export class BillingSimulator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: BillingEngine,
    private readonly processor: BillingWebhookProcessor,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  private mock(): MockPaymentProvider {
    if (!(this.provider instanceof MockPaymentProvider)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    return this.provider;
  }

  private async deliver(event: Parameters<MockPaymentProvider['sign']>[0]) {
    const s = this.mock().sign(event);
    return this.processor.receive('simulated', s.rawBody, s.headers);
  }

  /** Simulates the provider notification for a payment session the customer opened (manual renewal or first payment). */
  async confirmPayment(t: TenantContext, paymentId: string, outcome: Outcome) {
    const p = await this.prisma.payment.findFirst({ where: { id: paymentId, businessId: t.businessId } });
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Payment not found' });
    if (p.status !== 'PENDING') throw new ConflictException({ code: 'PAYMENT_NOT_PENDING', message: 'This payment is already settled' });
    return this.deliver({
      id: `sim_evt_${randomUUID()}`, type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed', paymentRef: p.providerPaymentId, reference: p.idempotencyKey ?? undefined,
      subscriptionRef: undefined, customerRef: (await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, select: { providerCustomerId: true } }))?.providerCustomerId ?? undefined,
      amount: minorToMajorString(p.amountMinor, p.currency), currency: p.currency, failureCode: outcome === 'declined' ? 'card_declined' : undefined,
    });
  }

  /** Simulates the provider notification that the hosted card page saved a card (an opaque reference: no card data exists in this simulation). */
  async cardSaved(t: TenantContext) {
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, select: { providerCustomerId: true } });
    if (!sub?.providerCustomerId) throw new ConflictException({ code: 'NO_CUSTOMER', message: 'Open the card page first' });
    return this.deliver({ id: `sim_evt_${randomUUID()}`, type: 'payment_method.attached', customerRef: sub.providerCustomerId, paymentMethodRef: `sim_pm_${randomUUID()}` });
  }

  /**
   * Simulates the due date of an automatic renewal: moves the billing clock of THIS subscription so the period has just ended, runs the due-date
   * processing, then has the "provider" charge (or decline) the renewal and notify TOUMA.
   */
  async dueAutoRenewal(t: TenantContext, outcome: Outcome) {
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId }, include: { plan: true, pendingPlan: true } });
    if (!sub) throw new NotFoundException({ code: 'NO_SUBSCRIPTION', message: 'No subscription' });
    if (sub.billingMode !== 'AUTO' || !sub.providerSubscriptionId) throw new ConflictException({ code: 'NOT_AUTOMATIC', message: 'Automatic renewal is not set up' });
    if (!sub.currentPeriodEnd) throw new ConflictException({ code: 'NO_PERIOD', message: 'No billing period yet' });
    const now = new Date();
    const delta = sub.currentPeriodEnd.getTime() - now.getTime() + 1000; // the period ended one second ago
    if (delta > 0) {
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodStart: sub.currentPeriodStart ? new Date(sub.currentPeriodStart.getTime() - delta) : null, currentPeriodEnd: new Date(sub.currentPeriodEnd.getTime() - delta), ...(isTrialPeriod(sub) && sub.trialEndsAt ? { trialEndsAt: new Date(sub.trialEndsAt.getTime() - delta) } : {}) } });
    }
    // A trial that ended with a recurring schedule in place is charged by the provider, not expired by TOUMA: the first charge confirms it.
    const fresh = await this.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true, pendingPlan: true } });
    const q = this.engine.quote(fresh, new Date());
    const key = await this.engine.nextRenewalKey(fresh);
    return this.deliver({
      id: `sim_evt_${randomUUID()}`, type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed', subscriptionRef: sub.providerSubscriptionId, customerRef: sub.providerCustomerId ?? undefined, paymentRef: `sim_chg_${randomUUID()}`, reference: key,
      amount: minorToMajorString(q.amountMinor, q.currency), currency: q.currency, failureCode: outcome === 'declined' ? 'card_declined' : undefined,
    });
  }

  /** Runs the due-date processing for everyone (reminders, grace, expiry), as a scheduled job would. */
  processDue() {
    this.mock();
    return this.engine.processDue(new Date());
  }

  /** Test aid: moves the billing clock of this subscription back by whole days so reminders, grace and expiry can be exercised. */
  async rewind(t: TenantContext, days: number) {
    this.mock();
    const sub = await this.prisma.subscription.findUnique({ where: { businessId: t.businessId } });
    if (!sub?.currentPeriodEnd) throw new ConflictException({ code: 'NO_PERIOD', message: 'No billing period yet' });
    const ms = days * 86_400_000;
    await this.prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodStart: sub.currentPeriodStart ? new Date(sub.currentPeriodStart.getTime() - ms) : null, currentPeriodEnd: new Date(sub.currentPeriodEnd.getTime() - ms), ...(sub.trialEndsAt ? { trialEndsAt: new Date(sub.trialEndsAt.getTime() - ms) } : {}) } });
    return { rewoundDays: days };
  }
}
