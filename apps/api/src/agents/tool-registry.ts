import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { detectInjection } from '@touma/ai-engine';
import { AGENT_TOOLS, TOOL_PERMISSION, type AgentConfig, type AgentToolName } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationStore } from './conversation.store';

export class ToolDenied extends Error {
  constructor(readonly code: 'TOOL_NOT_ALLOWED' | 'TOOL_PERMISSION_MISSING' | 'TOOL_ARGS_INVALID' | 'TOOL_UNKNOWN', message: string) {
    super(message);
    this.name = 'ToolDenied';
  }
}

export interface ToolContext {
  businessId: string;
  userId: string | null;
  runId: string;
  agent: { id: string; config: AgentConfig };
  conversationId: string | null;
}

export interface ToolResult { data: unknown; /** Prompt-injection phrasings found in text that came from outside (merchant data); the data is still delimited and treated as data. */ injectionFlags: string[] }

const q = z.object({ query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(10).default(5) }).strict();
const lookup = z.object({ topic: z.string().trim().min(1).max(100) }).strict();
const none = z.object({}).strict();
const draft = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2200),
  hashtags: z.array(z.string().trim().regex(/^[\p{L}\p{N}_]{1,40}$/u)).max(10).default([]),
  callToAction: z.string().trim().max(200).optional(),
  platform: z.enum(['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN']),
}).strict();
const replyDraft = z.object({ reply: z.string().trim().min(1).max(1000), needsHuman: z.boolean() }).strict();

/** The exact version a reviewer sees: the approval is bound to this hash. */
export function contentHash(c: { title: string | null; body: string | null; hashtags: string[]; platform: string }): string {
  return createHash('sha256').update(JSON.stringify({ t: c.title ?? '', b: c.body ?? '', h: c.hashtags, p: c.platform })).digest('hex');
}

const clip = (v: unknown, max = 6000) => { const s = JSON.stringify(v); return s.length > max ? JSON.parse(`${JSON.stringify(s.slice(0, max))}`) : v; };

/**
 * Declared tools an agent may use. An agent can only call a tool that is in its own configuration AND covered by its permissions; arguments are
 * validated strictly; every tool works inside the caller's business only (the business comes from the verified context, never from an argument).
 * No tool publishes, sends or spends: `content.save_draft` creates a draft IN REVIEW, which waits for a human approval.
 */
@Injectable()
export class ToolRegistry {
  constructor(private readonly prisma: PrismaService, private readonly conversations: ConversationStore) {}

  declared() {
    return AGENT_TOOLS.map((name) => ({ name, permission: TOOL_PERMISSION[name], external: false }));
  }

  async execute(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
    if (!(AGENT_TOOLS as readonly string[]).includes(name)) throw new ToolDenied('TOOL_UNKNOWN', 'Unknown tool');
    const tool = name as AgentToolName;
    if (!ctx.agent.config.tools.includes(tool)) throw new ToolDenied('TOOL_NOT_ALLOWED', 'This agent is not allowed to use this tool');
    if (!ctx.agent.config.permissions.includes(TOOL_PERMISSION[tool])) throw new ToolDenied('TOOL_PERMISSION_MISSING', 'This agent lacks the permission this tool needs');
    const parse = <S extends z.ZodTypeAny>(schema: S): z.output<S> => {
      const r = schema.safeParse(args ?? {});
      if (!r.success) throw new ToolDenied('TOOL_ARGS_INVALID', 'Invalid tool arguments');
      return r.data;
    };
    let data: unknown;
    switch (tool) {
      case 'catalog.search': data = await this.searchCatalog(ctx.businessId, parse(q)); break;
      case 'knowledge.lookup': data = await this.lookupKnowledge(ctx.businessId, parse(lookup).topic); break;
      case 'usage.summary': parse(none); data = await this.usageSummary(ctx.businessId); break;
      case 'content.save_draft': data = await this.saveDraft(ctx, parse(draft)); break;
      case 'support.save_reply_draft': data = await this.saveReplyDraft(ctx, parse(replyDraft)); break;
    }
    const flags = collect(data).flatMap((s) => detectInjection(s));
    return { data: clip(data), injectionFlags: [...new Set(flags)] };
  }

  private async searchCatalog(businessId: string, a: z.output<typeof q>) {
    const like = { contains: a.query, mode: 'insensitive' as const };
    const [products, services] = await Promise.all([
      this.prisma.product.findMany({ where: { businessId, deletedAt: null, status: 'ACTIVE', OR: [{ name: like }, { description: like }] }, take: a.limit, select: { id: true, name: true, description: true, price: true, currency: true, features: true, benefits: true } }),
      this.prisma.service.findMany({ where: { businessId, deletedAt: null, status: 'ACTIVE', OR: [{ name: like }, { description: like }] }, take: a.limit, select: { id: true, name: true, description: true } }),
    ]);
    return [...products.map((p) => ({ type: 'PRODUCT', id: p.id, name: p.name, description: p.description?.slice(0, 300) ?? null, price: p.price?.toString() ?? null, currency: p.currency, features: p.features.slice(0, 5), benefits: p.benefits.slice(0, 5) })), ...services.map((s) => ({ type: 'SERVICE', id: s.id, name: s.name, description: s.description?.slice(0, 300) ?? null }))].slice(0, a.limit);
  }

  /** Only VERIFIED knowledge entries (the same rule the other agents follow). */
  private async lookupKnowledge(businessId: string, topic: string) {
    const rows = await this.prisma.knowledgeEntry.findMany({ where: { businessId, deletedAt: null, verified: true, OR: [{ title: { contains: topic, mode: 'insensitive' } }, { body: { contains: topic, mode: 'insensitive' } }] }, take: 5, select: { id: true, title: true, body: true } });
    return rows.map((r) => ({ id: r.id, title: r.title, body: r.body.slice(0, 500) }));
  }

  private async usageSummary(businessId: string) {
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const agg = await this.prisma.usageEvent.aggregate({ where: { businessId, createdAt: { gte: start } }, _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true }, _count: { _all: true } });
    return { calls: agg._count._all, tokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0), estimatedCostMicros: Number(agg._sum.estimatedCostMicros ?? 0n), note: 'Estimates from the price table, not an invoice.' };
  }

  /** Creates a draft IN REVIEW. There is no way for a tool to create an approved or published content. */
  private async saveDraft(ctx: ToolContext, a: z.output<typeof draft>) {
    const c = await this.prisma.content.create({
      data: { businessId: ctx.businessId, type: 'TEXT', title: a.title, caption: a.body, hashtags: a.hashtags, callToAction: a.callToAction ?? null, targetPlatforms: [a.platform], status: 'IN_REVIEW', origin: 'AI_GENERATED', createdById: ctx.userId, aiMetadata: { source: 'agent', agentId: ctx.agent.id, runId: ctx.runId } },
      select: { id: true, version: true },
    });
    return { contentId: c.id, version: c.version, contentHash: contentHash({ title: a.title, body: a.body, hashtags: a.hashtags, platform: a.platform }), status: 'IN_REVIEW' };
  }

  /** A customer reply draft stays in the task's conversation: it is not sent anywhere. */
  private async saveReplyDraft(ctx: ToolContext, a: z.output<typeof replyDraft>) {
    if (ctx.conversationId) await this.conversations.append(ctx.businessId, ctx.conversationId, 'assistant', `[draft reply${a.needsHuman ? ' - needs a person' : ''}] ${a.reply}`);
    return { saved: true, sent: false, needsHuman: a.needsHuman };
  }
}

function collect(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collect(x, out));
  else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => collect(x, out));
  return out;
}
