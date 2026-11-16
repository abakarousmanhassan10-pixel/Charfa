import { inKeepAliveWindow, KeepAliveService } from './keep-alive.service';
import type { AppEnv } from '../config';

const env = (o: Partial<AppEnv>) => ({ KEEP_ALIVE_HOURS_UTC: '8-22', KEEP_ALIVE_INTERVAL_MINUTES: 10, ...o }) as AppEnv;

describe('keep-alive (demo hosting)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('window: from inclusive, to exclusive, wrapping past midnight', () => {
    expect([7, 8, 21, 22].map((h) => inKeepAliveWindow('8-22', h))).toEqual([false, true, true, false]);
    expect([22, 3, 12].map((h) => inKeepAliveWindow('22-6', h))).toEqual([true, true, false]);
    expect(inKeepAliveWindow('0-24', 23)).toBe(true);
  });
  it('does nothing without KEEP_ALIVE_URL (the default), and no timer is started', () => {
    const f = jest.spyOn(globalThis, 'fetch');
    const s = new KeepAliveService(env({}));
    s.onModuleInit();
    expect((s as unknown as { timer: unknown }).timer).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('pings only our own URL, only inside the window, and survives a failure', async () => {
    const f = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const s = new KeepAliveService(env({ KEEP_ALIVE_URL: 'https://api.example.test/api/v1/health' }));
    expect(await s.ping(new Date('2026-11-16T03:00:00Z'))).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(await s.ping(new Date('2026-11-16T12:00:00Z'))).toBe(true);
    expect(f).toHaveBeenCalledWith('https://api.example.test/api/v1/health', expect.objectContaining({ headers: { 'user-agent': 'touma-keep-alive' } }));
    f.mockRejectedValue(new Error('down'));
    expect(await s.ping(new Date('2026-11-16T12:00:00Z'))).toBe(false);
  });
});
