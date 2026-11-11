import { Inject, Injectable, Logger } from '@nestjs/common';
import { OBJECT_STORAGE, type ObjectStorage } from '@touma/storage';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Deletes storage objects through a durable queue: each key is recorded first, then deleted
 * immediately when possible. Failures stay pending and are retried by the worker
 * (storage-cleanup job) with exponential backoff, so outages never leave orphaned files.
 */
@Injectable()
export class StorageDeletionQueue {
  private readonly logger = new Logger(StorageDeletionQueue.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async deleteKeys(keys: Array<string | null | undefined>, ctx: { businessId?: string; reason: string }) {
    const list = keys.filter((k): k is string => Boolean(k));
    if (!list.length) return { deleted: 0, pending: 0 };
    const rows = await this.prisma.$transaction(
      list.map((storageKey) => this.prisma.storageDeletion.create({ data: { storageKey, businessId: ctx.businessId, reason: ctx.reason } })),
    );
    let deleted = 0;
    for (const row of rows) {
      try {
        await this.storage.delete(row.storageKey);
        await this.prisma.storageDeletion.update({ where: { id: row.id }, data: { completedAt: new Date(), attempts: 1 } });
        deleted++;
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        await this.prisma.storageDeletion.update({
          where: { id: row.id },
          data: { attempts: 1, lastError: message, nextAttemptAt: new Date(Date.now() + 60_000) },
        });
        this.logger.warn(`Deletion of ${row.storageKey} deferred to the cleanup job: ${message}`);
      }
    }
    return { deleted, pending: rows.length - deleted };
  }
}
