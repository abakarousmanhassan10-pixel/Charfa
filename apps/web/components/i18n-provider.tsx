'use client';
import { createContext, useCallback, useContext, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { SUPPORTED_LOCALES } from '@aima/shared';
import { LOCALE_COOKIE, translate, type Messages } from '@/lib/i18n';

interface I18nContextValue {
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (locale: string) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: Messages;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const setLocale = useCallback(
    (next: string) => {
      document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
      router.refresh();
    },
    [router],
  );
  const value = useMemo(
    () => ({ locale, setLocale, t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars) }),
    [locale, messages, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span className="sr-only">{t('common.language')}</span>
      <select
        aria-label={t('common.language')}
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        className="rounded-md border bg-background px-2 py-1 text-sm"
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {l === 'en' ? 'English' : l === 'fr' ? 'Français' : l}
          </option>
        ))}
      </select>
    </label>
  );
}
