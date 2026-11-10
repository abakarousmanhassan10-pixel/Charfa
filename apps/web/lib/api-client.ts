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
    } catch {
      /* network error: treated as signed out */
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
