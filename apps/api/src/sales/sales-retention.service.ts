import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86_400_000;
export const TEST_CONVERSATION_DAYS = 7;

export interface PurgeResult {
  businesses: number;
  conversationsErased: number;
  customersAnonymized: number;
  testConversationsDeleted: number;
}

/**
 * Data retention. A conversation with no activity for the merchant's retention period (default 365 days) loses its message texts, its
 * AI details and its secret token; its customer is anonymized and their notes deleted. Anonymous statistics (counts, intents, languages,
 * handoff reasons) stay. Test conversations from the dashboard playground are deleted after 7 days. Idempotent, safe to run on several
 * instances at once (each step is a conditional update), and it records what it did per business without any personal data.
 */
@Injectable()
export class SalesRetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SalesRetention');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  onApplicationBootstrap() {
    if (this.env.SALES_RETENTION_INTERVAL_MS > 0 && this.env.APP_ENV !== 'test') {
      this.timer = setInterval(() => void this.purge().catch((e) => this.logger.error(`retention purge failed: ${(e as Error).message}`)), this.env.SALES_RETENTION_INTERVAL_MS).unref();
    }
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(now = new Date()): Promise<PurgeResult> {
    const total: PurgeResult = { businesses: 0, conversationsErased: 0, customersAnonymized: 0, testConversationsDeleted: 0 };
    const configs = await this.prisma.salesAgentConfig.findMany({ select: { businessId: true, retentionDays: true } });
    for (const { businessId, retentionDays } of configs) {
      const cutoff = new Date(now.getTime() - retentionDays * DAY);
      const stale = { businessId, isTest: false, OR: [{ lastMessageAt: { lt: cutoff } }, { lastMessageAt: null, createdAt: { lt: cutoff } }] } satisfies Prisma.ConversationWhereInput;
      const ids = (await this.prisma.conversation.findMany({ where: { ...stale, messages: { some: { body: { not: '[erased]' } } } }, select: { id: true }, take: 500 })).map((c) => c.id);
      const staleCustomers = (await this.prisma.customer.findMany({ where: { businessId, anonymizedAt: null, lastSeenAt: { lt: cutoff } }, select: { id: true }, take: 500 })).map((c) => c.id);
      const testCutoff = new Date(now.getTime() - TEST_CONVERSATION_DAYS * DAY);
      const test = await this.prisma.conversation.deleteMany({ where: { businessId, isTest: true, createdAt: { lt: testCutoff } } });
      if (!ids.length && !staleCustomers.length && !test.count) continue;
      await this.prisma.$transaction([
        this.prisma.message.updateMany({ where: { conversationId: { in: ids } }, data: { body: '[erased]', aiMetadata: Prisma.DbNull } }),
        this.prisma.conversation.updateMany({ where: { id: { in: ids } }, data: { publicTokenHash: null, customerName: null } }),
        this.prisma.agentFeedback.deleteMany({ where: { conversationId: { in: ids } } }),
        this.prisma.customerNote.deleteMany({ where: { customerId: { in: staleCustomers } } }),
        this.prisma.customer.updateMany({ where: { id: { in: staleCustomers }, anonymizedAt: null }, data: { name: null, email: null, phone: null, interests: [], consentAt: null, assignedToId: null, followUpAt: null, anonymizedAt: now } }),
      ]);
      total.businesses++;
      total.conversationsErased += ids.length;
      total.customersAnonymized += staleCustomers.length;
      total.testConversationsDeleted += test.count;
      await this.audit.record({ action: 'sales.retention_purged', actorId: null, businessId, entityType: 'SalesAgentConfig', entityId: businessId, metadata: { retentionDays, conversations: ids.length, customers: staleCustomers.length, testConversations: test.count } });
    }
    return total;
  }
}
