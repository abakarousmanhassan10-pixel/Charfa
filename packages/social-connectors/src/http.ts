import { SocialApiError, type ErrorKind } from './types';

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | Buffer; signal?: AbortSignal; redirect?: 'follow' | 'manual' }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HttpResult {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
  json: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Removes anything that looks like a credential from text that may end up in logs, errors or the database. */
export function redact(text: string): string {
  return text
    .replace(/(access_token|refresh_token|client_secret|fb_exchange_token|code|Authorization|upload_id|uploadToken|input_token)(["'\s:=]+)[^"'&\s,}]+/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .slice(0, 500);
}

export type ErrorMapper = (r: HttpResult) => SocialApiError | null;

/** Minimal, injectable HTTP client: every adapter call goes through it, so tests can replace the network completely. */
export class Http {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = 60_000,
  ) {}

  async request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | Buffer; query?: Record<string, string | undefined> } = {}): Promise<HttpResult> {
    let target = url;
    if (init.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) if (v !== undefined) q.set(k, v);
      target += (url.includes('?') ? '&' : '?') + q.toString();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(target, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      let json: HttpResult['json'] = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, json };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new SocialApiError('timeout', 'The platform did not answer in time', { outcome: 'unknown' });
      throw new SocialApiError('transient', 'Could not reach the platform', { outcome: 'unknown' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** A request that must succeed; failures are normalized by the platform's mapper. */
  async ok(url: string, init: Parameters<Http['request']>[1], map: ErrorMapper): Promise<HttpResult> {
    const r = await this.request(url, init);
    if (r.status >= 200 && r.status < 300) return r;
    throw map(r) ?? generic(r);
  }
}

export function generic(r: HttpResult): SocialApiError {
  const kind: ErrorKind = r.status === 401 ? 'auth' : r.status === 403 ? 'permission' : r.status === 429 ? 'rate_limit' : r.status >= 500 ? 'transient' : 'validation';
  const retryAfter = Number(r.headers.get('retry-after'));
  return new SocialApiError(kind, `The platform answered HTTP ${r.status}: ${redact(r.text)}`, { status: r.status, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined, outcome: r.status >= 500 ? 'unknown' : 'not_created' });
}

export const form = (data: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.set(k, v);
  return p.toString();
};
export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
export const JSON_HEADERS = { 'content-type': 'application/json' };
