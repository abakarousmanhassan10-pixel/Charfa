'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeNext } from '@/components/auth-shell';
import { Loader2 } from 'lucide-react';
import { loginSchema, registerSchema } from '@touma/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/components/auth-provider';
import { LocaleSwitcher, useI18n } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';
import { ApiError } from '@/lib/api-client';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { t, locale } = useI18n();
  const auth = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const presetEmail = params.get('email') ?? undefined;
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const schema = mode === 'login' ? loginSchema : registerSchema;
    const parsed = schema.safeParse({ ...data, locale });
    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
      );
      setError(t('auth.errors.VALIDATION'));
      return;
    }
    setPending(true);
    try {
      if (mode === 'login') await auth.login(data.email!, data.password!);
      else await auth.register(parsed.data as { email: string; password: string; fullName: string; locale: string });
      router.replace(next ?? '/dashboard');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const message = t(`auth.errors.${code}`);
      setError(message.startsWith('auth.errors.') ? t('auth.errors.UNKNOWN') : message);
    } finally {
      setPending(false);
    }
  }

  const field = (name: string, label: string, type: string, autoComplete: string, hint?: string) => (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        defaultValue={name === 'email' ? presetEmail : undefined}
        autoComplete={autoComplete}
        required
        aria-invalid={Boolean(fieldErrors[name])}
        aria-describedby={hint ? `${name}-hint` : undefined}
      />
      {hint && (
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {fieldErrors[name] && <p className="text-xs text-destructive">{fieldErrors[name]}</p>}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <LocaleSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-8 sm:pt-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">{t(mode === 'login' ? 'auth.loginTitle' : 'auth.registerTitle')}</CardTitle>
            <CardDescription>{t(mode === 'login' ? 'auth.loginSubtitle' : 'auth.registerSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="grid gap-4" noValidate>
              {mode === 'register' && field('fullName', t('auth.fullName'), 'text', 'name')}
              {field('email', t('auth.email'), 'email', 'email')}
              {field(
                'password',
                t('auth.password'),
                'password',
                mode === 'login' ? 'current-password' : 'new-password',
                mode === 'register' ? t('auth.passwordHint') : undefined,
              )}
              {error && (
                <p role="alert" data-testid="form-error" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={pending} className="w-full">
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t(mode === 'login' ? 'common.signIn' : 'common.signUp')}
              </Button>
            </form>
            {mode === 'login' && (
              <p className="mt-4 text-center text-sm">
                <Link className="text-primary hover:underline" href="/forgot-password">{t('account.forgotLink')}</Link>
              </p>
            )}
            <p className="mt-6 text-center text-sm text-muted-foreground">
              {t(mode === 'login' ? 'auth.noAccount' : 'auth.haveAccount')}{' '}
              <Link className="font-medium text-primary hover:underline" href={`${mode === 'login' ? '/register' : '/login'}${next ? `?next=${encodeURIComponent(next)}` : ''}`}>
                {t(mode === 'login' ? 'common.signUp' : 'common.signIn')}
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
