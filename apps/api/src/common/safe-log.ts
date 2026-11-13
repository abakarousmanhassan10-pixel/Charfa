/**
 * What may be written to server logs about a request. Query-string values are secrets in this API (the customer chat token,
 * OAuth `code` and `state`, invitation and verification tokens), so only parameter names are kept.
 */
export function safeUrl(url: string | undefined): string {
  if (!url) return '-';
  const i = url.indexOf('?');
  if (i < 0) return url.slice(0, 300);
  const names = [...new Set(url.slice(i + 1).split('&').map((p) => p.split('=')[0]!.slice(0, 40)).filter(Boolean))].slice(0, 10);
  return `${url.slice(0, i).slice(0, 300)}?${names.map((n) => `${n}=[redacted]`).join('&')}`;
}

/** A request id is echoed in responses and logs: only the validated id set by the request middleware, or a clean header. */
export function safeRequestId(generated: string | undefined, header: unknown): string | undefined {
  if (generated) return generated;
  return typeof header === 'string' && /^[\w-]{1,64}$/.test(header) ? header : undefined;
}
