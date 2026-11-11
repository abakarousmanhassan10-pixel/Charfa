import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/current-user.decorator';
import { PublicMessageDto, PublicPollDto } from './sales.dto';
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
  poll(@Param('slug') s: string, @Query() q: PublicPollDto) {
    return this.chat.poll(slug(s), q.token);
  }

  @Delete(':slug/data')
  @Throttle(publicThrottle())
  @ApiOperation({ summary: 'The customer erases their data' })
  erase(@Param('slug') s: string, @Query() q: PublicPollDto) {
    return this.chat.erase(slug(s), q.token);
  }
}
