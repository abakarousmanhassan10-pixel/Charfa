import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type Message } from '@touma/database';
import { agentMessage, resolveReplyLanguage, type AgentLanguage } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { ConversationsQueryDto, FeedbackDto, UpdateAgentDto } from './sales.dto';
import { SalesAgentService } from './sales-agent.service';

type Meta = { kind?: string; intent?: string; confidence?: string; sources?: string[]; cards?: unknown[]; reason?: string; flagged?: boolean; edited?: boolean; handoff?: unknown; injectionFlags?: string[]; nextStep?: string; purchaseIntent?: string; model?: string };

/** Dashboard operations on conversations: reading, taking over, pausing, resuming, replying, reviewing AI drafts, corrections and the agent configuration. */
@Injectable()
export class SalesConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: SalesAgentService,
    private readonly audit: AuditService,
  ) {}

  // ─── Configuration ────────────────────────────────────────────────────────

  async getConfig(tenant: TenantContext) {
    return this.configDto(await this.agent.config(tenant.businessId));
  }

  private configDto(c: Awaited<ReturnType<SalesAgentService['config']>>) {
    return {
      enabled: c.enabled, name: c.name, languages: c.languages, defaultLanguage: c.defaultLanguage, tone: c.tone, greeting: c.greeting, replyMode: c.replyMode,
      autoReplyAuthorizedAt: c.autoReplyAuthorizedAt?.toISOString() ?? null, autoReplyAuthorizedById: c.autoReplyAuthorizedById, maxAiRepliesPerConversation: c.maxAiRepliesPerConversation, autoMinConfidence: c.autoMinConfidence, privacyNoticeUrl: c.privacyNoticeUrl, retentionDays: c.retentionDays, updatedAt: c.updatedAt.toISOString(),
    };
  }

  async updateConfig(tenant: TenantContext, dto: UpdateAgentDto) {
    const cur = await this.agent.config(tenant.businessId);
    const languages = dto.languages ?? cur.languages;
    const def = dto.defaultLanguage ?? cur.defaultLanguage;
    if (!languages.includes(def)) throw new BadRequestException({ code: 'DEFAULT_LANGUAGE_NOT_SUPPORTED', message: 'The default language must be one of the supported languages' });
    const authorizing = dto.replyMode === 'AUTO' && cur.replyMode !== 'AUTO';
    const data: Prisma.SalesAgentConfigUpdateInput = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}), ...(dto.name !== undefined ? { name: dto.name } : {}), languages, defaultLanguage: def,
      ...(dto.tone !== undefined ? { tone: dto.tone } : {}), ...(dto.greeting !== undefined ? { greeting: dto.greeting } : {}),
      ...(dto.maxAiRepliesPerConversation !== undefined ? { maxAiRepliesPerConversation: dto.maxAiRepliesPerConversation } : {}),
      ...(dto.autoMinConfidence ? { autoMinConfidence: dto.autoMinConfidence } : {}), ...(dto.privacyNoticeUrl !== undefined ? { privacyNoticeUrl: dto.privacyNoticeUrl } : {}), ...(dto.retentionDays !== undefined ? { retentionDays: dto.retentionDays } : {}),
      ...(dto.replyMode ? { replyMode: dto.replyMode } : {}), ...(authorizing ? { autoReplyAuthorizedById: tenant.userId, autoReplyAuthorizedAt: new Date() } : dto.replyMode === 'REVIEW' ? { autoReplyAuthorizedById: null, autoReplyAuthorizedAt: null } : {}),
      updatedById: tenant.userId,
    };
    const updated = await this.prisma.salesAgentConfig.update({ where: { businessId: tenant.businessId }, data });
    await this.audit.record({ action: 'sales.agent_configured', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SalesAgentConfig', entityId: updated.id, metadata: { fields: Object.keys(dto), enabled: updated.enabled, replyMode: updated.replyMode, languages: updated.languages } });
    if (authorizing) await this.audit.record({ action: 'sales.auto_reply_authorized', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SalesAgentConfig', entityId: updated.id, metadata: {} });
    return this.configDto(updated);
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  private metaOf(m: Message): Meta {
    return (m.aiMetadata ?? {}) as Meta;
  }

  /** Message as shown to the merchant: includes AI details (confidence, sources, flags) and drafts. */
  messageDto(m: Message & { authorUser?: { fullName: string | null } | null }) {
    const meta = this.metaOf(m);
    return {
      id: m.id, direction: m.direction, author: m.authorType, authorName: m.authorUser?.fullName ?? null, body: m.body, language: m.language, intent: m.intent, approvalStatus: m.approvalStatus,
      sent: m.sentAt !== null, sentAt: m.sentAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(),
      ai: m.authorType === 'AI_REPLY' || m.authorType === 'AI_SUGGESTION' || meta.kind === 'handoff' ? { kind: meta.kind ?? null, confidence: meta.confidence ?? null, sources: meta.sources ?? [], cards: meta.cards ?? [], handoffReason: meta.reason ?? null, flagged: Boolean(meta.flagged), edited: Boolean(meta.edited), nextStep: meta.nextStep ?? null, model: meta.model ?? null } : null,
      injectionFlags: meta.injectionFlags ?? [],
    };
  }

  private row(c: Awaited<ReturnType<SalesConversationsService['loadRows']>>[number]) {
    const last = c.messages[0];
    return {
      id: c.id, channel: c.channel, status: c.status, aiMode: c.aiMode, isTest: c.isTest, language: c.language, intent: c.intent, purchaseIntent: c.purchaseIntent, escalated: c.escalated, handoffReason: c.handoffReason,
      handoffRequestedAt: c.handoffRequestedAt?.toISOString() ?? null, aiRepliesCount: c.aiRepliesCount, lastMessageAt: c.lastMessageAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
      customer: c.customer ? { id: c.customer.id, name: c.customer.name, leadStatus: c.customer.leadStatus } : null,
      lastMessage: last ? { body: last.body.slice(0, 160), author: last.authorType } : null,
      pendingDrafts: c._count?.messages ?? 0,
    };
  }

  private loadRows(where: Prisma.ConversationWhereInput, skip: number, take: number) {
    return this.prisma.conversation.findMany({
      where, orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }], skip, take,
      include: { customer: { select: { id: true, name: true, leadStatus: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, authorType: true } }, _count: { select: { messages: { where: { authorType: 'AI_SUGGESTION', approvalStatus: 'PENDING' } } } } },
    });
  }

  async list(tenant: TenantContext, q: ConversationsQueryDto) {
    const where: Prisma.ConversationWhereInput = {
      businessId: tenant.businessId, channel: { in: ['WEB_CHAT', 'INSTAGRAM_DM', 'FACEBOOK_MESSENGER', 'OTHER'] }, ...(q.includeTest ? {} : { isTest: false }),
      ...(q.status ? { status: q.status as never } : {}), ...(q.aiMode ? { aiMode: q.aiMode as never } : {}), ...(q.leadStatus ? { customer: { leadStatus: q.leadStatus as never } } : {}),
      ...(q.needsHuman ? { OR: [{ status: 'PENDING_HUMAN' }, { messages: { some: { authorType: 'AI_SUGGESTION', approvalStatus: 'PENDING' } } }] } : {}),
      ...(q.q ? { OR: [{ customer: { name: { contains: q.q, mode: 'insensitive' } } }, { messages: { some: { body: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.loadRows(where, (q.page - 1) * q.pageSize, q.pageSize), this.prisma.conversation.count({ where })]);
    return { items: rows.map((r) => this.row(r)), total, page: q.page, pageSize: q.pageSize, pageCount: Math.max(1, Math.ceil(total / q.pageSize)) };
  }

  private async load(tenant: TenantContext, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, businessId: tenant.businessId }, include: { customer: true } });
    if (!c) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    return c;
  }

  async get(tenant: TenantContext, id: string) {
    const c = await this.load(tenant, id);
    const [messages, notes, feedback] = await Promise.all([
      this.prisma.message.findMany({ where: { conversationId: id, businessId: tenant.businessId }, orderBy: { createdAt: 'asc' }, take: 500, include: { authorUser: { select: { fullName: true } } } }),
      this.prisma.customerNote.findMany({ where: { businessId: tenant.businessId, OR: [{ conversationId: id }, ...(c.customerId ? [{ customerId: c.customerId, conversationId: null }] : [])] }, orderBy: { createdAt: 'desc' }, take: 50, include: { author: { select: { fullName: true } } } }),
      this.prisma.agentFeedback.findMany({ where: { conversationId: id, businessId: tenant.businessId }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      conversation: {
        id: c.id, channel: c.channel, status: c.status, aiMode: c.aiMode, isTest: c.isTest, language: c.language, intent: c.intent, purchaseIntent: c.purchaseIntent, escalated: c.escalated, handoffReason: c.handoffReason,
        handoffRequestedAt: c.handoffRequestedAt?.toISOString() ?? null, humanTakeoverById: c.humanTakeoverById, aiRepliesCount: c.aiRepliesCount, createdAt: c.createdAt.toISOString(), lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      },
      customer: c.customer ? { id: c.customer.id, name: c.customer.name, email: c.customer.email, phone: c.customer.phone, language: c.customer.language, leadStatus: c.customer.leadStatus, purchaseIntent: c.customer.purchaseIntent, interests: c.customer.interests, consent: c.customer.consentAt !== null, anonymized: c.customer.anonymizedAt !== null } : null,
      messages: messages.map((m) => this.messageDto(m)),
      notes: notes.map((n) => ({ id: n.id, body: n.body, authorName: n.author?.fullName ?? null, createdAt: n.createdAt.toISOString(), conversationId: n.conversationId })),
      feedback: feedback.map((f) => ({ id: f.id, messageId: f.messageId, note: f.note, correction: f.correction, status: f.status, knowledgeEntryId: f.knowledgeEntryId, createdAt: f.createdAt.toISOString() })),
    };
  }

  /** The merchant tries the agent as a customer. The conversation is a TEST: never counted, never sent anywhere. */
  async playground(tenant: TenantContext, message: string, conversationId?: string) {
    const conv = conversationId
      ? await this.prisma.conversation.findFirst({ where: { id: conversationId, businessId: tenant.businessId, isTest: true } })
      : await this.prisma.conversation.create({ data: { businessId: tenant.businessId, channel: 'WEB_CHAT', isTest: true, customerName: 'Test' } });
    if (!conv) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Test conversation not found' });
    const turn = await this.agent.handleCustomerMessage({ businessId: tenant.businessId, conversationId: conv.id, text: message, forceAuto: true });
    return { ...(await this.get(tenant, conv.id)), outcome: turn.outcome };
  }

  // ─── Human control ────────────────────────────────────────────────────────

  private async setMode(tenant: TenantContext, id: string, action: 'takeover' | 'pause' | 'resume') {
    const c = await this.load(tenant, id);
    const cfg = await this.agent.config(tenant.businessId);
    if (c.status === 'ARCHIVED') throw new ConflictException({ code: 'INVALID_STATE', message: 'An archived conversation cannot be changed' });
    if (action === 'resume' && !cfg.enabled) throw new ConflictException({ code: 'AGENT_DISABLED', message: 'The agent is switched off. Turn it on in the agent settings first.' });
    const data: Prisma.ConversationUpdateInput = action === 'takeover'
      ? { aiMode: 'HUMAN', humanTakeoverById: tenant.userId, assignedToId: tenant.userId, status: 'OPEN' }
      : action === 'pause' ? { aiMode: 'AI_PAUSED' }
      : { aiMode: 'AI_ACTIVE', humanTakeoverById: null, escalated: false, escalationReason: null, handoffReason: null, handoffRequestedAt: null, status: c.status === 'PENDING_HUMAN' ? 'OPEN' : c.status };
    if (c.aiMode === data.aiMode) throw new ConflictException({ code: 'INVALID_STATE', message: `The conversation is already in this mode` });
    await this.prisma.conversation.update({ where: { id }, data });
    if (action === 'takeover') {
      const lang = resolveReplyLanguage((c.language as AgentLanguage | null) ?? null, cfg.languages, cfg.defaultLanguage as AgentLanguage).language;
      await this.agent.systemMessage(c, agentMessage('human', lang), 'human_joined');
      // Drafts written for the previous mode are not valid any more.
      await this.prisma.message.updateMany({ where: { conversationId: id, authorType: 'AI_SUGGESTION', approvalStatus: 'PENDING' }, data: { approvalStatus: 'REJECTED' } });
    }
    await this.audit.record({ action: `sales.${action}`, actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Conversation', entityId: id, metadata: { from: c.aiMode } });
    return this.get(tenant, id);
  }
  takeover(t: TenantContext, id: string) { return this.setMode(t, id, 'takeover'); }
  pause(t: TenantContext, id: string) { return this.setMode(t, id, 'pause'); }
  resume(t: TenantContext, id: string) { return this.setMode(t, id, 'resume'); }

  async setStatus(tenant: TenantContext, id: string, status: 'RESOLVED' | 'OPEN' | 'ARCHIVED') {
    const c = await this.load(tenant, id);
    await this.prisma.conversation.update({ where: { id }, data: { status } });
    await this.audit.record({ action: `sales.conversation_${status.toLowerCase()}`, actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Conversation', entityId: id, metadata: { from: c.status } });
    return this.get(tenant, id);
  }

  /** A person writes to the customer. It takes the conversation over (the AI stops) so the two never answer at once. */
  async reply(tenant: TenantContext, id: string, body: string) {
    const c = await this.load(tenant, id);
    if (c.status === 'ARCHIVED') throw new ConflictException({ code: 'INVALID_STATE', message: 'An archived conversation cannot be replied to' });
    if (c.isTest) throw new UnprocessableEntityException({ code: 'TEST_CONVERSATION', message: 'This is a test conversation: there is nobody to send to' });
    if (c.aiMode !== 'HUMAN') await this.prisma.conversation.update({ where: { id }, data: { aiMode: 'HUMAN', humanTakeoverById: tenant.userId, assignedToId: tenant.userId } });
    await this.prisma.message.updateMany({ where: { conversationId: id, authorType: 'AI_SUGGESTION', approvalStatus: 'PENDING' }, data: { approvalStatus: 'REJECTED' } });
    const m = await this.prisma.message.create({ data: { businessId: tenant.businessId, conversationId: id, direction: 'OUTBOUND', authorType: 'HUMAN_AGENT', authorUserId: tenant.userId, body, sentAt: new Date() } });
    await this.prisma.conversation.update({ where: { id }, data: { status: 'OPEN', lastMessageAt: new Date() } });
    await this.audit.record({ action: 'sales.human_reply', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Message', entityId: m.id, metadata: { conversationId: id, tookOver: c.aiMode !== 'HUMAN' } });
    return this.get(tenant, id);
  }

  // ─── Reviewing AI replies ─────────────────────────────────────────────────

  private async draft(tenant: TenantContext, messageId: string) {
    const m = await this.prisma.message.findFirst({ where: { id: messageId, businessId: tenant.businessId } });
    if (!m) throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found' });
    return m;
  }

  /** Approves an AI draft (optionally edited): only now is it visible to the customer. */
  async approve(tenant: TenantContext, messageId: string, body?: string) {
    const m = await this.draft(tenant, messageId);
    if (m.authorType !== 'AI_SUGGESTION' || m.approvalStatus !== 'PENDING') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a pending AI draft can be approved' });
    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: m.conversationId } });
    if (conv.isTest) throw new UnprocessableEntityException({ code: 'TEST_CONVERSATION', message: 'This is a test conversation' });
    const meta = this.metaOf(m);
    const edited = body !== undefined && body !== m.body;
    const res = await this.prisma.message.updateMany({
      where: { id: m.id, approvalStatus: 'PENDING' },
      data: { approvalStatus: 'APPROVED', sentAt: new Date(), authorUserId: tenant.userId, ...(edited ? { body, aiMetadata: { ...meta, edited: true, originalBody: m.body } as unknown as Prisma.InputJsonValue } : {}) },
    });
    if (!res.count) throw new ConflictException({ code: 'INVALID_STATE', message: 'This draft changed' });
    await this.prisma.conversation.update({ where: { id: m.conversationId }, data: { lastMessageAt: new Date() } });
    await this.audit.record({ action: 'sales.draft_approved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Message', entityId: m.id, metadata: { conversationId: m.conversationId, edited } });
    return this.get(tenant, m.conversationId);
  }

  async reject(tenant: TenantContext, messageId: string) {
    const m = await this.draft(tenant, messageId);
    if (m.authorType !== 'AI_SUGGESTION' || m.approvalStatus !== 'PENDING') throw new ConflictException({ code: 'INVALID_STATE', message: 'Only a pending AI draft can be rejected' });
    await this.prisma.message.update({ where: { id: m.id }, data: { approvalStatus: 'REJECTED' } });
    await this.audit.record({ action: 'sales.draft_rejected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Message', entityId: m.id, metadata: { conversationId: m.conversationId } });
    return this.get(tenant, m.conversationId);
  }

  async suggest(tenant: TenantContext, id: string) {
    await this.load(tenant, id);
    const r = await this.agent.suggestReply(tenant, id);
    if (!r.ok) throw new UnprocessableEntityException({ code: 'AI_FAILED', message: 'The AI could not write a draft right now. You can reply yourself.' });
    return this.get(tenant, id);
  }

  /** "This AI reply was wrong": records what was wrong and the right information, and can prepare an UNVERIFIED knowledge entry. */
  async reportInaccuracy(tenant: TenantContext, messageId: string, dto: FeedbackDto) {
    const m = await this.draft(tenant, messageId);
    if (!['AI_REPLY', 'AI_SUGGESTION'].includes(m.authorType)) throw new BadRequestException({ code: 'NOT_AN_AI_MESSAGE', message: 'Only AI replies can be corrected' });
    let knowledgeEntryId: string | null = null;
    if (dto.addToKnowledge) {
      if (!dto.correction) throw new BadRequestException({ code: 'CORRECTION_REQUIRED', message: 'Write the correct information to add it to the knowledge' });
      const e = await this.prisma.knowledgeEntry.create({ data: { businessId: tenant.businessId, source: 'MANUAL', category: 'FAQ', title: dto.note.slice(0, 200), body: dto.correction, createdById: tenant.userId } });
      knowledgeEntryId = e.id; // verified=false: the agent will not use it until a person verifies it
    }
    const f = await this.prisma.agentFeedback.create({ data: { businessId: tenant.businessId, conversationId: m.conversationId, messageId: m.id, reporterId: tenant.userId, note: dto.note, correction: dto.correction ?? null, knowledgeEntryId } });
    await this.prisma.message.update({ where: { id: m.id }, data: { aiMetadata: { ...this.metaOf(m), flagged: true } as unknown as Prisma.InputJsonValue, ...(m.authorType === 'AI_SUGGESTION' && m.approvalStatus === 'PENDING' ? { approvalStatus: 'REJECTED' as const } : {}) } });
    await this.audit.record({ action: 'sales.inaccuracy_reported', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Message', entityId: m.id, metadata: { feedbackId: f.id, knowledgeEntryId } });
    return { id: f.id, knowledgeEntryId, status: f.status };
  }

  async resolveFeedback(tenant: TenantContext, id: string) {
    const f = await this.prisma.agentFeedback.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!f) throw new NotFoundException({ code: 'FEEDBACK_NOT_FOUND', message: 'Feedback not found' });
    await this.prisma.agentFeedback.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    return { id, status: 'RESOLVED' };
  }
}
