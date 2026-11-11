import { MemoryObjectStorage } from '@touma/storage';
import { MAX_DELETE_ATTEMPTS, nextDelayMs, processPendingDeletions } from './storage-cleanup';

function prismaWith(rows: Array<{ id: string; storageKey: string; attempts: number }>) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    client: {
      storageDeletion: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(async ({ where, data }) => updates.push({ id: where.id, data })),
      },
    } as never,
  };
}

describe('processPendingDeletions', () => {
  it('deletes due objects and marks them completed', async () => {
    const storage = new MemoryObjectStorage();
    await storage.put('businesses/b/media/a.png', Buffer.from('x'), { contentType: 'image/png' });
    const { client, updates } = prismaWith([{ id: 'd1', storageKey: 'businesses/b/media/a.png', attempts: 1 }]);
    const res = await processPendingDeletions(client, storage, new Date('2026-01-01T00:00:00Z'));
    expect(res).toEqual({ processed: 1, deleted: 1, failed: 0 });
    expect(await storage.head('businesses/b/media/a.png')).toBeNull();
    expect(updates[0]!.data.completedAt).toBeInstanceOf(Date);
  });

  it('reschedules failures with exponential backoff and records the error', async () => {
    const storage = new MemoryObjectStorage();
    storage.failDeletes = 1;
    const { client, updates } = prismaWith([{ id: 'd1', storageKey: 'k', attempts: 2 }]);
    const now = new Date('2026-01-01T00:00:00Z');
    const res = await processPendingDeletions(client, storage, now);
    expect(res.failed).toBe(1);
    expect(updates[0]!.data).toMatchObject({ attempts: 3, lastError: expect.stringMatching(/unavailable/) });
    expect((updates[0]!.data.nextAttemptAt as Date).getTime() - now.getTime()).toBe(4 * 60_000);
  });

  it('only selects due rows below the attempt cap', async () => {
    const { client } = prismaWith([]);
    await processPendingDeletions(client, new MemoryObjectStorage());
    expect((client as unknown as { storageDeletion: { findMany: jest.Mock } }).storageDeletion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ completedAt: null, attempts: { lt: MAX_DELETE_ATTEMPTS } }) }));
  });

  it('caps the backoff at 6 hours', () => {
    expect(nextDelayMs(1)).toBe(60_000);
    expect(nextDelayMs(30)).toBe(6 * 3600_000);
  });
});
