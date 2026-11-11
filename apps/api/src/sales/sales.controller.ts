import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { AnalyticsQueryDto, ApproveDraftDto, ConversationsQueryDto, CustomersQueryDto, FaqDraftDto, FeedbackDto, NoteDto, PlaygroundDto, ReplyDto, UpdateAgentDto, UpdateCustomerDto } from './sales.dto';
import { SalesConversationsService } from './sales-conversations.service';
import { SalesCustomersService } from './sales-customers.service';
import { SalesInsightsService } from './sales-insights.service';
import { SalesMonitoringService } from './sales-monitoring.service';

const aiThrottle = () => ({ default: { limit: 30, ttl: 60_000 } });

@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(
    private readonly conversations: SalesConversationsService,
    private readonly customers: SalesCustomersService,
    private readonly insights: SalesInsightsService,
    private readonly monitoring: SalesMonitoringService,
  ) {}

  // ─── Agent configuration ────────────────────────────────────────────────

  @Get('agent')
  @ApiOperation({ summary: 'Agent configuration of this business (the agent is OFF until a person turns it on)' })
  @RequireTenantPermission('inbox.read')
  config(@Tenant() t: TenantContext) {
    return this.conversations.getConfig(t);
  }

  @Put('agent')
  @ApiOperation({ summary: 'Configure the agent: on/off, languages, tone, reply mode. AUTO needs the same permission as editing the business and is audited' })
  @RequireTenantPermission('business.update')
  updateConfig(@Tenant() t: TenantContext, @Body() dto: UpdateAgentDto) {
    return this.conversations.updateConfig(t, dto);
  }

  // ─── Conversations ──────────────────────────────────────────────────────

  @Get('conversations')
  @RequireTenantPermission('inbox.read')
  list(@Tenant() t: TenantContext, @Query() q: ConversationsQueryDto) {
    return this.conversations.list(t, q);
  }

  @Get('conversations/:id')
  @RequireTenantPermission('inbox.read')
  get(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.get(t, id);
  }

  @Post('conversations/:id/takeover')
  @HttpCode(200)
  @ApiOperation({ summary: 'Take over: the AI stops answering this conversation' })
  @RequireTenantPermission('inbox.reply')
  takeover(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.takeover(t, id);
  }

  @Post('conversations/:id/pause')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  pause(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.pause(t, id);
  }

  @Post('conversations/:id/resume')
  @HttpCode(200)
  @ApiOperation({ summary: 'Give the conversation back to the AI' })
  @RequireTenantPermission('inbox.reply')
  resume(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.resume(t, id);
  }

  @Post('conversations/:id/resolve')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  resolve(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.setStatus(t, id, 'RESOLVED');
  }

  @Post('conversations/:id/reopen')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  reopen(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.setStatus(t, id, 'OPEN');
  }

  @Post('conversations/:id/archive')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  archive(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.setStatus(t, id, 'ARCHIVED');
  }

  @Post('conversations/:id/reply')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a message to the customer as a person (takes the conversation over)' })
  @RequireTenantPermission('inbox.reply')
  reply(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.conversations.reply(t, id, dto.body);
  }

  @Post('conversations/:id/suggest')
  @HttpCode(200)
  @Throttle(aiThrottle())
  @ApiOperation({ summary: 'Ask the AI for a draft reply (never sent until a person approves it)' })
  @RequireTenantPermission('inbox.reply')
  suggest(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.suggest(t, id);
  }

  @Post('messages/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve an AI draft (optionally edited): only then does the customer see it' })
  @RequireTenantPermission('inbox.reply')
  approve(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: ApproveDraftDto) {
    return this.conversations.approve(t, id, dto.body);
  }

  @Post('messages/:id/reject')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  reject(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.reject(t, id);
  }

  @Post('messages/:id/feedback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Report an inaccurate AI reply and give the correct information' })
  @RequireTenantPermission('inbox.reply')
  feedback(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.conversations.reportInaccuracy(t, id, dto);
  }

  @Post('feedback/:id/resolve')
  @HttpCode(200)
  @RequireTenantPermission('inbox.reply')
  resolveFeedback(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.conversations.resolveFeedback(t, id);
  }

  @Post('playground')
  @HttpCode(200)
  @Throttle(aiThrottle())
  @ApiOperation({ summary: 'Test the agent as a customer would use it. Test conversations are not counted and nothing is sent anywhere' })
  @RequireTenantPermission('ai.use')
  playground(@Tenant() t: TenantContext, @Body() dto: PlaygroundDto) {
    return this.conversations.playground(t, dto.message, dto.conversationId);
  }

  // ─── Customers and leads ────────────────────────────────────────────────

  @Get('customers')
  @RequireTenantPermission('inbox.read')
  customerList(@Tenant() t: TenantContext, @Query() q: CustomersQueryDto) {
    return this.customers.list(t, q);
  }

  @Get('customers/:id')
  @RequireTenantPermission('inbox.read')
  customer(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.customers.get(t, id);
  }

  @Patch('customers/:id')
  @ApiOperation({ summary: 'Update a customer: contact details, lead status, follow-up date, assignee' })
  @RequireTenantPermission('inbox.reply')
  updateCustomer(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(t, id, dto);
  }

  @Post('customers/:id/notes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Internal note: never shown to the customer and never given to the AI' })
  @RequireTenantPermission('inbox.reply')
  addNote(@Tenant() t: TenantContext, @Param('id') id: string, @Body() dto: NoteDto) {
    return this.customers.addNote(t, id, dto);
  }

  @Delete('customers/:id/notes/:noteId')
  @RequireTenantPermission('inbox.reply')
  deleteNote(@Tenant() t: TenantContext, @Param('id') id: string, @Param('noteId') noteId: string) {
    return this.customers.deleteNote(t, id, noteId);
  }

  @Delete('customers/:id')
  @ApiOperation({ summary: 'Erase a customer\'s personal data (privacy request)' })
  @RequireTenantPermission('business.update')
  erase(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.customers.erase(t, id);
  }

  @Get('leads')
  @RequireTenantPermission('inbox.read')
  leads(@Tenant() t: TenantContext) {
    return this.insights.leads(t);
  }

  @Get('opportunities')
  @RequireTenantPermission('inbox.read')
  opportunities(@Tenant() t: TenantContext) {
    return this.insights.opportunities(t);
  }

  @Get('follow-ups')
  @RequireTenantPermission('inbox.read')
  followUps(@Tenant() t: TenantContext) {
    return this.insights.followUps(t);
  }

  // ─── FAQ and analytics ──────────────────────────────────────────────────

  @Get('faq')
  @RequireTenantPermission('inbox.read')
  faq(@Tenant() t: TenantContext) {
    return this.insights.faq(t);
  }

  @Post('faq/drafts')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add an answer to the knowledge as an UNVERIFIED FAQ entry (used by the agent only after verification)' })
  @RequireTenantPermission('knowledge.write')
  faqDraft(@Tenant() t: TenantContext, @Body() dto: FaqDraftDto) {
    return this.insights.createFaqDraft(t, dto);
  }

  @Get('monitoring')
  @ApiOperation({ summary: 'AI health, calls, failures, latency, tokens, cost, handoffs and draft approval of this business. Never includes message content' })
  @RequireTenantPermission('analytics.read')
  monitor(@Tenant() t: TenantContext, @Query() q: AnalyticsQueryDto) {
    return this.monitoring.monitoring(t, q.days);
  }

  @Get('analytics')
  @RequireTenantPermission('inbox.read')
  analytics(@Tenant() t: TenantContext, @Query() q: AnalyticsQueryDto) {
    return this.insights.analytics(t, q.days);
  }
}
