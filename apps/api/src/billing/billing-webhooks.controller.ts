import { Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/current-user.decorator';
import { BillingWebhookProcessor } from './billing-webhook.processor';
import { BillingEnabledGuard } from './billing.guard';

/** Provider webhooks: unauthenticated by nature, so every request must prove its sender inside the processor (cryptographic signature on the raw body). */
@ApiExcludeController()
@UseGuards(BillingEnabledGuard)
@Controller('billing/webhooks')
export class BillingWebhooksController {
  constructor(private readonly processor: BillingWebhookProcessor) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') name: string, @Req() req: RawBodyRequest<Request>) {
    return this.processor.receive(name, req.rawBody, req.headers);
  }
}
