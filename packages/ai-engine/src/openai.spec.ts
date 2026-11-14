import { OpenAIProvider } from './providers/openai';
import { ProviderError, ProviderNotConfiguredError } from './errors';
import type { GenerateRequest } from './provider';
import { createMockOpenAIFetch, jsonResponse, openaiErrorBody, responsesPayload } from './testing/mock-openai';

const KEY = 'sk-test-secret-0123456789';
const req: GenerateRequest = { system: 'sys', user: 'usr', schemaName: 'x', jsonSchema: { type: 'object' }, model: 'm1', temperature: 0.4, maxOutputTokens: 500, timeoutMs: 5000 };
const answering = (payload: unknown, status = 200) => createMockOpenAIFetch(() => jsonResponse(status, payload));
const provider = (m: ReturnType<typeof createMockOpenAIFetch>, extra: Record<string, unknown> = {}) => new OpenAIProvider({ apiKey: KEY, fetchImpl: m.fetch, ...extra });

describe('OpenAIProvider (official SDK, Responses API)', () => {
  it('is not configured without a key and never calls the network', async () => {
    const m = answering(responsesPayload());
    const p = new OpenAIProvider({ fetchImpl: m.fetch });
    expect(p.isConfigured()).toBe(false);
    await expect(p.generate(req)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(m.calls).toHaveLength(0);
  });

  it('sends a strict structured-output Responses API request, keeps nothing at OpenAI, and sends no tools', async () => {
    const m = answering(responsesPayload({ text: '{"a":1}', model: 'm1-2026', inputTokens: 12, outputTokens: 5 }));
    const res = await provider(m).generate({ ...req, safetyId: 'tenant-hash-1' });
    expect(res).toEqual({ text: '{"a":1}', inputTokens: 12, outputTokens: 5, model: 'm1-2026' });
    const call = m.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.headers.authorization).toBe('[redacted]'); // sent as a header, never in the body
    expect(call.body).toMatchObject({
      model: 'm1', instructions: 'sys', input: 'usr', max_output_tokens: 500, temperature: 0.4, store: false, safety_identifier: 'tenant-hash-1',
      text: { format: { type: 'json_schema', name: 'x', strict: true, schema: { type: 'object' } } },
    });
    expect(call.body).not.toHaveProperty('tools');
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it('omits the temperature when none is configured (some models reject it) and uses the configured model for each call', async () => {
    const m = answering(responsesPayload());
    const p = provider(m);
    await p.generate({ ...req, temperature: undefined, model: 'model-for-analysis' });
    await p.generate({ ...req, model: 'model-for-copy' });
    expect(m.calls[0]!.body).not.toHaveProperty('temperature');
    expect(m.calls.map((c) => c.body.model)).toEqual(['model-for-analysis', 'model-for-copy']);
    expect(m.calls[0]!.body).not.toHaveProperty('safety_identifier');
  });

  it('can target another base URL (a gateway or a local test server)', async () => {
    const m = answering(responsesPayload());
    await provider(m, { baseUrl: 'https://gateway.example.test/v1/' }).generate(req);
    expect(m.calls[0]!.url).toBe('https://gateway.example.test/v1/responses');
  });

  it.each([
    [401, 'invalid_api_key', 'auth', false],
    [403, 'permission_denied', 'auth', false],
    [429, 'rate_limit_exceeded', 'rate_limit', true],
    [429, 'insufficient_quota', 'quota', false],
    [500, 'server_error', 'server', true],
    [503, 'overloaded', 'server', true],
    [400, 'invalid_request_error', 'bad_request', false],
  ])('maps HTTP %s (%s) to %s (retryable=%s) with a safe message', async (status, code, kind, retryable) => {
    const m = createMockOpenAIFetch(() => jsonResponse(status, { error: { message: `Incorrect API key provided: ${KEY}. Prompt was: usr`, type: 'x', code } }));
    const err = (await provider(m).generate(req).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('sk-');
    expect(err.message).not.toContain('Prompt was');
    expect(m.calls).toHaveLength(1); // the SDK does not retry on its own: the engine decides
  });

  it('detects refusals, truncation, a blocked answer, a failed response and an empty answer', async () => {
    const run = (payload: unknown) => provider(answering(payload)).generate(req);
    await expect(run(responsesPayload({ refusal: 'no' }))).rejects.toMatchObject({ kind: 'refusal' });
    await expect(run(responsesPayload({ status: 'incomplete', incompleteReason: 'max_output_tokens', text: '{"a"' }))).rejects.toMatchObject({ kind: 'truncated' });
    await expect(run(responsesPayload({ status: 'incomplete', incompleteReason: 'content_filter', text: '' }))).rejects.toMatchObject({ kind: 'refusal' });
    await expect(run(responsesPayload({ status: 'failed' }))).rejects.toMatchObject({ kind: 'server' });
    await expect(run(responsesPayload({ text: '' }))).rejects.toMatchObject({ kind: 'server' });
  });

  it('maps timeouts and network errors as retryable', async () => {
    const abort = createMockOpenAIFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    await expect(provider(abort).generate(req)).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    const down = createMockOpenAIFetch(() => { throw new TypeError('fetch failed'); });
    await expect(provider(down).generate(req)).rejects.toMatchObject({ kind: 'network', retryable: true });
  });

  it('exposes the error body helper used by the mock', () => {
    expect(openaiErrorBody(429, 'insufficient_quota').body.error.code).toBe('insufficient_quota');
  });
});
