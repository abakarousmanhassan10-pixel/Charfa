import type { ZodError } from 'zod';
import { ApiError } from './api-client';

export function zodFieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

/** Maps a NestJS validation message array ("timezone must be ...") back onto field names. */
export function apiFieldErrors(err: unknown, fields: string[]): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 400) return {};
  const out: Record<string, string> = {};
  for (const msg of err.message.split(', ')) {
    const field = fields.find((f) => msg.startsWith(`${f} `));
    if (field) out[field] ??= msg;
  }
  return out;
}
