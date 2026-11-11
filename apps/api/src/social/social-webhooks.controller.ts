import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@touma/database';
import { Public } from '../common/decorators/current-user.decorator';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Platform webhooks. They are unauthenticated routes by nature, so every request proves it comes from the platform:
 *  - Meta: GET verification with the shared verify token; POST signed with HMAC-SHA256 of the raw body using the app secret (X-Hub-Signature-256);
 *  - TikTok: HMAC-SHA256 of "<timestamp>.<raw body>" with the client secret (TikTok-Signature: t=...,s=...), rejected when older than 5 minutes.
 * Requests with a missing or wrong signature are rejected and nothing is stored. Valid events are stored once (idempotent on their id).
 */
@ApiExcludeController()
@Controller('social/webhooks')
export class SocialWebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  @Public()
  @Get('meta')
  verifyMeta(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    if (mode !== 'subscribe' || !this.env.META_WEBHOOK_VERIFY_TOKEN || !token || !eq(token, this.env.META_WEBHOOK_VERIFY_TOKEN)) throw new ForbiddenException({ code: 'WEBHOOK_VERIFICATION_FAILED', message: 'Verification failed' });
    res.type('text/plain').send(String(challenge ?? ''));
  }

  @Public()
  @Post('meta')
  @HttpCode(200)
  async meta(@Req() req: RawBodyRequest<Request>, @Body() body: Record<string, unknown>) {
    const secret = this.env.META_APP_SECRET;
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const raw = req.rawBody;
    if (!secret || !raw || !sig.startsWith('sha256=') || !eq(sig.slice(7), createHmac('sha256', secret).update(raw).digest('hex'))) throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' });
    // No stable event id is sent: the hash of the signed body identifies a delivery, so redeliveries are stored once.
    const stored = await this.store('META', createHash('sha256').update(raw).digest('hex'), `meta.${String(body.object ?? 'event')}`, body);
    return { received: true, duplicate: !stored };
  }

  @Public()
  @Post('tiktok')
  @HttpCode(200)
  async tiktok(@Req() req: RawBodyRequest<Request>, @Body() body: Record<string, unknown>) {
    const secret = this.env.TIKTOK_CLIENT_SECRET;
    const header = String(req.headers['tiktok-signature'] ?? '');
    const raw = req.rawBody;
    const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
    const s = /(?:^|,)s=([0-9a-f]+)/.exec(header)?.[1];
    if (!secret || !raw || !t || !s || Math.abs(Date.now() / 1000 - Number(t)) > 300 || !eq(s, createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex'))) {
      throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' });
    }
    let content: { publish_id?: string } = {};
    try {
      content = typeof body.content === 'string' ? JSON.parse(body.content) : ((body.content as object) ?? {});
    } catch {
      content = {};
    }
    const type = String(body.event ?? 'event');
    const id = `${type}:${content.publish_id ?? ''}:${body.create_time ?? ''}`;
    const stored = await this.store('TIKTOK', id, `tiktok.${type}`, body);
    if (stored && content.publish_id && /^post\.publish\./.test(type)) {
      // The platform says the post changed: check it now instead of waiting for the next poll.
      await this.prisma.publication.updateMany({ where: { providerRef: content.publish_id, platform: 'TIKTOK', status: 'AWAITING_PROVIDER' }, data: { nextCheckAt: new Date(), lockedUntil: null } });
      await this.prisma.webhookEvent.update({ where: { id: stored }, data: { status: 'PROCESSED', processedAt: new Date() } });
    } else if (stored) {
      await this.prisma.webhookEvent.update({ where: { id: stored }, data: { status: 'IGNORED', processedAt: new Date() } });
    }
    return { received: true, duplicate: !stored };
  }

  /** Returns the new event id, or null when this delivery was already stored. */
  private async store(provider: 'META' | 'TIKTOK', externalEventId: string, type: string, payload: Record<string, unknown>) {
    try {
      const row = await this.prisma.webhookEvent.create({ data: { provider, externalEventId, type, signatureValid: true, status: provider === 'META' ? 'IGNORED' : 'RECEIVED', payload: payload as Prisma.InputJsonValue, processedAt: provider === 'META' ? new Date() : null } });
      return row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }
}
