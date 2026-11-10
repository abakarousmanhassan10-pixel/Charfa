import { DEFAULT_LOCALE, isSupportedLocale, textDirection, type SupportedLocale } from '@touma/shared';
import en from '../messages/en.json';
import fr from '../messages/fr.json';

export type Messages = typeof en;
export const LOCALE_COOKIE = 'touma_locale';

// Each locale must provide every key of the English catalog (enforced by the type below and by tests).
const catalogs: Record<SupportedLocale, Messages> = { en, fr };

export function getMessages(locale: string): Messages {
  return catalogs[isSupportedLocale(locale) ? locale : DEFAULT_LOCALE];
}

export function resolveLocale(cookieValue?: string, acceptLanguage?: string | null): SupportedLocale {
  if (isSupportedLocale(cookieValue)) return cookieValue;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const code = part.split(';')[0]?.trim().split('-')[0]?.toLowerCase();
    if (isSupportedLocale(code)) return code;
  }
  return DEFAULT_LOCALE;
}

/** Dot-path lookup with {placeholder} interpolation. Falls back to the key itself (visible in QA). */
export function translate(messages: Messages, key: string, vars?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], messages);
  if (typeof value !== 'string') return key;
  return vars ? value.replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? `{${v}}`)) : value;
}

export { textDirection };
