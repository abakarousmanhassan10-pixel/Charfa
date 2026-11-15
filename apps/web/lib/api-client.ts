/**
 * Browser API client. The access token lives only in memory (never localStorage) to limit XSS impact.
 * The refresh token is an httpOnly, SameSite=Strict cookie scoped to /api/v1/auth.
 */
export const CSRF_HEADER = 'x-touma-csrf';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string | string[],
    /** Extra detail sent by the API, e.g. the list of issues that blocked an approval. */
    public readonly details?: string[],
    /** Structured extras: calendar conflicts to confirm, missing fields, the id of an already-applied plan. */
    public readonly extra?: { conflicts?: Array<{ code: string; severity: string; message: string; withEntryId?: string; withTitle?: string }>; missing?: string[]; planId?: string },
  ) {
    super(Array.isArray(message) ? message.join(', ') : message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text().catch(() => '');
  // An empty success body means "no value": never turn it into an object that looks like data.
  if (res.ok && text.trim() === '') return null as T;
  let body: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError(res.status, 'INVALID_RESPONSE', 'The server sent an invalid response');
  }
  if (!res.ok) {
    // A gateway answer without an API error body means the API is not answering (for example it is waking up): say so, not "failed".
    // (Next's proxy answers a bare 500 "Internal Server Error" when the API closes the connection while it wakes up.)
    const gateway = !body.code && ([502, 503, 504].includes(res.status) || (res.status === 500 && text.trim() === 'Internal Server Error'));
    const code = body.code ?? (res.status === 429 ? 'TOO_MANY_REQUESTS' : res.status === 400 ? 'VALIDATION' : gateway ? 'SERVER_UNAVAILABLE' : 'UNKNOWN');
    throw new ApiError(res.status, code, body.message ?? (gateway ? 'The server is starting up or temporarily unavailable. Wait about a minute and try again.' : res.statusText), Array.isArray(body.issues) ? body.issues.map(String) : undefined, { conflicts: Array.isArray(body.conflicts) ? body.conflicts : undefined, missing: Array.isArray(body.missing) ? body.missing : undefined, planId: typeof body.planId === 'string' ? body.planId : undefined });
  }
  return body as T;
}

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { [CSRF_HEADER]: '1' },
        });
        if (res.ok) {
          accessToken = (await res.json()).accessToken;
          return true;
        }
        // Rate limited: the session is still valid, so wait and retry once instead of signing out.
        if (res.status === 429 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
      } catch {
        /* network error: treated as signed out */
      }
      break;
    }
    accessToken = null;
    return false;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export type ApiInit = RequestInit & { json?: unknown; businessId?: string };

export async function api<T>(path: string, init: ApiInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  // Tenant claim for flat resource routes; the API verifies membership on every request.
  if (init.businessId) headers.set('X-Business-Id', init.businessId);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refreshSession()) return api<T>(path, init, false);
  }
  return parse<T>(res);
}

/** Lets the sign-in form say "the server is waking up" while authRequest waits and retries (free hosting puts the API to sleep). */
let wakingListener: ((waking: boolean) => void) | null = null;
export function onServerWaking(fn: ((waking: boolean) => void) | null) { wakingListener = fn; }

/** Wakes a sleeping API in the background (called when the sign-in page opens, so it is up by the time the person has typed). */
export function warmUpServer() { void fetch('/api/v1/health', { credentials: 'same-origin', cache: 'no-store' }).catch(() => undefined); }

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAKE_RETRIES = 8;
const WAKE_DELAY_MS = 10_000;

/**
 * Sign-in / sign-up. When the API does not answer at all (gateway error or network failure: it is waking up), the request never reached the application,
 * so repeating it is safe: retry every 10 s for about 80 s and tell the form. A real answer from the API (wrong password, validation...) is never retried.
 */
export async function authRequest<T>(path: '/auth/login' | '/auth/register', json: unknown): Promise<T> {
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await api<T & { accessToken: string }>(path, { method: 'POST', json }, false);
        accessToken = body.accessToken;
        return body;
      } catch (err) {
        const asleep = err instanceof ApiError && (err.code === 'SERVER_UNAVAILABLE' || err.code === 'NETWORK');
        if (!asleep || attempt >= WAKE_RETRIES) throw err;
        wakingListener?.(true);
        await sleepMs(WAKE_DELAY_MS);
      }
    }
  } finally {
    wakingListener?.(false);
  }
}

export async function logout() {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: '1' },
  }).catch(() => undefined);
  accessToken = null;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/**
 * Multipart upload with progress (XHR, since fetch has no upload progress). Same auth rules as api():
 * bearer token in memory, one transparent refresh on 401.
 */
export function uploadFile<T>(
  path: string,
  form: FormData,
  opts: { businessId: string; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal },
  retry = true,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1${path}`);
    xhr.withCredentials = false;
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('X-Business-Id', opts.businessId);
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.({ loaded: e.loaded, total: e.total });
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled'));
    xhr.onload = async () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status === 401 && retry && (await refreshSession())) {
        uploadFile<T>(path, form, opts, false).then(resolve, reject);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else {
        const code = (body.code as string) ?? (xhr.status === 413 ? 'FILE_TOO_LARGE' : 'UNKNOWN');
        reject(new ApiError(xhr.status, code, (body.message as string) ?? xhr.statusText));
      }
    };
    opts.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}
