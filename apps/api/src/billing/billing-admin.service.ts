import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER } from './billing-provider';
import type { PaymentProvider } from './payment-provider';
import { IyzicoPaymentProvider } from './providers/iyzico.provider';
import { PayoneerPaymentProvider } from './providers/payoneer.provider';
import { MockPaymentProvider } from './providers/simulated.provider';

const DAY = 86_400_000;

/** Platform-wide billing figures for administrators. Money from the mock provider is SIMULATED and is reported separately from real revenue. */
@Injectable()
export class BillingAdminService {
  constructor(private readonly prisma: PrismaService, @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null) {}

  /** Records which providers exist and what each is verified to do. Nothing is enabled by this: a provider is "enabled" only if it is the configured one, and none is verified. */
  async syncProviderAccounts() {
    const adapters: PaymentProvider[] = [new MockPaymentProvider(undefined), new PayoneerPaymentProvider(), new IyzicoPaymentProvider()];
    const labels: Record<string, string> = { simulated: 'Mock (simulation)', payoneer: 'Payoneer', iyzico: 'iyzico' };
    for (const a of adapters) {
      const c = a.capabilities();
      await this.prisma.paymentProviderAccount.upsert({
        where: { provider: a.id },
        create: { provider: a.id, label: labels[a.id] ?? a.id, capabilities: JSON.parse(JSON.stringify(c)), enabled: this.provider?.id === a.id },
        update: { capabilities: JSON.parse(JSON.stringify(c)), enabled: this.provider?.id === a.id },
      });
    }
    return this.prisma.paymentProviderAccount.findMany({ orderBy: { provider: 'asc' }, select: { provider: true, label: true, environment: true, enabled: true, capabilities: true, verifiedAt: true } });
  }

  async overview(now = new Date()) {
    const horizon = new Date(now.getTime() + 14 * DAY);
    const since = new Date(now.getTime() - 30 * DAY);
    const [byStatus, trialRows, failedCount, recentFailed, revenue, upcoming, events, providers] = await Promise.all([
      this.prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ trialing: bigint; paid: bigint }>>`SELECT COUNT(*) FILTER (WHERE "trialEndsAt" IS NOT NULL AND "currentPeriodEnd" <= "trialEndsAt") AS trialing, COUNT(*) FILTER (WHERE "trialEndsAt" IS NULL OR "currentPeriodEnd" > "trialEndsAt") AS paid FROM "Subscription" WHERE status = 'ACTIVE'`,
      this.prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      this.prisma.payment.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, businessId: true, amountMinor: true, currency: true, failureCode: true, simulated: true, createdAt: true } }),
      this.prisma.invoice.groupBy({ by: ['currency', 'simulated'], where: { status: 'PAID' }, _sum: { amountMinor: true }, _count: { _all: true } }),
      this.prisma.subscription.findMany({ where: { status: 'ACTIVE', cancelAtPeriodEnd: false, currentPeriodEnd: { gt: now, lte: horizon } }, orderBy: { currentPeriodEnd: 'asc' }, take: 50, select: { id: true, businessId: true, billingMode: true, billingInterval: true, amountMinor: true, currency: true, currentPeriodEnd: true, trialEndsAt: true, business: { select: { name: true } } } }),
      this.prisma.subscriptionAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, businessId: true, action: true, fromStatus: true, toStatus: true, reason: true, createdAt: true } }),
      this.syncProviderAccounts(),
    ]);
    const count = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
    const t = trialRows[0];
    const sum = (simulated: boolean) => revenue.filter((r) => r.simulated === simulated).map((r) => ({ currency: r.currency, amountMinor: r._sum.amountMinor ?? 0, invoices: r._count._all }));
    return {
      generatedAt: now,
      subscriptions: { activePaid: Number(t?.paid ?? 0), trialing: Number(t?.trialing ?? 0), pending: count('PENDING'), pastDue: count('PAST_DUE'), gracePeriod: count('GRACE_PERIOD'), canceled: count('CANCELED'), expired: count('EXPIRED') },
      failedPayments: { last30Days: failedCount, recent: recentFailed },
      /** `simulated` is NOT money collected: it comes from the mock provider. `real` stays empty until a verified provider is live. */
      revenue: { simulated: sum(true), real: sum(false), note: 'Simulated revenue is not money collected.' },
      upcomingRenewals: upcoming.map((u) => ({ businessId: u.businessId, business: u.business.name, mode: u.billingMode, interval: u.billingInterval, amountMinor: u.amountMinor, currency: u.currency, at: u.currentPeriodEnd, trial: !!u.trialEndsAt && !!u.currentPeriodEnd && u.currentPeriodEnd <= u.trialEndsAt })),
      events,
      providers,
    };
  }
}
