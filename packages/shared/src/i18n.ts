/**
 * Locale registry. Adding a language = add its code here + a messages file in apps/web/messages.
 * Turkish and Arabic are declared for the architecture but not yet enabled in the UI.
 */
export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const PLANNED_LOCALES = ['tr', 'ar'] as const;

export const RTL_LOCALES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(value: string | undefined | null): value is SupportedLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function textDirection(locale: string): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale.split('-')[0] ?? locale) ? 'rtl' : 'ltr';
}
