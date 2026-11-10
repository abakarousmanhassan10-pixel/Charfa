import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { I18nProvider } from '@/components/i18n-provider';
import { AuthProvider } from '@/components/auth-provider';
import { getMessages, LOCALE_COOKIE, resolveLocale, textDirection } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'AIMA — AI marketing automation',
  description: 'AI marketing assistant: product analysis, content generation, scheduling and analytics.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));
  return (
    <html lang={locale} dir={textDirection(locale)}>
      <body className="min-h-screen">
        <I18nProvider locale={locale} messages={getMessages(locale)}>
          <AuthProvider>{children}</AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
