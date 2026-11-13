import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, type LeadQualification, type SalesFollowUp, type SalesHandoff } from '@touma/database';
import { AuditService } from '../audit/audit.service';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { RUN_ADAPTER_REGISTRY, RunStepError, type RunAdapterRegistry } from '../runs/run-adapters';
import type { TenantContext } from '../tenancy/tenant-context';
import { buildHandoffSummary, followUpText, qualify, type Qualification } from './sales-assist-calc';

type Actor = { businessId: string; userId: string | null };
const DAY = 86_400_000;
const OPEN = ['REQUESTED', 'ACCEPTED'] as const;
const LANGS = ['fr', 'en', 'ar', 'tr'];
const notFound = (what: string) => new NotFoundException({ code: `${what.toUpperCase()}_NOT_FOUND`, message: `${what} not found` });

export function qualificationView(q: LeadQualification | null) {
  return q ? { score: q.score, level: q.level, modelVersion: q.modelVersion, evaluatedMessages: q.evaluatedMessages, signals: q.signals, reasons: q.reasons, computedAt: q.computedAt } : null;
}
export const handoffView = (h: SalesHandoff) => ({ id: h.id, conversationId: h.conversationId, status: h.status, reason: h.reason, requestedBy: h.requestedBy, summary: h.summary, requestedAt: h.requestedAt, acceptedById: h.acceptedById, acceptedAt: h.acceptedAt, resolvedById: h.resolvedById, resolvedAt: h.resolvedAt, resolutionNote: h.resolutionNote });
export const followUpView = (f: SalesFollowUp) => ({ id: f.id, conversationId: f.conversationId, status: f.status, language: f.language, suggestedText: f.suggestedText, basis: f.basis, blockedReason: f.blockedReason, source: f.source, decidedById: f.decidedById, decidedAt: f.decidedAt, createdAt: f.createdAt, sent: false });

/**
 * Sales assistant 2.0 (Phase N5), built on the existing agent: explainable lead qualification, handoff records with a factual
 * summary, follow-up drafts that need the customer's consent and a person's authorization, privacy scrubbing and analytics.
 * TOUMA has no outbound channel: an approved follow-up is an authorization record, nothing is ever sent from here.
 * Every query is scoped by business; customer text is only pattern-matched (see sales-assist-calc.ts).
 */
@Injectable()
export class SalesAssistService implements OnModuleInit {
  private readonly logger = new Logger('SalesAssist');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(RUN_ADAPTER_REGISTRY) private readonly registry: RunAdapterRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get enabled() {
    return this.env.SALES_ASSIST_ENABLED;
  }

  /** The follow-up preparation step for the workflow engine: it prepares a draft, it never sends. Registered in the API and in the worker. */
  onModuleInit() {
    if (!this.enabled || !this.registry.register) return;
    this.registry.register({
      name: 'sales.followup-suggest',
      external: false,
      execute: async (ctx) => {
        try {
          const f = await this.suggestFollowUp({ businessId: ctx.businessId, userId: null }, String(ctx.input.conversation_id ?? ctx.input.conversationId ?? ''), 'WORKFLOW');
          return { followUpId: f.id, status: f.status, sent: false };
        } catch (e) {
          const code = (e as { response?: { code?: string } }).response?.code ?? 'FOLLOWUP_FAILED';
          throw new RunStepError(code, 'The follow-up draft could not be prepared', false);
        }
      },
    });
  }

  // ─── Qualification ─────────────────────────────────────────────────────────────

  /** Re-evaluates a conversation from what the customer wrote and stores the explained result. Never throws into the chat flow: callers catch. */
  async evaluate(conversationId: string): Promise<Qualification | null> {
    if (!this.enabled) return null;
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: { customer: true } });
    if (!conv || conv.isTest) return null;
    const rows = await this.prisma.message.findMany({ where: { conversationId, authorType: 'CUSTOMER', NOT: { body: '[erased]' } }, orderBy: { createdAt: 'asc' }, take: 50, select: { id: true, body: true } });
    const c = conv.customer;
    const hasContact = Boolean(c && !c.anonymizedAt && (c.email || c.phone) && c.consentAt);
    const q = qualify(rows.map((r) => ({ id: r.id, text: r.body })), c?.interests ?? [], hasContact);
    const data = { businessId: conv.businessId, customerId: conv.customerId, score: q.score, level: q.level, signals: q.signals as unknown as Prisma.InputJsonObject, reasons: q.reasons as unknown as Prisma.InputJsonArray, modelVersion: q.modelVersion, evaluatedMessages: q.evaluatedMessages, computedAt: new Date() };
    await this.prisma.leadQualification.upsert({ where: { conversationId }, create: { conversationId, ...data }, update: data });
    return q;
  }

  private async conversation(actor: Pick<Actor, 'businessId'>, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, businessId: actor.businessId }, include: { customer: true } });
    if (!c) throw notFound('Conversation');
    return c;
  }

  // ─── Handoff records ───────────────────────────────────────────────────────────

  /** Opens the handoff record of a conversation (idempotent: at most one open record). The summary is compiled from stored facts. */
  async openHandoff(conv: { id: string; businessId: string; customerId: string | null; language: string | null; intent: string | null; purchaseIntent: string | null; aiRepliesCount: number; isTest?: boolean }, reason: string, requestedBy: 'AI' | 'CUSTOMER' | 'STAFF'): Promise<SalesHandoff | null> {
    if (!this.enabled || conv.isTest) return null;
    const open = await this.prisma.salesHandoff.findFirst({ where: { conversationId: conv.id, status: { in: [...OPEN] } } });
    if (open) return open;
    const q = await this.evaluate(conv.id).catch(() => null);
    const customer = conv.customerId ? await this.prisma.customer.findUnique({ where: { id: conv.customerId }, select: { interests: true } }) : null;
    const productIds = (customer?.interests ?? []).filter((x) => x.startsWith('product:')).map((x) => x.slice(8));
    const products = productIds.length ? await this.prisma.product.findMany({ where: { id: { in: productIds }, businessId: conv.businessId }, select: { id: true, name: true } }) : [];
    const messages = await this.prisma.message.findMany({ where: { conversationId: conv.id, authorType: 'CUSTOMER', NOT: { body: '[erased]' } }, orderBy: { createdAt: 'asc' }, take: 50, select: { body: true, createdAt: true } });
    const summary = buildHandoffSummary({ language: conv.language, reason, customerMessages: messages.map((m) => ({ at: m.createdAt, text: m.body })), aiReplies: conv.aiRepliesCount, intent: conv.intent, purchaseIntent: conv.purchaseIntent, products, qualification: q });
    const h = await this.prisma.salesHandoff.create({ data: { businessId: conv.businessId, conversationId: conv.id, customerId: conv.customerId, reason, requestedBy, summary: summary as unknown as Prisma.InputJsonObject } });
    await this.audit.record({ action: 'sales.handoff_recorded', actorId: null, businessId: conv.businessId, entityType: 'SalesHandoff', entityId: h.id, metadata: { reason, requestedBy } });
    return h;
  }

  async staffRequestHandoff(tenant: TenantContext, conversationId: string) {
    const c = await this.conversation(tenant, conversationId);
    if (c.isTest) throw new BadRequestException({ code: 'TEST_CONVERSATION', message: 'Test conversations have no handoff' });
    const h = await this.openHandoff(c, 'STAFF_REQUEST', 'STAFF');
    if (!h) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    return handoffView(h);
  }

  async listHandoffs(tenant: TenantContext, q: PageQueryDto & { status?: SalesHandoff['status'] }) {
    const where: Prisma.SalesHandoffWhereInput = { businessId: tenant.businessId, ...(q.status ? { status: q.status } : {}) };
    const [items, total] = await this.prisma.$transaction([this.prisma.salesHandoff.findMany({ where, orderBy: { requestedAt: 'desc' }, ...pageArgs(q) }), this.prisma.salesHandoff.count({ where })]);
    return toPage(items.map(handoffView), total, q);
  }

  async acceptHandoff(tenant: TenantContext, id: string) {
    const h = await this.prisma.salesHandoff.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!h) throw notFound('Handoff');
    const res = await this.prisma.salesHandoff.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'ACCEPTED', acceptedById: tenant.userId, acceptedAt: new Date() } });
    if (!res.count) throw new ConflictException({ code: 'NOT_REQUESTED', message: 'This handoff was already accepted or finished' });
    await this.audit.record({ action: 'sales.handoff_accepted', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SalesHandoff', entityId: id });
    return handoffView(await this.prisma.salesHandoff.findUniqueOrThrow({ where: { id } }));
  }

  async resolveHandoff(tenant: TenantContext, id: string, note?: string) {
    const h = await this.prisma.salesHandoff.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!h) throw notFound('Handoff');
    const res = await this.prisma.salesHandoff.updateMany({ where: { id, status: { in: [...OPEN] } }, data: { status: 'RESOLVED', resolvedById: tenant.userId, resolvedAt: new Date(), resolutionNote: note?.slice(0, 300) } });
    if (!res.count) throw new ConflictException({ code: 'NOT_OPEN', message: 'This handoff is already finished' });
    await this.audit.record({ action: 'sales.handoff_resolved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SalesHandoff', entityId: id });
    return handoffView(await this.prisma.salesHandoff.findUniqueOrThrow({ where: { id } }));
  }

  // ─── Consent and follow-up drafts ──────────────────────────────────────────────

  /** The customer's own choice (through their private chat link). Opting out blocks every pending or approved draft at once. */
  async setFollowUpConsent(businessId: string, customerId: string | null, granted: boolean) {
    if (!customerId) throw new ConflictException({ code: 'NO_CUSTOMER', message: 'Nothing to update' });
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, businessId } });
    if (!c || c.anonymizedAt) throw new ConflictException({ code: 'CUSTOMER_ERASED', message: 'This customer was erased' });
    const now = new Date();
    await this.prisma.customer.update({ where: { id: c.id }, data: granted ? { followUpConsentAt: now, optedOutAt: null } : { followUpConsentAt: null, optedOutAt: now } });
    if (!granted) await this.prisma.salesFollowUp.updateMany({ where: { customerId: c.id, businessId, status: { in: ['SUGGESTED', 'APPROVED'] } }, data: { status: 'BLOCKED', blockedReason: 'OPTED_OUT', suggestedText: '' } });
    await this.audit.record({ action: granted ? 'sales.followup_consent_given' : 'sales.followup_opted_out', actorId: null, businessId, entityType: 'Customer', entityId: c.id });
    return { followUpConsent: granted };
  }

  async suggestFollowUp(actor: Actor, conversationId: string, source: 'STAFF' | 'WORKFLOW') {
    if (!this.enabled) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' });
    const conv = await this.conversation(actor, conversationId);
    const c = conv.customer;
    if (conv.isTest || !c) throw new BadRequestException({ code: 'NO_CUSTOMER', message: 'This conversation has no customer to follow up' });
    if (c.anonymizedAt) throw new ConflictException({ code: 'CUSTOMER_ERASED', message: 'This customer was erased' });
    const pending = await this.prisma.salesFollowUp.findFirst({ where: { conversationId, businessId: actor.businessId, status: 'SUGGESTED' } });
    if (pending) return pending;
    const q = await this.evaluate(conversationId);
    if (!q || (q.level !== 'WARM' && q.level !== 'HOT')) throw new ConflictException({ code: 'NOT_QUALIFIED', message: 'Follow-ups are only prepared for warm or hot leads' });
    if ((await this.prisma.salesFollowUp.count({ where: { businessId: actor.businessId, createdAt: { gte: new Date(Date.now() - DAY) } } })) >= this.env.SALES_ASSIST_MAX_FOLLOWUPS_PER_DAY) {
      throw new HttpException({ code: 'FOLLOWUP_LIMIT', message: `At most ${this.env.SALES_ASSIST_MAX_FOLLOWUPS_PER_DAY} follow-up drafts per 24 hours` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const blockedReason = c.optedOutAt ? 'OPTED_OUT' : !c.followUpConsentAt ? 'NO_CONSENT' : null;
    const lang = LANGS.includes(conv.language ?? c.language ?? '') ? (conv.language ?? c.language)! : 'en';
    // No text is prepared for a customer who did not agree to be contacted.
    let suggestedText = '';
    if (!blockedReason) {
      const ids = (k: string) => c.interests.filter((x) => x.startsWith(`${k}:`)).map((x) => x.slice(k.length + 1));
      const [p, sv] = await Promise.all([
        this.prisma.product.findMany({ where: { id: { in: ids('product') }, businessId: actor.businessId, status: 'ACTIVE' }, select: { name: true } }),
        this.prisma.service.findMany({ where: { id: { in: ids('service') }, businessId: actor.businessId, status: 'ACTIVE' }, select: { name: true } }),
      ]);
      suggestedText = followUpText(lang, c.name, [...p, ...sv].map((x) => x.name));
    }
    const f = await this.prisma.salesFollowUp.create({
      data: { businessId: actor.businessId, conversationId, customerId: c.id, status: blockedReason ? 'BLOCKED' : 'SUGGESTED', language: lang, suggestedText, blockedReason, source, createdById: actor.userId, basis: { level: q.level, score: q.score, rules: q.reasons.map((r) => r.rule) } },
    });
    await this.audit.record({ action: 'sales.followup_suggested', actorId: actor.userId, businessId: actor.businessId, entityType: 'SalesFollowUp', entityId: f.id, metadata: { status: f.status, source, blockedReason } });
    return f;
  }

  async listFollowUps(tenant: TenantContext, q: PageQueryDto & { status?: SalesFollowUp['status'] }) {
    const where: Prisma.SalesFollowUpWhereInput = { businessId: tenant.businessId, ...(q.status ? { status: q.status } : {}) };
    const [items, total] = await this.prisma.$transaction([this.prisma.salesFollowUp.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }), this.prisma.salesFollowUp.count({ where })]);
    return toPage(items.map(followUpView), total, q);
  }

  /** A person authorizes the draft. Consent is checked again now: if the customer opted out or was erased since, it is blocked instead. TOUMA sends nothing. */
  async approveFollowUp(tenant: TenantContext, id: string) {
    const f = await this.prisma.salesFollowUp.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!f) throw notFound('Follow-up');
    if (f.status !== 'SUGGESTED') throw new ConflictException({ code: 'NOT_SUGGESTED', message: 'Only a suggested follow-up can be approved' });
    const c = await this.prisma.customer.findFirst({ where: { id: f.customerId, businessId: tenant.businessId } });
    if (!c || c.anonymizedAt || c.optedOutAt || !c.followUpConsentAt) {
      await this.prisma.salesFollowUp.updateMany({ where: { id, status: 'SUGGESTED' }, data: { status: 'BLOCKED', blockedReason: !c || c.anonymizedAt ? 'CUSTOMER_ERASED' : c.optedOutAt ? 'OPTED_OUT' : 'NO_CONSENT', suggestedText: '' } });
      throw new ConflictException({ code: 'CONSENT_WITHDRAWN', message: 'The customer no longer agrees to be contacted' });
    }
    const res = await this.prisma.salesFollowUp.updateMany({ where: { id, status: 'SUGGESTED' }, data: { status: 'APPROVED', decidedById: tenant.userId, decidedAt: new Date() } });
    if (!res.count) throw new ConflictException({ code: 'NOT_SUGGESTED', message: 'Only a suggested follow-up can be approved' });
    await this.audit.record({ action: 'sales.followup_approved', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SalesFollowUp', entityId: id });
    return followUpView(await this.prisma.salesFollowUp.findUniqueOrThrow({ where: { id } }));
  }

  async rejectFollowUp(tenant: TenantContext, id: string) {
    const f = await this.prisma.salesFollowUp.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!f) throw notFound('Follow-up');
    const res = await this.prisma.salesFollowUp.updateMany({ where: { id, status: 'SUGGESTED' }, data: { status: 'REJECTED', decidedById: tenant.userId, decidedAt: new Date() } });
    if (!res.count) throw new ConflictException({ code: 'NOT_SUGGESTED', message: 'Only a suggested follow-up can be rejected' });
    await this.audit.record({ action: 'sales.followup_rejected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SalesFollowUp', entityId: id });
    return followUpView(await this.prisma.salesFollowUp.findUniqueOrThrow({ where: { id } }));
  }

  // ─── Views, privacy, analytics ─────────────────────────────────────────────────

  /** Everything the dashboard shows next to a conversation, in one call. */
  async assistView(tenant: TenantContext, conversationId: string) {
    const conv = await this.conversation(tenant, conversationId);
    const [q, handoffs, followUps] = await Promise.all([
      this.prisma.leadQualification.findUnique({ where: { conversationId } }),
      this.prisma.salesHandoff.findMany({ where: { conversationId, businessId: tenant.businessId }, orderBy: { requestedAt: 'desc' } }),
      this.prisma.salesFollowUp.findMany({ where: { conversationId, businessId: tenant.businessId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const c = conv.customer;
    return { qualification: qualificationView(q), handoffs: handoffs.map(handoffView), followUps: followUps.map(followUpView), consent: { followUp: Boolean(c?.followUpConsentAt && !c.optedOutAt), optedOut: Boolean(c?.optedOutAt), conversionVerified: Boolean(c?.conversionVerifiedAt) } };
  }

  /** What the customer's chat page may show: whether a person can be offered, and their follow-up choice. */
  async publicState(conversationId: string) {
    if (!this.enabled) return undefined;
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: { customer: true, qualification: true } });
    if (!conv) return undefined;
    const openHandoff = await this.prisma.salesHandoff.count({ where: { conversationId, status: { in: [...OPEN] } } });
    const warm = conv.qualification?.level === 'WARM' || conv.qualification?.level === 'HOT';
    return { handoffOffered: warm && openHandoff === 0 && conv.status !== 'PENDING_HUMAN', followUpConsent: Boolean(conv.customer?.followUpConsentAt && !conv.customer.optedOutAt) };
  }

  /** Operations to run inside the existing erase / retention transactions: the assistant's records go with the conversation. */
  scrubOps(conversation: Prisma.ConversationWhereInput) {
    return [
      this.prisma.salesFollowUp.deleteMany({ where: { conversation } }),
      this.prisma.leadQualification.deleteMany({ where: { conversation } }),
      this.prisma.salesHandoff.updateMany({ where: { conversation }, data: { summary: Prisma.DbNull } }),
    ];
  }

  /** Extra figures for the sales analytics. A conversion is counted only when a person marked the customer WON. */
  async analyticsExtras(tenant: TenantContext, since: Date) {
    const b = tenant.businessId;
    const [levels, handoffs, followUps, verified, accepted, usage] = await Promise.all([
      this.prisma.leadQualification.groupBy({ by: ['level'], where: { businessId: b, computedAt: { gte: since } }, _count: true }),
      this.prisma.salesHandoff.groupBy({ by: ['status'], where: { businessId: b, requestedAt: { gte: since } }, _count: true }),
      this.prisma.salesFollowUp.groupBy({ by: ['status'], where: { businessId: b, createdAt: { gte: since } }, _count: true }),
      this.prisma.customer.count({ where: { businessId: b, leadStatus: 'WON', conversionVerifiedAt: { gte: since } } }),
      this.prisma.salesHandoff.findMany({ where: { businessId: b, acceptedAt: { not: null }, requestedAt: { gte: since } }, select: { requestedAt: true, acceptedAt: true }, take: 1000 }),
      this.prisma.aIUsage.aggregate({ where: { businessId: b, agent: 'CUSTOMER_SUPPORT', createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true, costUsd: true }, _count: true }),
    ]);
    const map = (rows: Array<{ _count: number } & Record<string, unknown>>, k: string) => Object.fromEntries(rows.map((r) => [String(r[k]), r._count]));
    const waits = accepted.map((h) => (h.acceptedAt!.getTime() - h.requestedAt.getTime()) / 60_000).sort((a, c) => a - c);
    return {
      qualification: { byLevel: map(levels, 'level') },
      handoffRecords: { byStatus: map(handoffs, 'status'), medianMinutesToAccept: waits.length ? Math.round(waits[Math.floor((waits.length - 1) / 2)]! * 10) / 10 : null },
      followUps: { byStatus: map(followUps, 'status'), sent: 0 },
      verifiedConversions: verified,
      aiUsage: { calls: usage._count, inputTokens: usage._sum.inputTokens ?? 0, outputTokens: usage._sum.outputTokens ?? 0, costUsd: usage._count ? Number(usage._sum.costUsd ?? 0) : null },
      notes: ['A conversion is counted only when a person marked the customer as won: TOUMA has no order data and the AI never sets that status.', 'Follow-ups are drafts and authorizations: TOUMA has no outbound channel and sends nothing.'],
    };
  }
}
