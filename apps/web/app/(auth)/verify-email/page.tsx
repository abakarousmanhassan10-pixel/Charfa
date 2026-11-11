'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { AuthShell, readFragmentToken } from '@/components/auth-shell';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';

export default function VerifyEmailPage() {
  const { t } = useI18n();
  const { status, refreshProfile } = useAuth();
  const [state, setState] = useState<'pending' | 'ok' | 'invalid'>('pending');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readFragmentToken();
    if (!token) return setState('invalid');
    api('/auth/email/verify', { method: 'POST', json: { token } })
      .then(() => setState('ok'))
      .catch(() => setState('invalid'));
  }, []);
  useEffect(() => {
    if (state === 'ok' && status === 'authenticated') void refreshProfile();
  }, [state, status, refreshProfile]);

  return (
    <AuthShell title={t('account.verifyTitle')}>
      {state === 'pending' && <Loader2 className="h-5 w-5 animate-spin" aria-label={t('common.loading')} />}
      {state === 'ok' && <p role="status" data-testid="verify-ok" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm">{t('account.verified')}</p>}
      {state === 'invalid' && <p role="alert" data-testid="verify-invalid" className="text-sm text-destructive">{t('account.invalidLink')}</p>}
      <Button className="mt-6 w-full" asChild variant={state === 'ok' ? 'default' : 'outline'}>
        <Link href={status === 'authenticated' ? '/dashboard' : '/login'}>{status === 'authenticated' ? t('dashboard.nav.dashboard') : t('common.signIn')}</Link>
      </Button>
    </AuthShell>
  );
}
