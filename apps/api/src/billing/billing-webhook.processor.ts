import { Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { PrismaService } from '../prisma/prisma.service';
import { BillingEngine } from './billing-engine.service';
import { PAYMENT_PROVIDER } from './billing-provider';
import { IgnoredEventError, ProviderUnavailableError, WebhookSignatureError, type PaymentProvider } from './payment-provider';

const KIND = { simulated: 'SIMULATED_BILLING', payoneer: 'PAYONEER', iyzico: 'IYZICO', 'paddle-sandbox': 'PADDLE', lemonsqueezy: 'LEMONSQUEEZY' } as const;

/**
 * The single entry point for provider notifications (the HTTP webhook route and the local simulator both use it). A notification is processed only
 * after the provider adapter has verified the sender (signature on the RAW body); a failed verification stores nothing. Valid events are stored once
 * (unique on provider + event id), so a redelivery changes nothing, then applied by the billing engine under the subscription's row lock.
 */
@Injectable()
export class BillingWebhookProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: BillingEngine,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  async receive(name: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const kind = KIND[name as keyof typeof KIND];
    if (!kind || !this.provider || this.provider.id !== name) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    if (!rawBody) throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' });
    let event;
    try {
      event = this.provider.verifyWebhook({ rawBody, headers });
    } catch (e) {
      if (e instanceof WebhookSignatureError) throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' });
      if (e instanceof ProviderUnavailableError) throw new ServiceUnavailableException({ code: e.code, message: e.message });
      if (e instanceof IgnoredEventError) {
        // Authentic but not something TOUMA acts on: acknowledge (so the provider stops retrying) and keep a trace.
        try { await this.prisma.webhookEvent.create({ data: { provider: kind, externalEventId: e.eventId, type: e.eventType, signatureValid: true, status: 'IGNORED', processedAt: new Date(), payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue } }); } catch { /* already stored */ }
        return { received: true, duplicate: false, ignored: true };
      }
      throw e;
    }
    let row;
    try {
      row = await this.prisma.webhookEvent.create({ data: { provider: kind, externalEventId: event.id, type: event.type, signatureValid: true, payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true };
      throw e;
    }
    try {
      const applied = await this.engine.applyEvent(event);
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { status: applied ? 'PROCESSED' : 'IGNORED', processedAt: new Date(), attempts: { increment: 1 } } });
    } catch {
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'apply_failed', attempts: { increment: 1 } } });
      throw new ServiceUnavailableException({ code: 'WEBHOOK_PROCESSING_FAILED', message: 'Processing failed, retry later' });
    }
    return { received: true, duplicate: false };
  }
}
