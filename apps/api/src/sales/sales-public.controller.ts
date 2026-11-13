import { Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/current-user.decorator';
import { PublicMessageDto, PublicPollDto, PublicConsentDto } from './sales.dto';

/** The chat secret travels in a header (GET and DELETE have no body), never in the URL: URLs end up in history, proxies and logs. */
const CHAT_TOKEN_HEADER = 'x-chat-token';
function chatToken(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(value)) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
  return value;
}
import { SalesPublicService } from './sales-public.service';

const slug = (s: string) => (/^[a-z0-9][a-z0-9-]{0,80}$/.test(s) ? s : '__invalid__');
const publicThrottle = () => ({ default: { limit: Number(process.env.SALES_PUBLIC_RATE_LIMIT_PER_MINUTE ?? 20), ttl: 60_000 } });

/** Customer chat. Public by nature (visitors have no account): protected by per-IP throttling, a per-conversation secret token, message and conversation limits, and the agent being OFF by default. */
@ApiTags('public-chat')
@Public()
@Controller('public/chat')
export class SalesPublicController {
  constructor(private readonly chat: SalesPublicService) {}

  @Get(':slug')
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'Public chat information of a shop (404 when the shop does not exist or its agent is off)' })
  info(@Param('slug') s: string) {
    return this.chat.info(slug(s));
  }

  @Post(':slug/messages')
  @HttpCode(200)
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'Send a customer message. Without a token a new conversation starts and its secret token is returned once' })
  send(@Param('slug') s: string, @Body() dto: PublicMessageDto, @Req() req: Request) {
    return this.chat.send(slug(s), dto, req.ip);
  }

  @Get(':slug/messages')
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'Messages of a conversation. The secret goes in the X-Chat-Token header (a ?token= query is ignored)' })
  poll(@Param('slug') s: string, @Headers(CHAT_TOKEN_HEADER) token: string | undefined) {
    return this.chat.poll(slug(s), chatToken(token));
  }

  @Post(':slug/handoff')
  @HttpCode(200)
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'The customer asks to talk to a person (Phase N5)' })
  handoff(@Param('slug') s: string, @Body() dto: PublicPollDto) {
    return this.chat.requestHandoff(slug(s), dto.token);
  }

  @Post(':slug/follow-up-consent')
  @HttpCode(200)
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'The customer agrees to, or opts out of, follow-up messages (Phase N5)' })
  consent(@Param('slug') s: string, @Body() dto: PublicConsentDto) {
    return this.chat.followUpConsent(slug(s), dto.token, dto.granted);
  }

  @Delete(':slug/data')
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'The customer erases their data' })
  erase(@Param('slug') s: string, @Headers(CHAT_TOKEN_HEADER) token: string | undefined) {
    return this.chat.erase(slug(s), chatToken(token));
  }
}
