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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body.code ?? (res.status === 429 ? 'TOO_MANY_REQUESTS' : res.status === 400 ? 'VALIDATION' : 'UNKNOWN');
    throw new ApiError(res.status, code, body.message ?? res.statusText);
  }
  return body as T;
}

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { [CSRF_HEADER]: '1' },
      });
      if (res.ok) {
        const body = await res.json();
        accessToken = body.accessToken;
        return true;
      }
      const body = await res.json().catch(() => ({}));
      if (body.code !== 'REFRESH_RACE') break;
    }
    accessToken = null;
    return false;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
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

export async function authRequest<T>(path: '/auth/login' | '/auth/register', json: unknown): Promise<T> {
  const body = await api<T & { accessToken: string }>(path, { method: 'POST', json }, false);
  accessToken = body.accessToken;
  return body;
}

export async function logout() {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { [CSRF_HEADER]: '1' },
  }).catch(() => undefined);
  accessToken = null;
}
