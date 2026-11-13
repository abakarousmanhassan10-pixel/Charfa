'use client';
import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api-client';
import type { SocialAccount } from './types';

type FeatureState = 'AVAILABLE' | 'PERMISSION_MISSING' | 'UNVERIFIED' | 'UNSUPPORTED' | 'NOT_IMPLEMENTED';
interface Capabilities {
  accountId: string;
  simulated: boolean;
  grantedScopes: string[];
  lastVerifiedAt: string | null;
  features: Record<'commentsRead' | 'commentsReply' | 'directMessages', { state: FeatureState; missingScopes: string[]; note: string }>;
  enabled: { commentsRead: boolean; commentsReply: boolean };
  platformNotes: { accountTypes: string; appReview: string; quota: string; sandbox: string };
}

const KEYS = ['commentsRead', 'commentsReply', 'directMessages'] as const;
const TONE: Record<FeatureState, 'success' | 'warning' | 'muted'> = { AVAILABLE: 'success', PERMISSION_MISSING: 'warning', UNVERIFIED: 'muted', UNSUPPORTED: 'muted', NOT_IMPLEMENTED: 'muted' };

/** Granted permissions, last verification and what each platform officially allows. Loaded on demand; never shows a token. */
export function AccountCapabilities({ account, canManage }: { account: SocialAccount; canManage: boolean }) {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const [data, setData] = useState<Capabilities | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(verify: boolean) {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      setData(await api<Capabilities>(`/social/accounts/${account.id}/${verify ? 'validate' : 'capabilities'}`, { method: verify ? 'POST' : 'GET', ...(verify ? { json: {} } : {}), businessId: active.id }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(false);
    }
  }
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data) void run(false);
  };

  return (
    <div className="mt-2" data-testid="capabilities">
      <button type="button" className="text-xs font-medium text-primary underline-offset-2 hover:underline" aria-expanded={open} onClick={toggle} data-testid="capabilities-toggle">
        {t('social.capabilities.toggle')}
      </button>
      {open && (
        <div className="mt-2 grid gap-2 rounded-md border bg-muted/30 p-3 text-xs" data-testid="capabilities-panel">
          {busy && !data && <Loader2 className="h-4 w-4 animate-spin" aria-label={t('common.loading')} />}
          {error && <p className="text-destructive" role="alert">{error}</p>}
          {data && (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant={data.simulated ? 'warning' : 'success'} data-testid="connection-kind">{data.simulated ? t('social.capabilities.demo') : t('social.capabilities.real')}</Badge>
                <span className="text-muted-foreground">
                  {t('social.capabilities.lastVerified')}: {data.lastVerifiedAt ? new Date(data.lastVerifiedAt).toLocaleString(locale) : t('social.capabilities.never')}
                </span>
              </p>
              {data.simulated && <p className="text-muted-foreground">{t('social.capabilities.demoNote')}</p>}
              <div>
                <p className="font-medium">{t('social.capabilities.granted')}</p>
                <p className="break-words text-muted-foreground" data-testid="granted-scopes">{data.simulated ? t('social.capabilities.demoScopes') : data.grantedScopes.length ? data.grantedScopes.join(', ') : t('social.capabilities.none')}</p>
              </div>
              <ul className="grid gap-1.5" data-testid="feature-list">
                {KEYS.map((k) => {
                  const f = data.features[k];
                  const off = k === 'commentsRead' ? !data.enabled.commentsRead : k === 'commentsReply' ? !data.enabled.commentsReply : false;
                  return (
                    <li key={k} className="grid gap-0.5" data-feature={k} data-state={f.state}>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{t(`social.capabilities.feature.${k}`)}</span>
                        <Badge variant={TONE[f.state]}>{t(`social.capabilities.state.${f.state}`)}</Badge>
                        {off && f.state === 'AVAILABLE' && <Badge variant="muted">{t('social.capabilities.serverOff')}</Badge>}
                      </span>
                      {f.state === 'PERMISSION_MISSING' && <span className="text-amber-700 dark:text-amber-400">{t('social.accounts.missingPermissions')}: {f.missingScopes.join(', ')}</span>}
                      {f.state !== 'AVAILABLE' && <span className="text-muted-foreground">{f.note}</span>}
                    </li>
                  );
                })}
              </ul>
              <p className="text-muted-foreground">{t('social.capabilities.reviewNote')} {data.platformNotes.appReview}</p>
              {canManage && account.status !== 'DISCONNECTED' && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => void run(true)} disabled={busy} data-testid="verify-button">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
                    {t('social.capabilities.verify')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
