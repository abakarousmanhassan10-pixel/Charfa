import { Controller, HttpCode, NotFoundException, Param, Post, Req, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Prisma } from '@touma/database';
import { Public } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { BillingEnabledGuard } from './billing.guard';
import { BillingService } from './billing.service';
import { Inject } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './billing-provider';
import { ProviderUnavailableError, WebhookSignatureError, type PaymentProvider } from './payment-provider';

const KIND = { simulated: 'SIMULATED_BILLING', payoneer: 'PAYONEER' } as const;

/**
 * Provider webhooks. Unauthenticated by nature, so the provider adapter must prove the sender (signature on the RAW body) before
 * anything is stored or applied. A bad signature stores nothing. Valid events are stored once (idempotent on provider + event id),
 * so a redelivery changes nothing. The route only answers for the provider that is configured on this server.
 */
@ApiExcludeController()
@UseGuards(BillingEnabledGuard)
@Controller('billing/webhooks')
export class BillingWebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') name: string, @Req() req: RawBodyRequest<Request>) {
    const kind = KIND[name as keyof typeof KIND];
    if (!kind || !this.provider || this.provider.id !== name) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' });
    const raw = req.rawBody;
    if (!raw) throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' });
    let event;
    try {
      event = this.provider.verifyWebhook({ rawBody: raw, headers: req.headers });
    } catch (e) {
      if (e instanceof WebhookSignatureError) throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' });
      if (e instanceof ProviderUnavailableError) throw new ServiceUnavailableException({ code: e.code, message: e.message });
      throw e;
    }
    let row;
    try {
      row = await this.prisma.webhookEvent.create({ data: { provider: kind, externalEventId: event.id, type: event.type, signatureValid: true, payload: JSON.parse(raw.toString('utf8')) as Prisma.InputJsonValue } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true };
      throw e;
    }
    try {
      const applied = await this.billing.apply(event);
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { status: applied ? 'PROCESSED' : 'IGNORED', processedAt: new Date(), attempts: { increment: 1 } } });
    } catch {
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'apply_failed', attempts: { increment: 1 } } });
      throw new ServiceUnavailableException({ code: 'WEBHOOK_PROCESSING_FAILED', message: 'Processing failed, retry later' });
    }
    return { received: true, duplicate: false };
  }
}
