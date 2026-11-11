import { Injectable } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { FaqDraftDto } from './sales.dto';

const norm = (t: string) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Analytics, leads, opportunities, follow-up recommendations and FAQ gaps. All figures are counted from stored conversations: nothing is estimated. */
@Injectable()
export class SalesInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async analytics(tenant: TenantContext, days: number) {
    const b = tenant.businessId;
    const since = new Date(Date.now() - days * 86_400_000);
    const base = { businessId: b, isTest: false, createdAt: { gte: since } };
    const [total, byStatus, byMode, byLang, byIntent, handoffs, aiMsgs, customers, leads, avg, series] = await Promise.all([
      this.prisma.conversation.count({ where: base }),
      this.prisma.conversation.groupBy({ by: ['status'], where: base, _count: true }),
      this.prisma.conversation.groupBy({ by: ['aiMode'], where: base, _count: true }),
      this.prisma.conversation.groupBy({ by: ['language'], where: base, _count: true }),
      this.prisma.conversation.groupBy({ by: ['intent'], where: base, _count: true }),
      this.prisma.conversation.groupBy({ by: ['handoffReason'], where: { ...base, escalated: true }, _count: true }),
      this.prisma.message.groupBy({ by: ['authorType', 'approvalStatus'], where: { businessId: b, conversation: { isTest: false }, createdAt: { gte: since }, authorType: { in: ['AI_REPLY', 'AI_SUGGESTION', 'HUMAN_AGENT'] } }, _count: true }),
      this.prisma.customer.count({ where: { businessId: b, createdAt: { gte: since } } }),
      this.prisma.customer.groupBy({ by: ['leadStatus'], where: { businessId: b }, _count: true }),
      this.prisma.message.count({ where: { businessId: b, authorType: 'CUSTOMER', conversation: { isTest: false }, createdAt: { gte: since } } }),
      this.prisma.$queryRaw<Array<{ day: Date; n: bigint }>>(Prisma.sql`SELECT date_trunc('day', "createdAt") AS day, count(*)::bigint AS n FROM "Conversation" WHERE "businessId" = ${b} AND "isTest" = false AND "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`),
    ]);
    const count = (rows: Array<{ _count: number }>) => rows.reduce((s, r) => s + r._count, 0);
    const handedOff = count(handoffs);
    const aiSent = aiMsgs.filter((m) => m.authorType === 'AI_REPLY').reduce((s, m) => s + m._count, 0);
    const drafts = aiMsgs.filter((m) => m.authorType === 'AI_SUGGESTION');
    const toMap = <K extends string>(rows: Array<Record<string, unknown> & { _count: number }>, key: K) => Object.fromEntries(rows.map((r) => [String(r[key] ?? 'UNKNOWN'), r._count]));
    return {
      days, since: since.toISOString(), conversations: total, newCustomers: customers, customerMessages: avg, avgCustomerMessagesPerConversation: total ? Math.round((avg / total) * 10) / 10 : null,
      byStatus: toMap(byStatus, 'status'), byAiMode: toMap(byMode, 'aiMode'), byLanguage: toMap(byLang, 'language'), byIntent: toMap(byIntent, 'intent'),
      handoffs: { total: handedOff, rate: total ? Math.round((handedOff / total) * 1000) / 10 : null, byReason: toMap(handoffs, 'handoffReason') },
      aiReplies: { sentAutomatically: aiSent, drafts: drafts.reduce((s, m) => s + m._count, 0), draftsApproved: drafts.filter((m) => m.approvalStatus === 'APPROVED').reduce((s, m) => s + m._count, 0), draftsRejected: drafts.filter((m) => m.approvalStatus === 'REJECTED').reduce((s, m) => s + m._count, 0), humanReplies: aiMsgs.filter((m) => m.authorType === 'HUMAN_AGENT').reduce((s, m) => s + m._count, 0) },
      leads: toMap(leads, 'leadStatus'),
      daily: series.map((r) => ({ day: r.day.toISOString().slice(0, 10), conversations: Number(r.n) })),
      note: 'Counted from stored conversations of the period. Conversion to a sale is not measured: TOUMA has no order data.',
    };
  }

  /** Customers by lead stage, newest activity first. Opportunities are the ones a person should act on. */
  async leads(tenant: TenantContext) {
    const rows = await this.prisma.customer.findMany({ where: { businessId: tenant.businessId, anonymizedAt: null, leadStatus: { not: 'NEW' } }, orderBy: { lastSeenAt: 'desc' }, take: 300 });
    const groups: Record<string, unknown[]> = { ENGAGED: [], QUALIFIED: [], OPPORTUNITY: [], WON: [], LOST: [] };
    for (const c of rows) groups[c.leadStatus]?.push({ id: c.id, name: c.name, email: c.email, phone: c.phone, purchaseIntent: c.purchaseIntent, lastIntent: c.lastIntent, interests: c.interests, lastSeenAt: c.lastSeenAt.toISOString(), followUpAt: c.followUpAt?.toISOString() ?? null });
    return { groups };
  }

  async opportunities(tenant: TenantContext) {
    const rows = await this.prisma.customer.findMany({ where: { businessId: tenant.businessId, anonymizedAt: null, OR: [{ leadStatus: 'OPPORTUNITY' }, { leadStatus: 'QUALIFIED', purchaseIntent: { in: ['MEDIUM', 'HIGH'] } }], NOT: { leadStatus: { in: ['WON', 'LOST'] } } }, orderBy: [{ purchaseIntent: 'desc' }, { lastSeenAt: 'desc' }], take: 100 });
    const ids = [...new Set(rows.flatMap((c) => c.interests.filter((i) => i.startsWith('product:')).map((i) => i.slice(8))))];
    const products = ids.length ? await this.prisma.product.findMany({ where: { businessId: tenant.businessId, id: { in: ids }, deletedAt: null }, select: { id: true, name: true, price: true, currency: true, availability: true } }) : [];
    const byId = new Map(products.map((p) => [p.id, p]));
    return {
      items: rows.map((c) => ({
        customer: { id: c.id, name: c.name, email: c.email, phone: c.phone, leadStatus: c.leadStatus, purchaseIntent: c.purchaseIntent, lastSeenAt: c.lastSeenAt.toISOString(), followUpAt: c.followUpAt?.toISOString() ?? null },
        // Names, prices and availability come from the product record (not from the AI) and are shown as recorded now.
        products: c.interests.filter((i) => i.startsWith('product:')).map((i) => byId.get(i.slice(8))).filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => ({ id: p.id, name: p.name, price: p.price === null ? null : String(p.price), currency: p.currency, availability: p.availability })),
      })),
    };
  }

  /** Rule-based follow-up recommendations (no AI): what a person should do next, and why. */
  async followUps(tenant: TenantContext) {
    const b = tenant.businessId;
    const now = Date.now();
    const out: Array<{ type: string; priority: 'HIGH' | 'MEDIUM' | 'LOW'; conversationId?: string; customerId?: string; reason: string; since: string }> = [];
    const waiting = await this.prisma.conversation.findMany({ where: { businessId: b, isTest: false, status: 'PENDING_HUMAN' }, orderBy: { handoffRequestedAt: 'asc' }, take: 50, select: { id: true, customerId: true, handoffReason: true, handoffRequestedAt: true } });
    for (const c of waiting) out.push({ type: 'HANDOFF_WAITING', priority: now - (c.handoffRequestedAt?.getTime() ?? now) > 3_600_000 ? 'HIGH' : 'MEDIUM', conversationId: c.id, customerId: c.customerId ?? undefined, reason: `Waiting for a person (${c.handoffReason ?? 'handoff'})`, since: (c.handoffRequestedAt ?? new Date()).toISOString() });
    const drafts = await this.prisma.message.findMany({ where: { businessId: b, authorType: 'AI_SUGGESTION', approvalStatus: 'PENDING', conversation: { isTest: false } }, orderBy: { createdAt: 'asc' }, take: 50, select: { conversationId: true, createdAt: true } });
    for (const d of drafts) out.push({ type: 'DRAFT_TO_REVIEW', priority: now - d.createdAt.getTime() > 3_600_000 ? 'HIGH' : 'MEDIUM', conversationId: d.conversationId, reason: 'An AI reply is waiting for your approval', since: d.createdAt.toISOString() });
    const hot = await this.prisma.customer.findMany({ where: { businessId: b, anonymizedAt: null, leadStatus: { in: ['QUALIFIED', 'OPPORTUNITY'] }, lastSeenAt: { lt: new Date(now - 24 * 3_600_000) } }, orderBy: { lastSeenAt: 'asc' }, take: 50 });
    for (const c of hot) out.push({ type: 'COLD_OPPORTUNITY', priority: c.leadStatus === 'OPPORTUNITY' ? 'HIGH' : 'MEDIUM', customerId: c.id, reason: `${c.leadStatus === 'OPPORTUNITY' ? 'High purchase intent' : 'Qualified lead'} with no activity for over 24 hours${c.email || c.phone ? '' : ' and no contact details'}`, since: c.lastSeenAt.toISOString() });
    const due = await this.prisma.customer.findMany({ where: { businessId: b, anonymizedAt: null, followUpAt: { lte: new Date(now) }, leadStatus: { notIn: ['WON', 'LOST'] } }, orderBy: { followUpAt: 'asc' }, take: 50 });
    for (const c of due) out.push({ type: 'FOLLOW_UP_DUE', priority: 'HIGH', customerId: c.id, reason: 'The follow-up date you set has arrived', since: c.followUpAt!.toISOString() });
    const open = await this.prisma.agentFeedback.count({ where: { businessId: b, status: 'OPEN' } });
    if (open) out.push({ type: 'CORRECTIONS_OPEN', priority: 'LOW', reason: `${open} reported inaccuracy${open > 1 ? ' reports are' : ' report is'} not resolved yet`, since: new Date(now).toISOString() });
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return { items: out.sort((a, b2) => order[a.priority] - order[b2.priority]) };
  }

  /** Verified FAQ entries, and the questions customers asked that the agent could not answer (the gaps to fill). */
  async faq(tenant: TenantContext) {
    const b = tenant.businessId;
    const [verified, unverified, gaps, top] = await Promise.all([
      this.prisma.knowledgeEntry.findMany({ where: { businessId: b, deletedAt: null, category: 'FAQ', verified: true }, orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, title: true, body: true, verifiedAt: true } }),
      this.prisma.knowledgeEntry.findMany({ where: { businessId: b, deletedAt: null, category: 'FAQ', verified: false }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, title: true, body: true } }),
      this.prisma.conversation.findMany({ where: { businessId: b, isTest: false, handoffReason: { in: ['UNVERIFIED_INFO', 'LOW_CONFIDENCE'] } }, orderBy: { handoffRequestedAt: 'desc' }, take: 200, select: { id: true, messages: { where: { authorType: 'CUSTOMER' }, orderBy: { createdAt: 'desc' }, take: 1, select: { body: true } } } }),
      this.prisma.message.groupBy({ by: ['intent'], where: { businessId: b, authorType: 'CUSTOMER', intent: { not: null }, conversation: { isTest: false } }, _count: true }),
    ]);
    const groups = new Map<string, { question: string; count: number; conversationIds: string[] }>();
    for (const g of gaps) {
      const q = g.messages[0]?.body;
      if (!q || q === '[erased]') continue;
      const k = norm(q);
      const e = groups.get(k) ?? { question: q, count: 0, conversationIds: [] };
      e.count++;
      e.conversationIds.push(g.id);
      groups.set(k, e);
    }
    return { verified, unverified, unanswered: [...groups.values()].sort((a, b2) => b2.count - a.count).slice(0, 30), topIntents: top.map((t) => ({ intent: t.intent, count: t._count })).sort((a, b2) => b2.count - a.count) };
  }

  /** Writes the answer as an UNVERIFIED knowledge entry: the agent uses it only after a person with the right permission verifies it. */
  async createFaqDraft(tenant: TenantContext, dto: FaqDraftDto) {
    const e = await this.prisma.knowledgeEntry.create({ data: { businessId: tenant.businessId, source: 'FAQ', category: 'FAQ', title: dto.question, body: dto.answer, createdById: tenant.userId } });
    await this.audit.record({ action: 'sales.faq_draft_created', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'KnowledgeEntry', entityId: e.id, metadata: {} });
    return { id: e.id, verified: false };
  }
}
