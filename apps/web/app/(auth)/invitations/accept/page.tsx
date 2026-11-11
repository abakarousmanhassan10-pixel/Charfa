'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { AuthShell, readFragmentToken } from '@/components/auth-shell';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api-client';

const KEY = 'touma.pendingInvitation';

interface Lookup {
  businessName: string;
  role: string;
  email: string;
}

/**
 * Invitation acceptance. The token comes from the URL fragment (or sessionStorage after a
 * sign-in/registration detour) and is only ever sent to the API in a POST body.
 */
export default function AcceptInvitationPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { status, user, logout } = useAuth();
  const { reload, setActive } = useBusiness();
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let tk = readFragmentToken();
    try {
      if (tk) sessionStorage.setItem(KEY, tk);
      else tk = sessionStorage.getItem(KEY);
    } catch {
      /* storage unavailable */
    }
    setToken(tk);
    if (!tk) return setError(t('account.invalidLink'));
    api<Lookup>('/invitations/lookup', { method: 'POST', json: { token: tk } })
      .then(setInfo)
      .catch(() => setError(t('invite.invalid')));
  }, [t]);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const res = await api<{ businessId: string }>('/invitations/accept', { method: 'POST', json: { token } });
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      await reload();
      setActive(res.businessId);
      router.replace('/dashboard');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      setError(code === 'INVITATION_EMAIL_MISMATCH' ? t('invite.mismatch', { email: info?.email ?? '' }) : code === 'ALREADY_MEMBER' ? t('invite.alreadyMember') : t('invite.invalid'));
    } finally {
      setPending(false);
    }
  }

  const next = encodeURIComponent('/invitations/accept');
  return (
    <AuthShell title={t('invite.title')}>
      {!info && !error && <Loader2 className="h-5 w-5 animate-spin" aria-label={t('common.loading')} />}
      {info && (
        <div className="grid gap-4" data-testid="invite-details">
          <p>{t('invite.join', { business: info.businessName, role: t(`business.roles.${info.role}`) })}</p>
          <p className="text-sm text-muted-foreground">{t('invite.sentTo', { email: info.email })}</p>
          {status === 'authenticated' ? (
            user?.email.toLowerCase() === info.email.toLowerCase() ? (
              <Button onClick={accept} disabled={pending}>
                {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t('invite.accept')}
              </Button>
            ) : (
              <div className="grid gap-2">
                <p className="text-sm text-destructive">{t('invite.mismatch', { email: info.email })}</p>
                <Button variant="outline" onClick={() => void logout()}>{t('common.signOut')}</Button>
              </div>
            )
          ) : status === 'anonymous' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button asChild><Link href={`/login?next=${next}`}>{t('common.signIn')}</Link></Button>
              <Button asChild variant="outline"><Link href={`/register?next=${next}&email=${encodeURIComponent(info.email)}`}>{t('common.signUp')}</Link></Button>
            </div>
          ) : null}
        </div>
      )}
      {error && <p role="alert" data-testid="invite-error" className="mt-4 text-sm text-destructive">{error}</p>}
    </AuthShell>
  );
}
