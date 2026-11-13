import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Conversation, type Customer, type EscalationReason, type LeadStatus, type PurchaseIntent, type SalesAgentConfig } from '@touma/database';
import {
  AgentRunError, estimateCostUsd, runAgent, salesAgent, selectRelevantItems, selectRelevantKnowledge, detectInjection, type BusinessContext, type EngineConfig, type SalesReply, type TextModelProvider,
} from '@touma/ai-engine';
import {
  agentMessage, detectEscalation, detectLanguage, escalationMessage, resolveReplyLanguage, SALES_LIMITS, type AgentLanguage, type HandoffReason, type PurchaseIntentId,
} from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { TEXT_PROVIDER } from '../ai/ai-provider';
import { AiUsageService } from '../ai/ai-usage.service';
import { errorKind } from './sales-monitoring.service';
import { SalesAssistService } from './sales-assist.service';
import { AuditService } from '../audit/audit.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

const INTENT_ORDER: PurchaseIntentId[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
const maxIntent = (a: PurchaseIntentId, b: PurchaseIntentId) => (INTENT_ORDER.indexOf(a) >= INTENT_ORDER.indexOf(b) ? a : b);
const ESCALATION_ENUM: Record<string, EscalationReason> = { REFUND: 'REFUND', FINANCIAL_COMMITMENT: 'FINANCIAL_COMMITMENT', LEGAL_COMPLAINT: 'LEGAL_COMPLAINT', SENSITIVE: 'SENSITIVE_DISPUTE', UNVERIFIED_INFO: 'UNVERIFIED_PROMISE' };

/** The tenant scope for work done on behalf of a customer (no signed-in person): only the business id is meaningful. */
export const systemTenant = (businessId: string): TenantContext => ({ businessId, membershipId: '', role: 'VIEWER', userId: '' });

/** Lead status only moves forward automatically, and never out of WON or LOST (a person decided those). */
export function nextLeadStatus(current: LeadStatus, s: { customerMessages: number; purchaseIntent: PurchaseIntentId; hasContact: boolean; productInterest: boolean }): LeadStatus {
  if (current === 'WON' || current === 'LOST') return current;
  const rank: LeadStatus[] = ['NEW', 'ENGAGED', 'QUALIFIED', 'OPPORTUNITY'];
  let target: LeadStatus = 'NEW';
  if (s.customerMessages >= 2 || s.productInterest) target = 'ENGAGED';
  if (s.purchaseIntent === 'MEDIUM' || s.purchaseIntent === 'HIGH' || (s.hasContact && s.productInterest)) target = 'QUALIFIED';
  if (s.purchaseIntent === 'HIGH' && s.hasContact) target = 'OPPORTUNITY';
  return rank.indexOf(target) > rank.indexOf(current) ? target : current;
}

export interface TurnResult {
  /** What happened to this customer message. */
  outcome: 'ANSWERED' | 'DRAFTED' | 'HANDOFF' | 'WAITING_FOR_HUMAN' | 'SKIPPED';
  messageIds: string[];
}

/**
 * The conversation engine. For one customer message it decides, in this order and without exceptions:
 *  1. a person is already in charge (AI paused or human takeover): nothing is generated;
 *  2. deterministic escalation (refund, legal, sensitive, order status, "I want a person"): a fixed, human-written message and a
 *     handoff, WITHOUT calling the model;
 *  3. cost and abuse limits (per conversation, per business per day): handoff;
 *  4. the model answers from the tenant's verified context only; its output is validated (schema, grounding of every amount,
 *     no price of another item, no unavailable recommendation, no confirmed orders, sources must exist) and repaired once;
 *  5. anything uncertain (low confidence, not answerable, handoff requested, model/provider failure) becomes a handoff with a
 *     fixed message: model text is never sent for an escalated case.
 * The agent has no tools: it cannot send anything by itself outside the conversation, place orders or take payments. In REVIEW
 * mode even its answers are only drafts until a person approves them.
 */
@Injectable()
export class SalesAgentService {
  private readonly logger = new Logger('SalesAgent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly usage: AiUsageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly assist: SalesAssistService,
    @Inject(TEXT_PROVIDER) private readonly provider: TextModelProvider,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get engineConfig(): EngineConfig {
    const t = this.env.SALES_AGENT_TEMPERATURE;
    return { model: this.env.SALES_AGENT_MODEL ?? this.env.AI_MODEL, temperature: t === 'none' ? null : Number(t), maxOutputTokens: Math.min(this.env.AI_MAX_OUTPUT_TOKENS, 1200), timeoutMs: this.env.SALES_AGENT_TIMEOUT_MS, maxProviderRetries: this.env.AI_MAX_PROVIDER_RETRIES, maxRepairAttempts: this.env.AI_MAX_REPAIR_ATTEMPTS };
  }

  async config(businessId: string): Promise<SalesAgentConfig> {
    return this.prisma.salesAgentConfig.upsert({ where: { businessId }, create: { businessId }, update: {} });
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  /** Records the customer's message and lets the agent react. `forceAuto` is for the dashboard playground, where the only reader is the merchant. */
  async handleCustomerMessage(args: { businessId: string; conversationId: string; text: string; forceAuto?: boolean }): Promise<TurnResult & { customerMessageId: string }> {
    const { businessId, conversationId, text } = args;
    const cfg = await this.config(businessId);
    let conv = await this.prisma.conversation.findFirstOrThrow({ where: { id: conversationId, businessId }, include: { customer: true } });
    const guess = detectLanguage(text);
    const supported = cfg.languages as AgentLanguage[];
    const reply = resolveReplyLanguage(guess.language, supported, cfg.defaultLanguage as AgentLanguage, conv.language as AgentLanguage | null);
    const injection = detectInjection(text);
    const inbound = await this.prisma.message.create({
      data: { businessId, conversationId, direction: 'INBOUND', authorType: 'CUSTOMER', body: text, language: guess.language ?? null, sentAt: new Date(), aiMetadata: injection.length ? ({ injectionFlags: injection } as Prisma.InputJsonValue) : undefined },
    });
    const count = await this.prisma.message.count({ where: { conversationId, authorType: 'CUSTOMER' } });
    conv = await this.prisma.conversation.update({
      where: { id: conversationId }, include: { customer: true },
      data: { lastMessageAt: new Date(), language: guess.language ?? conv.language ?? reply.language, ...(conv.status === 'RESOLVED' || conv.status === 'ARCHIVED' ? { status: 'OPEN' as const } : {}) },
    });
    if (conv.customerId) await this.prisma.customer.update({ where: { id: conv.customerId }, data: { lastSeenAt: new Date(), language: guess.language ?? undefined } });

    const done = (r: TurnResult) => ({ ...r, customerMessageId: inbound.id });
    // 1. A person is in charge.
    if (conv.aiMode !== 'AI_ACTIVE') {
      await this.afterTurn(conv, { customerMessages: count, intent: null, purchaseIntent: 'NONE', interests: [] });
      if (conv.status !== 'PENDING_HUMAN') await this.notifyHumanWaiting(conv, 'customer_message');
      return done({ outcome: 'WAITING_FOR_HUMAN', messageIds: [] });
    }
    // 2. Deterministic escalation: no model call.
    const esc = detectEscalation(text);
    if (esc) {
      const id = await this.handoff(conv, esc.reason, reply.language, escalationMessage(esc.reason, reply.language), esc.intent);
      await this.afterTurn(conv, { customerMessages: count, intent: esc.intent, purchaseIntent: 'NONE', interests: [] });
      return done({ outcome: 'HANDOFF', messageIds: [id] });
    }
    // 3. Limits.
    if (conv.aiRepliesCount >= cfg.maxAiRepliesPerConversation) {
      const id = await this.handoff(conv, 'OTHER', reply.language, agentMessage('limit', reply.language), null);
      return done({ outcome: 'HANDOFF', messageIds: [id] });
    }
    const since = new Date(Date.now() - 24 * 3_600_000);
    const today = await this.prisma.message.count({ where: { businessId, authorType: { in: ['AI_REPLY', 'AI_SUGGESTION'] }, createdAt: { gte: since } } });
    if (today >= this.env.SALES_AGENT_DAILY_REPLY_CAP) {
      const id = await this.handoff(conv, 'AI_UNAVAILABLE', reply.language, escalationMessage('AI_UNAVAILABLE', reply.language), null);
      return done({ outcome: 'HANDOFF', messageIds: [id] });
    }
    // 4-5. The model.
    let mode: 'AUTO' | 'REVIEW' = args.forceAuto || conv.isTest ? 'AUTO' : cfg.replyMode;
    const gen = await this.generate(conv, cfg, reply.language);
    if (!gen.ok) {
      const id = await this.handoff(conv, 'AI_UNAVAILABLE', reply.language, escalationMessage('AI_UNAVAILABLE', reply.language), null, gen.error);
      return done({ outcome: 'HANDOFF', messageIds: [id] });
    }
    const out = gen.reply;
    const uncertain = out.handoff.needed || !out.answerable || out.confidence === 'LOW';
    if (uncertain) {
      const reason: HandoffReason = out.handoff.needed && out.handoff.reason !== 'NONE' ? out.handoff.reason : out.answerable ? 'LOW_CONFIDENCE' : 'UNVERIFIED_INFO';
      const id = await this.handoff(conv, reason, reply.language, escalationMessage(reason, reply.language), out.intent, undefined, { modelReply: out, model: gen.model });
      await this.afterTurn(conv, { customerMessages: count, intent: out.intent, purchaseIntent: out.purchaseIntent, interests: [] });
      return done({ outcome: 'HANDOFF', messageIds: [id] });
    }
    // Automatic answers need enough confidence; anything below the merchant's threshold becomes a draft for a person.
    const lowerThanThreshold = mode === 'AUTO' && !args.forceAuto && !conv.isTest && cfg.autoMinConfidence === 'HIGH' && out.confidence !== 'HIGH';
    if (lowerThanThreshold) mode = 'REVIEW';
    const interests = out.recommended.map((r) => `${r.type === 'PRODUCT' ? 'product' : 'service'}:${r.id}`);
    const meta = { kind: 'ai_reply', intent: out.intent, confidence: out.confidence, sources: out.sources, nextStep: out.nextStep, purchaseIntent: out.purchaseIntent, cards: gen.cards, model: gen.model, promptVersion: salesAgent.promptVersion, heldForReview: lowerThanThreshold || undefined, injectionFlags: injection.length ? injection : undefined, answerable: true };
    const ids: string[] = [];
    // In REVIEW mode the customer first sees the fixed "a team member will reply" note; the draft itself stays invisible until approved.
    if (mode === 'REVIEW') ids.push(await this.systemMessage(conv, agentMessage('reviewPending', reply.language), 'review_pending'));
    const msg = await this.prisma.message.create({
      data: {
        businessId, conversationId, direction: 'OUTBOUND', language: reply.language, intent: out.intent, body: out.reply, aiMetadata: meta as unknown as Prisma.InputJsonValue,
        ...(mode === 'AUTO' ? { authorType: 'AI_REPLY' as const, approvalStatus: 'NOT_REQUIRED' as const, sentAt: new Date() } : { authorType: 'AI_SUGGESTION' as const, approvalStatus: 'PENDING' as const }),
      },
    });
    ids.unshift(msg.id);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { aiRepliesCount: { increment: 1 }, lastMessageAt: new Date() } });
    if (mode === 'REVIEW') await this.notifyHumanWaiting(conv, 'draft_ready');
    await this.afterTurn(conv, { customerMessages: count, intent: out.intent, purchaseIntent: out.purchaseIntent, interests });
    return done({ outcome: mode === 'AUTO' ? 'ANSWERED' : 'DRAFTED', messageIds: ids });
  }

  /** A draft for a person to review during a takeover (never sent). */
  async suggestReply(tenant: TenantContext, conversationId: string) {
    const conv = await this.prisma.conversation.findFirstOrThrow({ where: { id: conversationId, businessId: tenant.businessId }, include: { customer: true } });
    const cfg = await this.config(tenant.businessId);
    const lastCustomer = await this.prisma.message.findFirst({ where: { conversationId, authorType: 'CUSTOMER' }, orderBy: { createdAt: 'desc' } });
    const language = resolveReplyLanguage(detectLanguage(lastCustomer?.body ?? '').language, cfg.languages, cfg.defaultLanguage as AgentLanguage, conv.language as AgentLanguage | null).language;
    const gen = await this.generate(conv, cfg, language, tenant.userId);
    if (!gen.ok) return { ok: false as const, error: gen.error };
    const out = gen.reply;
    const msg = await this.prisma.message.create({
      data: {
        businessId: tenant.businessId, conversationId, direction: 'OUTBOUND', authorType: 'AI_SUGGESTION', approvalStatus: 'PENDING', language, intent: out.intent, body: out.reply,
        aiMetadata: { kind: 'ai_draft', intent: out.intent, confidence: out.confidence, sources: out.sources, cards: gen.cards, model: gen.model, answerable: out.answerable, handoff: out.handoff, requestedBy: tenant.userId } as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({ action: 'sales.draft_suggested', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Conversation', entityId: conversationId, metadata: { messageId: msg.id } });
    return { ok: true as const, messageId: msg.id };
  }

  // ─── Model call ───────────────────────────────────────────────────────────

  private async generate(conv: Conversation & { customer?: Customer | null }, cfg: SalesAgentConfig, language: AgentLanguage, userId: string | null = null): Promise<
    { ok: true; reply: SalesReply; cards: Array<Record<string, unknown>>; model: string } | { ok: false; error: string }
  > {
    const businessId = conv.businessId;
    const ctx = (await this.knowledge.buildAgentContext(systemTenant(businessId))) as unknown as BusinessContext;
    const recent = await this.prisma.message.findMany({
      where: { conversationId: conv.id, OR: [{ authorType: 'CUSTOMER' }, { authorType: 'AI_REPLY' }, { authorType: 'HUMAN_AGENT', sentAt: { not: null } }, { authorType: 'AI_SUGGESTION', approvalStatus: 'APPROVED' }] },
      orderBy: { createdAt: 'desc' }, take: SALES_LIMITS.historyForModel,
    });
    const history = recent.reverse().map((m) => ({ from: (m.authorType === 'CUSTOMER' ? 'customer' : m.authorType === 'HUMAN_AGENT' ? 'staff' : 'assistant') as 'customer' | 'assistant' | 'staff', text: m.body.slice(0, SALES_LIMITS.messageMax) }));
    const focus = recent.flatMap((m) => ((m.aiMetadata as { cards?: Array<{ id: string }> } | null)?.cards ?? []).map((c) => c.id));
    const itemIds = selectRelevantItems(ctx, history.filter((h) => h.from === 'customer').map((h) => h.text), { focusIds: focus });
    try {
      const res = await runAgent(salesAgent, { provider: this.provider, context: ctx, input: { replyLanguage: language, itemIds, knowledgeIds: selectRelevantKnowledge(ctx, history.filter((h) => h.from === 'customer').map((h) => h.text)), conversation: history, agentName: cfg.name, tone: cfg.tone }, config: this.engineConfig });
      await this.recordUsage(businessId, userId, res.attempts);
      const cards = res.output.recommended.map((r) => {
        const row = (r.type === 'PRODUCT' ? ctx.products : ctx.services).find((x) => x.id === r.id) as Record<string, unknown> | undefined;
        // Card facts come from the verified record, never from the model.
        return { type: r.type, id: r.id, name: row?.name, price: row?.price ?? null, discountPrice: row?.discountPrice ?? null, currency: row?.currency ?? ctx.business.currency, availability: row?.availability ?? null, url: row?.url ?? row?.bookingUrl ?? null };
      });
      return { ok: true, reply: res.output, cards, model: res.model };
    } catch (err) {
      if (err instanceof AgentRunError) await this.recordUsage(businessId, userId, err.attempts);
      const message = (err as Error).message?.slice(0, 300) ?? 'AI failure';
      this.logger.warn(`sales agent failed for ${businessId}: ${(err as Error).name}`);
      return { ok: false, error: message };
    }
  }

  private async recordUsage(businessId: string, userId: string | null, attempts: AgentRunError['attempts']) {
    if (!attempts.length) return;
    await this.prisma.aIUsage.createMany({
      data: attempts.map((a) => {
        const price = this.usage.priceFor(a.model);
        return {
          businessId, userId: userId || null, agent: 'CUSTOMER_SUPPORT' as const, provider: this.provider.name, model: a.model, operation: 'sales_reply', inputTokens: a.inputTokens, outputTokens: a.outputTokens,
          costUsd: estimateCostUsd(a.inputTokens, a.outputTokens, price.pricing), success: a.success,
          // Generic, credential-free text only. A validation failure records how many rules failed, never the model's or the customer's words.
          error: a.error?.slice(0, 300) ?? (a.issues?.length ? `validation: ${a.issues.length} rule(s) failed` : null), latencyMs: a.latencyMs, attemptKind: a.kind,
        };
      }),
    });
    // One structured line per model call for log aggregation: identifiers, sizes and timings only, never content.
    for (const a of attempts) this.logger.log(JSON.stringify({ event: 'ai_call', businessId, provider: this.provider.name, model: a.model, kind: a.kind, success: a.success, ms: a.latencyMs, tokensIn: a.inputTokens, tokensOut: a.outputTokens, errorKind: a.success ? undefined : errorKind(a.error ?? 'validation') }));
    if (attempts.every((a) => !a.success)) await this.alertIfDown(businessId);
  }

  /** When the last three model calls of a business all failed, tell the people who can act (once per hour). */
  private async alertIfDown(businessId: string) {
    const last = await this.prisma.aIUsage.findMany({ where: { businessId, agent: 'CUSTOMER_SUPPORT' }, orderBy: { createdAt: 'desc' }, take: 3, select: { success: true } });
    if (last.length === 3 && last.every((l) => !l.success)) {
      await this.notifications.notify({ businessId, permission: 'business.update', type: 'sales.ai_degraded', title: 'The AI agent is failing to answer', body: 'Customers are being handed to your team. Check the monitoring page.', data: {}, dedupeKey: `sales:ai-down:${businessId}:${Math.floor(Date.now() / 3_600_000)}` });
    }
  }

  // ─── Handoff and bookkeeping ──────────────────────────────────────────────

  /** Stops the AI for this conversation, tells the customer with a FIXED message, and tells the team. */
  async handoff(conv: Conversation, reason: HandoffReason, language: AgentLanguage, text: string, intent: string | null, error?: string, extra: Record<string, unknown> = {}): Promise<string> {
    const msg = await this.prisma.message.create({
      data: { businessId: conv.businessId, conversationId: conv.id, direction: 'OUTBOUND', authorType: 'SYSTEM', body: text, language, intent: intent ?? undefined, sentAt: new Date(), escalationReason: ESCALATION_ENUM[reason] ?? 'OTHER', aiMetadata: { kind: 'handoff', reason, error, ...extra } as unknown as Prisma.InputJsonValue },
    });
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { status: 'PENDING_HUMAN', aiMode: 'AI_PAUSED', escalated: true, escalationReason: ESCALATION_ENUM[reason] ?? 'OTHER', handoffReason: reason, handoffRequestedAt: new Date(), lastMessageAt: new Date(), intent: intent ?? undefined },
    });
    await this.audit.record({ action: 'sales.handoff', actorId: null, businessId: conv.businessId, entityType: 'Conversation', entityId: conv.id, metadata: { reason, intent } });
    await this.notifyHumanWaiting(conv, 'handoff', reason);
    // Phase N5: the handoff record with its factual summary. Best effort: it must never break the conversation.
    await this.assist.openHandoff(conv, reason, reason === 'CUSTOMER_REQUESTED' ? 'CUSTOMER' : 'AI').catch((e) => this.logger.warn(`handoff record failed: ${(e as Error).name}`));
    return msg.id;
  }

  async systemMessage(conv: Conversation, text: string, kind: string): Promise<string> {
    const msg = await this.prisma.message.create({ data: { businessId: conv.businessId, conversationId: conv.id, direction: 'OUTBOUND', authorType: 'SYSTEM', body: text, sentAt: new Date(), aiMetadata: { kind } as unknown as Prisma.InputJsonValue } });
    return msg.id;
  }

  private async notifyHumanWaiting(conv: Conversation, why: 'handoff' | 'draft_ready' | 'customer_message', reason?: string) {
    if (conv.isTest) return;
    const titles = { handoff: 'A customer needs a person', draft_ready: 'An AI reply is waiting for your review', customer_message: 'New customer message' } as const;
    await this.notifications.notify({
      businessId: conv.businessId, permission: 'inbox.reply', type: `sales.${why}`, title: titles[why], data: { conversationId: conv.id, reason: reason ?? null },
      dedupeKey: `sales:${why}:${conv.id}:${why === 'handoff' ? (reason ?? '') : Math.floor(Date.now() / 600_000)}`,
    });
  }

  /** Customer record, intent and lead status after a turn. */
  private async afterTurn(conv: Conversation & { customer?: Customer | null }, s: { customerMessages: number; intent: string | null; purchaseIntent: PurchaseIntentId; interests: string[] }) {
    const purchase = maxIntent(conv.purchaseIntent as PurchaseIntentId, s.purchaseIntent);
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { purchaseIntent: purchase as PurchaseIntent, intent: s.intent ?? undefined } });
    if (!conv.customerId || conv.isTest) return;
    const c = await this.prisma.customer.findUniqueOrThrow({ where: { id: conv.customerId } });
    const interests = [...new Set([...c.interests, ...s.interests])].slice(0, 30);
    const status = nextLeadStatus(c.leadStatus, { customerMessages: s.customerMessages, purchaseIntent: maxIntent(c.purchaseIntent as PurchaseIntentId, purchase), hasContact: Boolean(c.email || c.phone), productInterest: interests.length > 0 });
    await this.prisma.customer.update({ where: { id: c.id }, data: { lastIntent: s.intent ?? c.lastIntent, purchaseIntent: maxIntent(c.purchaseIntent as PurchaseIntentId, purchase) as PurchaseIntent, interests, leadStatus: status } });
    // Phase N5: explainable qualification from what the customer volunteered. Best effort, off unless SALES_ASSIST_ENABLED.
    await this.assist.evaluate(conv.id).catch((e) => this.logger.warn(`qualification failed: ${(e as Error).name}`));
  }
}
