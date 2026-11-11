import { CreativeProviderError } from './types';

/** fetch with a hard timeout; network failures and timeouts become retryable CreativeProviderErrors. */
export async function timedFetch(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new CreativeProviderError('timeout', `${label} did not answer in time`);
    throw new CreativeProviderError('network', `${label} could not be reached`);
  } finally {
    clearTimeout(timer);
  }
}

/** Maps an HTTP error from an OpenAI-style API. The message comes from the provider's error body, never from our request. */
export async function mapOpenAIError(res: Response, label: string): Promise<CreativeProviderError> {
  let code = '';
  let message = '';
  try {
    const body = (await res.json()) as { error?: { code?: string; type?: string; message?: string } };
    code = body.error?.code ?? body.error?.type ?? '';
    message = (body.error?.message ?? '').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 300);
  } catch {
    /* non-JSON error body */
  }
  const status = res.status;
  if (status === 401) return new CreativeProviderError('auth', `${label} rejected the configured credentials`, status);
  if (status === 403) return new CreativeProviderError('auth', `${label} refused access${message ? `: ${message}` : ''}`, status);
  if (status === 429 && /quota|billing/i.test(`${code} ${message}`)) return new CreativeProviderError('billing', `${label}: the account has no remaining quota or billing is not set up`, status);
  if (status === 429) return new CreativeProviderError('rate_limit', `${label} is rate limiting requests`, status);
  if (status >= 500) return new CreativeProviderError('server', `${label} is unavailable (${status})`, status);
  if (/moderation|content_policy|safety/i.test(`${code} ${message}`)) return new CreativeProviderError('refusal', `${label} declined this request${message ? `: ${message}` : ''}`, status);
  return new CreativeProviderError('bad_request', `${label} rejected the request${message ? `: ${message}` : ''}`, status);
}
