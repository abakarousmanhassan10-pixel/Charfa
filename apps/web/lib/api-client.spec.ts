import { api, ApiError } from './api-client';

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
});
