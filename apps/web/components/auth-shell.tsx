'use client';
import { LocaleSwitcher } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AuthShell({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <LocaleSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-8 sm:pt-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </main>
    </div>
  );
}

/** Reads a token from the URL fragment (#token=...), then removes it from the address bar. */
export function readFragmentToken(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /[#&]token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (m) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m?.[1] ?? null;
}

/** Same-origin relative paths only (prevents open redirects). */
export function safeNext(value: string | null): string | null {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : null;
}
