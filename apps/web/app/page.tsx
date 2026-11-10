'use client';
import Link from 'next/link';
import { BarChart3, CalendarDays, MessagesSquare, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LocaleSwitcher, useI18n } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';

const FEATURES = [
  { key: 'analysis', icon: BarChart3 },
  { key: 'content', icon: Wand2 },
  { key: 'calendar', icon: CalendarDays },
  { key: 'inbox', icon: MessagesSquare },
] as const;

export default function LandingPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-3">
          <LocaleSwitcher />
          <Button variant="ghost" asChild>
            <Link href="/login">{t('common.signIn')}</Link>
          </Button>
          <Button asChild className="hidden sm:inline-flex">
            <Link href="/register">{t('common.signUp')}</Link>
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-6 sm:pt-20">
          <p className="mb-4 inline-block rounded-full border px-3 py-1 text-xs text-muted-foreground">
            {t('common.tagline')}
          </p>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-6xl">{t('landing.title')}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted-foreground">{t('landing.subtitle')}</p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/register">{t('landing.cta')}</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/login">{t('landing.secondaryCta')}</Link>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">{t('landing.pricing')}</p>
        </section>

        <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card key={key}>
              <CardHeader>
                <Icon className="h-5 w-5 text-primary" aria-hidden />
                <CardTitle className="mt-2">{t(`landing.features.${key}.title`)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{t(`landing.features.${key}.body`)}</CardContent>
            </Card>
          ))}
        </section>
      </main>

      <footer className="border-t py-6 text-center text-xs text-muted-foreground">© {new Date().getFullYear()} AIMA</footer>
    </div>
  );
}
