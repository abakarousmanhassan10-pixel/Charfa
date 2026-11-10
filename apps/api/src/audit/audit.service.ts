import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@aima/database';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  businessId?: string | null;
  entityType?: string;
  entityId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /pass(word)?|token|secret|authorization|cookie|key/i;

/** Remove anything that looks like a credential before persisting. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      SENSITIVE_KEYS.test(k) ? [k, '[REDACTED]'] : [k, redact(v, depth + 1)],
    ),
  );
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Audit writes must never break the user-facing request; failures are logged. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId ?? null,
          businessId: entry.businessId ?? null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent?.slice(0, 512) ?? null,
          metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log for ${entry.action}: ${(err as Error).message}`);
    }
  }
}
