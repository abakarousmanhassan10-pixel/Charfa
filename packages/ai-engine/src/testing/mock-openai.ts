import { ProviderError } from '../errors';
import type { GenerateRequest, GenerateResult, TextModelProvider } from '../provider';
import { OpenAIProvider } from '../providers/openai';
import { fakeDefaultAnswer } from './fake-provider';

/**
 * TEST-ONLY. A stand-in for the OpenAI HTTP API that speaks the real Responses API wire format.
 * Everything above the network is the real code: the official SDK, the request it builds, the error mapping, the engine.
 * No socket is ever opened, so nothing can be sent to OpenAI and nothing is billed.
 */
export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ResponsesPayloadOptions {
  text?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: 'completed' | 'incomplete' | 'failed';
  incompleteReason?: 'max_output_tokens' | 'content_filter';
  refusal?: string;
}

/** A Responses API object as OpenAI returns it. */
export function responsesPayload(o: ResponsesPayloadOptions = {}) {
  const status = o.status ?? 'completed';
  const content = o.refusal !== undefined ? [{ type: 'refusal', refusal: o.refusal }] : [{ type: 'output_text', text: o.text ?? '{}', annotations: [] }];
  return {
    id: 'resp_mock',
    object: 'response',
    created_at: 1_700_000_000,
    status,
    error: status === 'failed' ? { code: 'server_error', message: 'mock failure' } : null,
    incomplete_details: status === 'incomplete' ? { reason: o.incompleteReason ?? 'max_output_tokens' } : null,
    model: o.model ?? 'mock-model',
    output: [{ id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed', content }],
    usage: { input_tokens: o.inputTokens ?? 10, output_tokens: o.outputTokens ?? 5, total_tokens: (o.inputTokens ?? 10) + (o.outputTokens ?? 5) },
  };
}

/** An OpenAI error body: `{ error: { message, type, code } }`. */
export function openaiErrorBody(status: number, code: string, message = 'mock error') {
  return { status, body: { error: { message, type: status === 429 ? 'rate_limit_error' : 'invalid_request_error', param: null, code } } };
}

export type MockHandler = (call: MockCall) => Response | Promise<Response>;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const jsonResponse: (status: number, body: unknown) => Response = json;

/** A `fetch` that answers like OpenAI. Records every call (without ever storing the API key). */
export function createMockOpenAIFetch(handler: MockHandler) {
  const calls: MockCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'object' && input && 'url' in input ? (input as Request).url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = k.toLowerCase() === 'authorization' ? '[redacted]' : v; });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

type Scripted = string | Error | ((req: GenerateRequest) => string | Promise<string>);

/** The generate request an agent made, rebuilt from the Responses API body. */
function toRequest(call: MockCall): GenerateRequest {
  const fmt = ((call.body.text as { format?: { name?: string; schema?: Record<string, unknown> } } | undefined)?.format) ?? {};
  return {
    system: String(call.body.instructions ?? ''), user: String(call.body.input ?? ''), schemaName: fmt.name ?? '', jsonSchema: fmt.schema ?? {},
    model: String(call.body.model ?? ''), maxOutputTokens: Number(call.body.max_output_tokens ?? 0), timeoutMs: 0,
    ...(typeof call.body.temperature === 'number' ? { temperature: call.body.temperature } : {}),
    ...(typeof call.body.safety_identifier === 'string' ? { safetyId: call.body.safety_identifier } : {}),
  };
}

/** Turns a provider failure into the HTTP answer OpenAI would give (or a network failure). */
function failureFor(err: ProviderError): Response {
  switch (err.kind) {
    case 'auth': return json(401, openaiErrorBody(401, 'invalid_api_key').body);
    case 'quota': return json(429, openaiErrorBody(429, 'insufficient_quota').body);
    case 'rate_limit': return json(429, openaiErrorBody(429, 'rate_limit_exceeded').body);
    case 'server': return json(500, openaiErrorBody(500, 'server_error').body);
    case 'bad_request': return json(400, openaiErrorBody(400, 'invalid_request_error').body);
    case 'refusal': return json(200, responsesPayload({ refusal: 'I cannot help with that.' }));
    case 'truncated': return json(200, responsesPayload({ status: 'incomplete', text: '{"a"' }));
    case 'timeout': throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    default: throw new TypeError('fetch failed');
  }
}

/**
 * TEST-ONLY provider (AI_PROVIDER=mock-openai, accepted only when APP_ENV=test): the real OpenAIProvider talking to the mock above.
 * Answers are the deterministic ones of the fake provider unless a test scripts something else (text, a function, or an error).
 */
export class MockOpenAIProvider implements TextModelProvider {
  /** Recorded on every generation row, so a stored result can never be mistaken for a real OpenAI answer. */
  readonly name = 'mock-openai';
  readonly requests: GenerateRequest[] = [];
  readonly mock: ReturnType<typeof createMockOpenAIFetch>;
  private queue: Scripted[] = [];
  configured = true;
  private readonly inner: OpenAIProvider;

  constructor() {
    this.mock = createMockOpenAIFetch(async (call) => {
      const req = toRequest(call);
      this.requests.push(req);
      const next = this.queue.shift();
      if (next instanceof ProviderError) return failureFor(next);
      if (next instanceof Error) throw next;
      const text = typeof next === 'function' ? await next(req) : typeof next === 'string' ? next : JSON.stringify(fakeDefaultAnswer(req));
      return json(200, responsesPayload({ text, model: req.model, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) }));
    });
    this.inner = new OpenAIProvider({ apiKey: 'sk-mock-key-never-sent', fetchImpl: this.mock.fetch });
  }

  isConfigured() {
    return this.configured;
  }

  enqueue(...items: Scripted[]) {
    this.queue.push(...items);
  }

  reset() {
    this.queue = [];
    this.requests.length = 0;
    this.mock.calls.length = 0;
    this.configured = true;
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.inner.generate(req);
  }
}
