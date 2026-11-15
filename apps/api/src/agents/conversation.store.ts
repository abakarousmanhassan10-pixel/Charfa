import { Injectable } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const MAX_MESSAGE = 8000;
/** Anything that looks like a credential is masked before a message is stored. */
const SECRET = /(sk-[A-Za-z0-9_-]{12,}|pdl_(?:live|sdbx)_[A-Za-z0-9_]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{6,})/gi;
export const redactSecrets = (s: string) => s.replace(SECRET, '[REDACTED]');

/** Conversation history of agent tasks: tenant-scoped, size-limited, secrets masked, deleted after AGENTS_CONVERSATION_RETENTION_DAYS. */
@Injectable()
export class ConversationStore {
  constructor(private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv) {}

  async open(businessId: string, agentId: string, runId: string | null) {
    const expiresAt = new Date(Date.now() + this.env.AGENTS_CONVERSATION_RETENTION_DAYS * 86_400_000);
    return this.prisma.agentConversation.create({ data: { businessId, agentId, runId, expiresAt } });
  }

  async append(businessId: string, conversationId: string, role: 'system' | 'user' | 'assistant' | 'tool', content: string, tokens?: number) {
    return this.prisma.agentMessage.create({ data: { businessId, conversationId, role, content: redactSecrets(content).slice(0, MAX_MESSAGE), tokens: tokens ?? null } });
  }

  /** The tenant's own messages only: a conversation id of another business reads as empty. */
  async history(businessId: string, conversationId: string, limit = 50) {
    return this.prisma.agentMessage.findMany({ where: { businessId, conversationId }, orderBy: { createdAt: 'asc' }, take: Math.min(limit, 200), select: { id: true, role: true, content: true, createdAt: true } });
  }

  async forRun(businessId: string, runId: string) {
    return this.prisma.agentConversation.findMany({ where: { businessId, runId }, orderBy: { createdAt: 'asc' }, select: { id: true, agentId: true, createdAt: true, messages: { orderBy: { createdAt: 'asc' }, take: 50, select: { role: true, content: true, createdAt: true } } } });
  }

  /** Retention: deletes expired conversations (and their messages). Returns how many. Safe to run repeatedly. */
  async purgeExpired(now = new Date()): Promise<number> {
    const res = await this.prisma.agentConversation.deleteMany({ where: { expiresAt: { lt: now } } });
    return res.count;
  }
}
