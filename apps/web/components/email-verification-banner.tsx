'use client';
import { useState } from 'react';
import { MailWarning } from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api-client';

export function EmailVerificationBanner() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'tooSoon' | 'error'>('idle');
  if (!user || user.emailVerified !== false) return null;
  return (
    <div role="note" data-testid="verify-banner" className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <MailWarning className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1">{t('account.unverified', { email: user.email })}</span>
      {state === 'sent' ? (
        <span className="font-medium">{t('account.resent')}</span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={state === 'sending'}
          onClick={async () => {
            setState('sending');
            try {
              await api('/auth/email/resend', { method: 'POST' });
              setState('sent');
            } catch (err) {
              setState(err instanceof ApiError && (err.code === 'TOO_SOON' || err.code === 'TOO_MANY_REQUESTS') ? 'tooSoon' : 'error');
            }
          }}
        >
          {t('account.resend')}
        </Button>
      )}
      {state === 'tooSoon' && <span className="w-full text-xs">{t('account.tooSoon')}</span>}
      {state === 'error' && <span className="w-full text-xs text-destructive">{t('auth.errors.UNKNOWN')}</span>}
    </div>
  );
}
