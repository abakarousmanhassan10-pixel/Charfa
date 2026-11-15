import { api, ApiError, authRequest, onServerWaking } from './api-client';

const reply = (status: number, body: string) => jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
afterEach(() => jest.restoreAllMocks());

describe('api client errors', () => {
  it('a gateway error without an API body is reported as "server unavailable", not as a failed action', async () => {
    for (const status of [502, 503, 504]) {
      reply(status, 'Bad Gateway');
      const err = (await api('/ai/business-analysis', { method: 'POST', json: {} }).catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status, code: 'SERVER_UNAVAILABLE' });
      expect(err.message).toMatch(/starting up or temporarily unavailable/);
    }
  });
  it('keeps the API\'s own error codes, including a 503 the API sent on purpose', async () => {
    reply(503, JSON.stringify({ code: 'AI_NOT_CONFIGURED', message: 'TOUMA AI is not configured on this server' }));
    await expect(api('/ai/status')).rejects.toMatchObject({ status: 503, code: 'AI_NOT_CONFIGURED' });
    reply(400, JSON.stringify({ code: 'ITEM_NOT_ACTIVE', message: 'Activate it first' }));
    await expect(api('/ai/product-analysis', { method: 'POST', json: {} })).rejects.toMatchObject({ code: 'ITEM_NOT_ACTIVE' });
    reply(429, '');
    await expect(api('/x')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    reply(500, 'oops');
    await expect(api('/x')).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('treats the proxy\'s bare 500 and a network failure as "the server is waking up"', async () => {
    reply(500, 'Internal Server Error');
    await expect(api('/x')).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' });
    reply(502, '');
    await expect(api('/x')).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' });
  });
});

describe('authRequest while the server is waking up', () => {
  afterEach(() => { jest.useRealTimers(); onServerWaking(null); });
  it('retries a sleeping server, tells the form, and returns the token once it answers', async () => {
    jest.useFakeTimers();
    const states: boolean[] = [];
    onServerWaking((w) => states.push(w));
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'tok' }), { status: 200 }));
    const p = authRequest<{ accessToken: string }>('/auth/login', { email: 'a@b.co', password: 'x' });
    await jest.advanceTimersByTimeAsync(25_000);
    await expect(p).resolves.toMatchObject({ accessToken: 'tok' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(states).toEqual([true, true, false]);
  });
  it('never retries a real answer from the API (wrong password)', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'no' }), { status: 401 }));
    await expect(authRequest('/auth/login', { email: 'a@b.co', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
