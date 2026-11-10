import { OpenAIProvider } from './providers/openai';
import { ProviderError, ProviderNotConfiguredError } from './errors';
import type { GenerateRequest } from './provider';

const req: GenerateRequest = { system: 'sys', user: 'usr', schemaName: 'x', jsonSchema: { type: 'object' }, model: 'm1', temperature: 0.4, maxOutputTokens: 500, timeoutMs: 1000 };
const ok = (body: unknown, status = 200) => jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

describe('OpenAIProvider', () => {
  it('is not configured without a key and never calls the network', async () => {
    const fetchImpl = jest.fn();
    const p = new OpenAIProvider({ fetchImpl });
    expect(p.isConfigured()).toBe(false);
    await expect(p.generate(req)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a strict json_schema request and returns text + usage', async () => {
    const fetchImpl = ok({ model: 'm1-2026', choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    const p = new OpenAIProvider({ apiKey: 'sk-test-secret', fetchImpl: fetchImpl as never });
    const res = await p.generate(req);
    expect(res).toEqual({ text: '{"a":1}', inputTokens: 12, outputTokens: 5, model: 'm1-2026' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test-secret');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'm1',
      temperature: 0.4,
      max_completion_tokens: 500,
      response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
    });
    expect(body).not.toHaveProperty('tools');
    expect(init.body).not.toContain('sk-test-secret');
  });

  it.each([
    [401, 'auth', false],
    [429, 'rate_limit', true],
    [500, 'server', true],
    [400, 'bad_request', false],
  ])('maps HTTP %s to %s (retryable=%s) without leaking the key', async (status, kind, retryable) => {
    const p = new OpenAIProvider({ apiKey: 'sk-test-secret', fetchImpl: ok({ error: { message: 'Incorrect API key sk-test-secret', code: 'invalid_api_key' } }, status) as never });
    const err = (await p.generate(req).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.message).not.toContain('sk-test-secret');
  });

  it('detects refusals, truncation and empty answers', async () => {
    const mk = (choice: unknown) => new OpenAIProvider({ apiKey: 'k', fetchImpl: ok({ choices: [choice] }) as never });
    await expect(mk({ message: { refusal: 'no' } }).generate(req)).rejects.toMatchObject({ kind: 'refusal' });
    await expect(mk({ finish_reason: 'length', message: { content: '{"a"' } }).generate(req)).rejects.toMatchObject({ kind: 'truncated' });
    await expect(mk({ message: { content: '' } }).generate(req)).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps timeouts and network errors', async () => {
    const abort = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(new OpenAIProvider({ apiKey: 'k', fetchImpl: abort as never }).generate(req)).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    const down = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new OpenAIProvider({ apiKey: 'k', fetchImpl: down as never }).generate(req)).rejects.toMatchObject({ kind: 'network' });
  });
});
