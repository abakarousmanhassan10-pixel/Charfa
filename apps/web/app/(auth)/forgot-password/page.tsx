'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { emailSchema } from '@touma/shared';
import { AuthShell } from '@/components/auth-shell';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <AuthShell title={t('account.forgotTitle')} description={t('account.forgotSubtitle')}>
      {sent ? (
        <p role="status" data-testid="forgot-sent" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm">{t('account.forgotSent')}</p>
      ) : (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if (!emailSchema.safeParse(email).success) return setError(t('auth.errors.VALIDATION'));
            setPending(true);
            try {
              await api('/auth/password/forgot', { method: 'POST', json: { email } });
              setSent(true);
            } catch (err) {
              setError(err instanceof ApiError && err.code === 'TOO_MANY_REQUESTS' ? t('auth.errors.TOO_MANY_REQUESTS') : t('auth.errors.UNKNOWN'));
            } finally {
              setPending(false);
            }
          }}
        >
          <Field id="forgot-email" label={t('auth.email')} error={error ?? undefined}>
            <Input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('account.sendLink')}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link className="text-primary hover:underline" href="/login">{t('account.backToLogin')}</Link>
      </p>
    </AuthShell>
  );
}
