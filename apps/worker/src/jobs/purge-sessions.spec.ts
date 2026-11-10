import { purgeExpiredSessions } from './purge-sessions';

describe('purgeExpiredSessions', () => {
  it('deletes sessions older than the retention cutoff', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const now = new Date('2026-01-31T00:00:00Z');
    const count = await purgeExpiredSessions({ session: { deleteMany } } as never, 30, now);
    expect(count).toBe(3);
    const cutoff = new Date('2026-01-01T00:00:00Z');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
  });
});
