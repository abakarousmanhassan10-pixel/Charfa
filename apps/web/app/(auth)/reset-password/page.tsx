'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { passwordSchema } from '@touma/shared';
import { AuthShell, readFragmentToken } from '@/components/auth-shell';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';

export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setToken(readFragmentToken());
    setChecked(true);
  }, []);

  return (
    <AuthShell title={t('account.resetTitle')} description={t('account.resetSubtitle')}>
      {done ? (
        <div className="grid gap-4">
          <p role="status" data-testid="reset-done" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm">{t('account.resetDone')}</p>
          <Button asChild><Link href="/login">{t('common.signIn')}</Link></Button>
        </div>
      ) : checked && !token ? (
        <p role="alert" className="text-sm text-destructive">{t('account.invalidLink')}</p>
      ) : (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const parsed = passwordSchema.safeParse(password);
            if (!parsed.success) return setError(parsed.error.issues[0]!.message);
            if (password !== confirm) return setError(t('account.passwordsDiffer'));
            setPending(true);
            try {
              await api('/auth/password/reset', { method: 'POST', json: { token, password } });
              setDone(true);
            } catch (err) {
              setError(err instanceof ApiError && err.code === 'INVALID_TOKEN' ? t('account.invalidLink') : t('auth.errors.UNKNOWN'));
            } finally {
              setPending(false);
            }
          }}
        >
          <Field id="reset-password" label={t('account.newPassword')} hint={t('auth.passwordHint')}>
            <Input id="reset-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field id="reset-confirm" label={t('account.confirmPassword')} error={error ?? undefined}>
            <Input id="reset-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={pending || !token}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('account.setPassword')}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
