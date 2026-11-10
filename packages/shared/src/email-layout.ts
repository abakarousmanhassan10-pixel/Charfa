import { BRAND, brandSlogan } from './brand';

/**
 * Branded layout for transactional emails (verification, invitations, password reset,
 * billing notices). Each template supplies already-translated text; every dynamic value is
 * HTML-escaped here, so templates can't inject markup.
 */
export interface EmailContent {
  locale: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footerNote?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Email action URL must be http(s)');
  return parsed.toString();
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const c = BRAND.colors;
  const slogan = brandSlogan(content.locale);
  const dir = content.locale.startsWith('ar') ? 'rtl' : 'ltr';
  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${c.text}">${escapeHtml(p)}</p>`)
    .join('');
  const action = content.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(safeUrl(content.action.url))}" style="display:inline-block;background:${c.primary};color:${c.primaryForeground};padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(content.action.label)}</a></p>`
    : '';
  const html = `<!doctype html>
<html lang="${escapeHtml(content.locale)}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(content.heading)} — ${BRAND.productName}</title></head>
<body style="margin:0;background:#f6f7fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(content.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border:1px solid ${c.border};border-radius:12px">
<tr><td style="padding:24px 32px;border-bottom:1px solid ${c.border}">
<span style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;border-radius:8px;background:${c.primary};color:${c.primaryForeground};font-weight:700">T</span>
<span style="margin-inline-start:8px;font-weight:700;font-size:16px;color:${c.text}">${BRAND.productName}</span>
</td></tr>
<tr><td style="padding:32px">
<h1 style="margin:0 0 16px;font-size:22px;color:${c.text}">${escapeHtml(content.heading)}</h1>
${paragraphs}${action}
${content.footerNote ? `<p style="margin:24px 0 0;font-size:13px;color:${c.muted}">${escapeHtml(content.footerNote)}</p>` : ''}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid ${c.border};font-size:12px;color:${c.muted}">${BRAND.name} · ${escapeHtml(slogan)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${BRAND.productName}`,
    '',
    content.heading,
    '',
    ...content.paragraphs,
    ...(content.action ? ['', `${content.action.label}: ${safeUrl(content.action.url)}`] : []),
    ...(content.footerNote ? ['', content.footerNote] : []),
    '',
    `${BRAND.name} — ${slogan}`,
  ].join('\n');

  return { html, text };
}
