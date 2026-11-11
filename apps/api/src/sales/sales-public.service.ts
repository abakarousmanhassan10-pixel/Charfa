import { createHash, randomBytes } from 'crypto';
import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Conversation, Message } from '@touma/database';
import { agentMessage, resolveReplyLanguage, AGENT_LANGUAGES, type AgentLanguage } from '@touma/shared';
import { SalesCaptchaService } from './sales-captcha.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicMessageDto } from './sales.dto';
import { SalesAgentService } from './sales-agent.service';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

type Card = { name?: string; price?: string | null; discountPrice?: string | null; currency?: string | null; availability?: string | null; url?: string | null; type?: string };

/**
 * The customer-facing chat (no account). A visitor reaches ONE business by its public slug and ONE conversation by a secret token
 * that only their browser holds (only its SHA-256 is stored). Nothing internal is ever returned: no notes, no AI metadata beyond
 * product cards built from the verified catalog, no drafts that were not approved.
 */
@Injectable()
export class SalesPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: SalesAgentService,
    private readonly captcha: SalesCaptchaService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  private async business(slug: string) {
    const b = await this.prisma.business.findFirst({ where: { slug, deletedAt: null }, select: { id: true, name: true, defaultLocale: true } });
    const cfg = b ? await this.agent.config(b.id) : null;
    // Same answer for "no such shop" and "agent off": nothing is revealed about the business.
    if (!b || !cfg?.enabled) throw new NotFoundException({ code: 'CHAT_UNAVAILABLE', message: 'This chat is not available' });
    return { b, cfg };
  }

  async info(slug: string) {
    const { b, cfg } = await this.business(slug);
    const def = cfg.defaultLanguage as AgentLanguage;
    return {
      businessName: b.name, agentName: cfg.name, languages: cfg.languages, defaultLanguage: def,
      greeting: cfg.greeting ?? agentMessage('greeting', def, { business: b.name }),
      disclosure: Object.fromEntries((AGENT_LANGUAGES as readonly AgentLanguage[]).filter((l) => cfg.languages.includes(l)).map((l) => [l, agentMessage('disclosure', l)])),
      replyMode: cfg.replyMode,
      // What is stored, for how long, and where the merchant's own privacy policy is (the customer sees this before writing).
      privacy: { retentionDays: cfg.retentionDays, url: cfg.privacyNoticeUrl, notice: Object.fromEntries((AGENT_LANGUAGES as readonly AgentLanguage[]).filter((l) => cfg.languages.includes(l)).map((l) => [l, agentMessage('privacy', l, { days: String(cfg.retentionDays) })])) },
      captcha: this.captcha.publicConfig(),
    };
  }

  private async conversationByToken(businessId: string, token: string): Promise<Conversation> {
    const c = await this.prisma.conversation.findFirst({ where: { publicTokenHash: hash(token), businessId, isTest: false } });
    if (!c) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    return c;
  }

  private dto(m: Message) {
    const meta = (m.aiMetadata ?? {}) as { cards?: Card[] };
    const role = m.authorType === 'CUSTOMER' ? 'customer' : m.authorType === 'HUMAN_AGENT' ? 'team' : m.authorType === 'SYSTEM' ? 'system' : 'assistant';
    return {
      id: m.id, role, text: m.body, at: (m.sentAt ?? m.createdAt).toISOString(),
      cards: role === 'assistant' ? (meta.cards ?? []).map((c) => ({ type: c.type, name: c.name, price: c.price ?? null, discountPrice: c.discountPrice ?? null, currency: c.currency ?? null, availability: c.availability ?? null, url: c.url ?? null })) : [],
    };
  }

  private async visible(conversationId: string) {
    const rows = await this.prisma.message.findMany({ where: { conversationId, sentAt: { not: null } }, orderBy: { createdAt: 'asc' }, take: 300 });
    return rows.map((m) => this.dto(m));
  }

  private state(c: Conversation) {
    return { aiMode: c.aiMode === 'AI_ACTIVE' ? 'AI' : c.aiMode === 'HUMAN' ? 'TEAM' : 'WAITING_FOR_TEAM', status: c.status };
  }

  async send(slug: string, dto: PublicMessageDto, ip?: string) {
    const { b, cfg } = await this.business(slug);
    // Honeypot: a real visitor never sees this field. The bot gets a normal-looking answer and nothing is stored or sent to the model.
    if (dto.website) return { token: null, messages: [], aiMode: 'AI' as const, status: 'OPEN' as const, outcome: 'SKIPPED' as const };
    let conv: Conversation;
    let token: string | null = null;
    const contact = dto.consent === true ? { email: dto.email ?? null, phone: dto.phone ?? null } : { email: null, phone: null };
    if (dto.token) {
      conv = await this.conversationByToken(b.id, dto.token);
      const n = await this.prisma.message.count({ where: { conversationId: conv.id, authorType: 'CUSTOMER' } });
      if (n >= this.env.SALES_MAX_CUSTOMER_MESSAGES_PER_CONVERSATION) throw new HttpException({ code: 'CONVERSATION_LIMIT', message: 'This conversation reached its message limit. Please contact the business directly.' }, HttpStatus.TOO_MANY_REQUESTS);
      // Burst control inside one conversation: a person does not send ten messages a minute.
      const burst = await this.prisma.message.count({ where: { conversationId: conv.id, authorType: 'CUSTOMER', createdAt: { gte: new Date(Date.now() - 60_000) } } });
      if (burst >= 10) throw new HttpException({ code: 'TOO_FAST', message: 'You are sending messages too quickly. Please wait a moment.' }, HttpStatus.TOO_MANY_REQUESTS);
      if (conv.customerId && (contact.email || contact.phone || dto.name)) await this.updateCustomer(conv.customerId, dto, contact);
    } else {
      if (!(await this.captcha.verify(dto.captchaToken, ip))) throw new HttpException({ code: 'CAPTCHA_REQUIRED', message: 'Please complete the verification and try again.' }, HttpStatus.FORBIDDEN);
      // Flood control: a business only receives so many new conversations per hour, whatever the senders' addresses.
      const recent = await this.prisma.conversation.count({ where: { businessId: b.id, channel: 'WEB_CHAT', isTest: false, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
      if (recent >= this.env.SALES_NEW_CONVERSATIONS_PER_HOUR) throw new HttpException({ code: 'CHAT_BUSY', message: 'The chat is very busy right now. Please try again in a few minutes or contact the business directly.' }, HttpStatus.TOO_MANY_REQUESTS);
      token = randomBytes(32).toString('base64url');
      const lang = resolveReplyLanguage(null, cfg.languages, cfg.defaultLanguage as AgentLanguage).language;
      const customer = await this.prisma.customer.create({ data: { businessId: b.id, name: dto.name ?? null, email: contact.email, phone: contact.phone, language: lang, source: 'WEB_CHAT', consentAt: dto.consent === true && (contact.email || contact.phone) ? new Date() : null } });
      conv = await this.prisma.conversation.create({ data: { businessId: b.id, channel: 'WEB_CHAT', customerId: customer.id, customerName: dto.name ?? null, publicTokenHash: hash(token), language: lang } });
    }
    const turn = await this.agent.handleCustomerMessage({ businessId: b.id, conversationId: conv.id, text: dto.message });
    const fresh = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    return { token, messages: await this.visible(conv.id), ...this.state(fresh), outcome: turn.outcome };
  }

  private async updateCustomer(customerId: string, dto: PublicMessageDto, contact: { email: string | null; phone: string | null }) {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!c || c.anonymizedAt) return;
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { ...(dto.name ? { name: dto.name } : {}), ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { phone: contact.phone } : {}), ...((contact.email || contact.phone) && !c.consentAt ? { consentAt: new Date() } : {}) },
    });
  }

  async poll(slug: string, token: string) {
    const { b } = await this.business(slug);
    const conv = await this.conversationByToken(b.id, token);
    return { messages: await this.visible(conv.id), ...this.state(conv) };
  }

  /** The customer asks for their data to be deleted. */
  async erase(slug: string, token: string) {
    const { b } = await this.business(slug);
    const conv = await this.conversationByToken(b.id, token);
    if (!conv.customerId) throw new ConflictException({ code: 'NOTHING_TO_ERASE', message: 'Nothing to erase' });
    const id = conv.customerId;
    await this.prisma.$transaction([
      this.prisma.customer.update({ where: { id }, data: { name: null, email: null, phone: null, interests: [], consentAt: null, anonymizedAt: new Date() } }),
      this.prisma.customerNote.deleteMany({ where: { customerId: id } }),
      this.prisma.message.updateMany({ where: { businessId: b.id, authorType: 'CUSTOMER', conversation: { customerId: id } }, data: { body: '[erased]' } }),
      this.prisma.conversation.updateMany({ where: { customerId: id }, data: { customerName: null, publicTokenHash: null } }),
    ]);
    return { erased: true };
  }
}
