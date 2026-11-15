import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { evaluateProductionGate, type ProviderApprovalStatusName } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER } from './billing-provider';
import type { PaymentProvider } from './payment-provider';
import { IyzicoPaymentProvider } from './providers/iyzico.provider';
import { LemonSqueezyProvider } from './providers/lemonsqueezy.provider';
import { PaddleSandboxProvider } from './providers/paddle-sandbox.provider';
import { PayoneerPaymentProvider } from './providers/payoneer.provider';
import { MockPaymentProvider } from './providers/simulated.provider';

const DAY = 86_400_000;
/** Audit actions an administrator should look at. */
export const INCIDENT_ACTIONS = ['amount_mismatch', 'duplicate_payment_for_period', 'late_failure_ignored', 'stale_event_ignored', 'provider_unavailable', 'payment_failed'] as const;
/** The only providers whose approval can be recorded: real third parties. The mock has nothing to approve. */
const APPROVABLE = ['payoneer', 'iyzico', 'paddle-sandbox', 'lemonsqueezy'] as const;

/** Platform-wide billing figures for administrators. Money from the mock provider is SIMULATED and is reported separately from real revenue. */
@Injectable()
export class BillingAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  private adapters(): PaymentProvider[] {
    const paddle = this.provider?.id === 'paddle-sandbox' ? this.provider : new PaddleSandboxProvider({ priceMap: {} });
    return [new MockPaymentProvider(undefined), new PayoneerPaymentProvider(), new IyzicoPaymentProvider(), paddle, new LemonSqueezyProvider()];
  }

  /**
   * Records which providers exist, what each is verified to do, what each has said about TOUMA's real activities, and why real payments are blocked for it.
   * Nothing here enables anything: a provider is "selected" only if it is the configured one, and the production gate stays closed (see evaluateProductionGate).
   */
  async providers() {
    const labels: Record<string, string> = { simulated: 'Mock (simulation)', payoneer: 'Payoneer', iyzico: 'iyzico', 'paddle-sandbox': 'Paddle (sandbox)', lemonsqueezy: 'Lemon Squeezy' };
    for (const a of this.adapters()) {
      const c = JSON.parse(JSON.stringify(a.capabilities()));
      await this.prisma.paymentProviderAccount.upsert({ where: { provider: a.id }, create: { provider: a.id, label: labels[a.id] ?? a.id, capabilities: c, enabled: this.provider?.id === a.id }, update: { capabilities: c, enabled: this.provider?.id === a.id } });
    }
    const rows = await this.prisma.paymentProviderAccount.findMany({ where: { provider: { in: this.adapters().map((a) => a.id) } }, orderBy: { provider: 'asc' } });
    return rows.map((r) => {
      const caps = r.capabilities as { live?: boolean; verifiedAgainstOfficialDocs?: boolean };
      return {
        provider: r.provider, label: r.label, environment: r.environment, enabled: r.enabled, verifiedAt: r.verifiedAt, capabilities: r.capabilities,
        approval: { status: r.approvalStatus, reference: r.approvalReference, note: r.approvalNote, approvedAt: r.approvedAt, updatedAt: r.approvalUpdatedAt },
        productionGate: evaluateProductionGate({ environment: this.env.PAYMENT_ENVIRONMENT, approvalStatus: r.approvalStatus, approvalReference: r.approvalReference, adapterLive: Boolean(caps.live), adapterVerified: Boolean(caps.verifiedAgainstOfficialDocs) }),
      };
    });
  }

  /**
   * Records what the PROVIDER itself decided about TOUMA's real activities (automated social-media marketing with AI agents). APPROVED needs the reference of
   * the provider's written decision. Recording it never enables real payments: the production gate has other conditions and this build blocks live payments.
   */
  async setApproval(provider: string, dto: { status: ProviderApprovalStatusName; reference?: string; note?: string }, actorId: string) {
    if (!(APPROVABLE as readonly string[]).includes(provider)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unknown provider' });
    const reference = dto.reference?.trim() || null;
    if (dto.status === 'APPROVED' && (!reference || reference.length < 3)) throw new BadRequestException({ code: 'APPROVAL_REFERENCE_REQUIRED', message: 'Recording an approval needs the reference of the provider\'s written decision' });
    await this.providers(); // makes sure the row exists
    const now = new Date();
    await this.prisma.paymentProviderAccount.update({
      where: { provider },
      data: { approvalStatus: dto.status, approvalReference: reference, approvalNote: dto.note?.trim().slice(0, 500) || null, approvedAt: dto.status === 'APPROVED' ? now : null, approvalUpdatedById: actorId, approvalUpdatedAt: now },
    });
    await this.audit.record({ action: 'billing.provider_approval_changed', actorId, entityType: 'PaymentProviderAccount', entityId: provider, metadata: { provider, status: dto.status, hasReference: Boolean(reference) } });
    return (await this.providers()).find((p) => p.provider === provider)!;
  }

  /** Subscriptions to review, newest activity first. */
  async subscriptions(q: { status?: string; page: number; pageSize: number }) {
    const where = q.status ? { status: q.status as never } : {};
    const [total, items] = await Promise.all([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, businessId: true, status: true, billingMode: true, billingInterval: true, amountMinor: true, currency: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, failedPaymentCount: true, provider: true, plan: { select: { code: true } }, business: { select: { name: true } } } }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: items.map((s) => ({ id: s.id, businessId: s.businessId, business: s.business.name, plan: s.plan.code, status: s.status, mode: s.billingMode, interval: s.billingInterval, amountMinor: s.amountMinor, currency: s.currency, periodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, failedPayments: s.failedPaymentCount, provider: s.provider })) };
  }

  /** Things that need a human: provider outages, amount mismatches, duplicate or stale events, failed notifications. */
  async incidents(now = new Date()) {
    const since = new Date(now.getTime() - 30 * DAY);
    const [logs, failedWebhooks, ignoredWebhooks] = await Promise.all([
      this.prisma.subscriptionAuditLog.findMany({ where: { action: { in: [...INCIDENT_ACTIONS] }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, businessId: true, action: true, reason: true, createdAt: true } }),
      this.prisma.webhookEvent.count({ where: { status: 'FAILED', receivedAt: { gte: since }, provider: { in: ['SIMULATED_BILLING', 'PADDLE', 'PAYONEER', 'IYZICO', 'LEMONSQUEEZY'] } } }),
      this.prisma.webhookEvent.count({ where: { status: 'IGNORED', receivedAt: { gte: since }, provider: { in: ['SIMULATED_BILLING', 'PADDLE', 'PAYONEER', 'IYZICO', 'LEMONSQUEEZY'] } } }),
    ]);
    const counts: Record<string, number> = {};
    for (const l of logs) counts[l.action] = (counts[l.action] ?? 0) + 1;
    return { windowDays: 30, counts, failedNotifications: failedWebhooks, ignoredNotifications: ignoredWebhooks, recent: logs };
  }

  async overview(now = new Date()) {
    const horizon = new Date(now.getTime() + 14 * DAY);
    const since = new Date(now.getTime() - 30 * DAY);
    const [byStatus, trialRows, failedCount, recentFailed, revenue, upcoming, events, providers, incidents] = await Promise.all([
      this.prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ trialing: bigint; paid: bigint }>>`SELECT COUNT(*) FILTER (WHERE "trialEndsAt" IS NOT NULL AND "currentPeriodEnd" <= "trialEndsAt") AS trialing, COUNT(*) FILTER (WHERE "trialEndsAt" IS NULL OR "currentPeriodEnd" > "trialEndsAt") AS paid FROM "Subscription" WHERE status = 'ACTIVE'`,
      this.prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      this.prisma.payment.findMany({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, businessId: true, amountMinor: true, currency: true, failureCode: true, simulated: true, createdAt: true } }),
      this.prisma.invoice.groupBy({ by: ['currency', 'simulated'], where: { status: 'PAID' }, _sum: { amountMinor: true }, _count: { _all: true } }),
      this.prisma.subscription.findMany({ where: { status: 'ACTIVE', cancelAtPeriodEnd: false, currentPeriodEnd: { gt: now, lte: horizon } }, orderBy: { currentPeriodEnd: 'asc' }, take: 50, select: { id: true, businessId: true, billingMode: true, billingInterval: true, amountMinor: true, currency: true, currentPeriodEnd: true, trialEndsAt: true, business: { select: { name: true } } } }),
      this.prisma.subscriptionAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, businessId: true, action: true, fromStatus: true, toStatus: true, reason: true, createdAt: true } }),
      this.providers(),
      this.incidents(now),
    ]);
    const count = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
    const t = trialRows[0];
    const sum = (simulated: boolean) => revenue.filter((r) => r.simulated === simulated).map((r) => ({ currency: r.currency, amountMinor: r._sum.amountMinor ?? 0, invoices: r._count._all }));
    return {
      generatedAt: now,
      environment: this.env.PAYMENT_ENVIRONMENT,
      selectedProvider: this.provider?.id ?? null,
      subscriptions: { activePaid: Number(t?.paid ?? 0), trialing: Number(t?.trialing ?? 0), pending: count('PENDING'), pastDue: count('PAST_DUE'), gracePeriod: count('GRACE_PERIOD'), canceled: count('CANCELED'), expired: count('EXPIRED') },
      failedPayments: { last30Days: failedCount, recent: recentFailed },
      /** `simulated` is NOT money collected: it comes from the mock provider. `real` stays empty until a verified provider is live. */
      revenue: { simulated: sum(true), real: sum(false), note: 'Simulated revenue is not money collected.' },
      upcomingRenewals: upcoming.map((u) => ({ businessId: u.businessId, business: u.business.name, mode: u.billingMode, interval: u.billingInterval, amountMinor: u.amountMinor, currency: u.currency, at: u.currentPeriodEnd, trial: !!u.trialEndsAt && !!u.currentPeriodEnd && u.currentPeriodEnd <= u.trialEndsAt })),
      events,
      incidents,
      providers,
    };
  }
}
