import { ProviderError, ProviderNotConfiguredError } from '../errors';
import type { GenerateRequest, GenerateResult, TextModelProvider } from '../provider';

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/**
 * OpenAI Chat Completions with Structured Outputs (response_format json_schema, strict).
 * Uses fetch directly; the API key is only placed in the Authorization header.
 */
export class OpenAIProvider implements TextModelProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured() {
    return Boolean(this.opts.apiKey);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.opts.apiKey) throw new ProviderNotConfiguredError('OpenAI', 'OPENAI_API_KEY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...(this.opts.organization ? { 'OpenAI-Organization': this.opts.organization } : {}),
        },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          max_completion_tokens: req.maxOutputTokens,
          response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema } },
        }),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new ProviderError('timeout', `OpenAI request timed out after ${req.timeoutMs} ms`);
      throw new ProviderError('network', 'Could not reach OpenAI');
    } finally {
      clearTimeout(timer);
    }

    const body = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
    if (!res.ok) {
      // Provider messages can echo request fragments; keep only a short, generic part.
      const detail = (body.error?.code ?? body.error?.type ?? '').slice(0, 60);
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `OpenAI rejected the credentials (${res.status})`, res.status);
      if (res.status === 429) throw new ProviderError('rate_limit', `OpenAI rate limit or quota reached ${detail}`.trim(), 429);
      if (res.status >= 500) throw new ProviderError('server', `OpenAI server error ${res.status}`, res.status);
      throw new ProviderError('bad_request', `OpenAI rejected the request (${res.status}) ${detail}`.trim(), res.status);
    }
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) throw new ProviderError('refusal', 'The model refused the request');
    if (choice?.finish_reason === 'length') throw new ProviderError('truncated', 'The answer was cut off (max output tokens reached)');
    const text = choice?.message?.content;
    if (typeof text !== 'string' || text.length === 0) throw new ProviderError('server', 'OpenAI returned an empty answer');
    return {
      text,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      model: body.model ?? req.model,
    };
  }
}
