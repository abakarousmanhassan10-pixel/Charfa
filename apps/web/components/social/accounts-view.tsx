'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Loader2, Plug, RefreshCw, ShieldCheck } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';
import { PLATFORMS, type Platform } from '@/components/calendar/types';
import { AccountStatusBadge, PlatformLabel } from './platform';
import type { PendingConnection, SocialAccount } from './types';
import { useAccounts, useSocialStatus } from './use-social';

/**
 * Connect, reconnect and disconnect social accounts. Connections only happen through the platform's own OAuth 2.0 screen:
 * TOUMA never sees or asks for a password, and an account only appears here after the platform returned it.
 */
export function AccountsView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const router = useRouter();
  const params = useSearchParams();
  const status = useSocialStatus();
  const accounts = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<SocialAccount | null>(null);
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const oauthError = params.get('error');
  const connectId = params.get('connect');
  const manage = can('social.manage');

  const clearParams = useCallback(() => router.replace('/dashboard/social/accounts'), [router]);

  useEffect(() => {
    if (!connectId || !active) return;
    let alive = true;
    api<PendingConnection>(`/social/connections/${connectId}`, { businessId: active.id })
      .then((p) => {
        if (!alive) return;
        setPending(p);
        // Nothing is pre-selected when there is a choice to make: the person chooses. A single offer (or a reconnection) is pre-selected.
        setChosen(p.reconnectAccountId ? p.candidates.filter((c) => c.externalAccountId).slice(0, 1).map((c) => c.externalAccountId) : p.candidates.length === 1 && p.candidates[0]!.criticalPermissionsMissing.length === 0 ? [p.candidates[0]!.externalAccountId] : []);
      })
      .catch((e) => alive && setError(e instanceof ApiError ? t(`social.errors.${e.code}`) : t('common.loadError')));
    return () => {
      alive = false;
    };
  }, [connectId, active, t]);

  async function start(platform: Platform, reconnectAccountId?: string) {
    if (!active) return;
    setBusy(platform);
    setError(null);
    try {
      const res = await api<{ authorizationUrl: string }>(`/social/connections/${platform.toLowerCase()}/start`, { method: 'POST', json: reconnectAccountId ? { reconnectAccountId } : {}, businessId: active.id });
      window.location.assign(res.authorizationUrl);
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiError ? (t(`social.errors.${e.code}`).startsWith('social.errors.') ? e.message : t(`social.errors.${e.code}`)) : t('common.loadError'));
    }
  }

  async function confirmSelection() {
    if (!active || !pending) return;
    setSelecting(true);
    setError(null);
    try {
      await api(`/social/connections/${pending.id}/select`, { method: 'POST', json: { externalAccountIds: chosen }, businessId: active.id });
      setPending(null);
      clearParams();
      void accounts.reload();
      void status.reload();
    } catch (e) {
      setError(e instanceof ApiError ? t(`social.errors.${e.code}`) : t('common.loadError'));
    } finally {
      setSelecting(false);
    }
  }

  async function act(a: SocialAccount, action: 'refresh') {
    if (!active) return;
    setBusy(a.id);
    setError(null);
    try {
      await api(`/social/accounts/${a.id}/${action}`, { method: 'POST', json: {}, businessId: active.id });
    } catch (e) {
      setError(e instanceof ApiError ? t(`social.errors.${e.code}`).replace(/^social\.errors\..*$/, e.message) : t('common.loadError'));
    } finally {
      setBusy(null);
      void accounts.reload();
    }
  }

  const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—');
  const byPlatform = (p: Platform) => (accounts.data?.items ?? []).filter((a) => a.platform === p);

  return (
    <div className="grid gap-6">
      <p className="flex items-start gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm" data-testid="no-passwords">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
        {t('social.accounts.noPasswords')}
      </p>
      {oauthError && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" data-testid="oauth-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="grow">{t(`social.oauthErrors.${oauthError}`).startsWith('social.oauthErrors.') ? t('social.oauthErrors.UNKNOWN') : t(`social.oauthErrors.${oauthError}`)}</div>
          <Button size="sm" variant="ghost" onClick={clearParams}>{t('common.close')}</Button>
        </div>
      )}
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="accounts-error">{error}</p>}

      <Card>
        <CardHeader><CardTitle>{t('social.accounts.connectTitle')}</CardTitle></CardHeader>
        <CardContent>
          {status.loading && !status.data ? <LoadingRows rows={2} label={t('common.loading')} /> : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="platform-cards">
              {PLATFORMS.map((p) => {
                const info = status.data?.platforms.find((x) => x.platform === p);
                const count = byPlatform(p).filter((a) => a.status !== 'DISCONNECTED').length;
                return (
                  <li key={p} className="grid content-between gap-3 rounded-xl border p-4" data-testid="platform-card" data-platform={p} data-configured={info?.configured ? 'true' : 'false'}>
                    <div>
                      <p className="flex items-center justify-between font-semibold"><PlatformLabel platform={p} />{count > 0 && <Badge variant="success">{t('social.accounts.connectedCount', { count })}</Badge>}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t(`social.platformNote.${p}`)}</p>
                    </div>
                    {info?.configured ? (
                      manage ? <Button onClick={() => void start(p)} disabled={busy === p} data-testid="connect-button">{busy === p ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />}{count > 0 ? t('social.accounts.addAnother') : t('social.accounts.connect')}</Button>
                        : <p className="text-xs text-muted-foreground">{t('social.accounts.needsManager')}</p>
                    ) : (
                      <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs" data-testid="not-configured">
                        {t('social.accounts.notConfigured')}
                        {manage && info && info.missingConfiguration.length > 0 && <span className="mt-1 block font-mono text-[11px]">{info.missingConfiguration.join(', ')}</span>}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('social.accounts.listTitle')}</CardTitle></CardHeader>
        <CardContent>
          {accounts.loading && !accounts.data ? <LoadingRows rows={3} label={t('common.loading')} /> : accounts.error && !accounts.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void accounts.reload()} /> : (accounts.data?.items.length ?? 0) === 0 ? (
            <EmptyState title={t('social.accounts.emptyTitle')} hint={t('social.accounts.emptyHint')} />
          ) : (
            <ul className="grid gap-3" data-testid="account-list">
              {accounts.data!.items.map((a) => (
                <li key={a.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-center" data-testid="account-item" data-status={a.status} data-platform={a.platform}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <PlatformLabel platform={a.platform} />
                      <span className="truncate">{a.displayName ?? a.username ?? a.externalAccountId}</span>
                      <AccountStatusBadge status={a.status} />
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {a.accountType && t(`social.accountType.${a.accountType}`)} {a.username && `· @${a.username.replace(/^@/, '')}`} · {t('social.accounts.token')}: {t(`social.tokenState.${a.tokenState}`)}{a.tokenExpiresAt && a.tokenState !== 'NON_EXPIRING' ? ` (${fmt(a.tokenExpiresAt)})` : ''}
                    </p>
                    {a.criticalPermissionsMissing.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('social.accounts.missingPermissions')}: {a.criticalPermissionsMissing.join(', ')}</p>}
                    {a.permissionsMissing.length > a.criticalPermissionsMissing.length && <p className="mt-1 text-xs text-muted-foreground">{t('social.accounts.missingOptional')}: {a.permissionsMissing.filter((p) => !a.criticalPermissionsMissing.includes(p)).join(', ')}</p>}
                    {a.lastError && a.status !== 'CONNECTED' && <p className="mt-1 text-xs text-destructive" data-testid="account-error">{a.lastError}</p>}
                  </div>
                  {manage && (
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      {(a.status !== 'CONNECTED' || a.tokenState === 'EXPIRING') && <Button size="sm" onClick={() => void start(a.platform, a.id)} disabled={busy === a.platform} data-testid="reconnect-button"><Plug className="h-4 w-4" aria-hidden />{t('social.accounts.reconnect')}</Button>}
                      {a.canRefresh && a.status === 'CONNECTED' && <Button size="sm" variant="outline" onClick={() => void act(a, 'refresh')} disabled={busy === a.id} data-testid="refresh-button">{busy === a.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}{t('social.accounts.refresh')}</Button>}
                      {a.status !== 'DISCONNECTED' && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDisconnecting(a)} data-testid="disconnect-button">{t('social.accounts.disconnect')}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onClose={() => { setPending(null); clearParams(); }} title={t('social.select.title')} description={t('social.select.text')} closeLabel={t('common.close')} className="max-w-xl">
        {pending && (
          <div className="grid gap-4" data-testid="select-dialog">
            <ul className="grid gap-2">
              {pending.candidates.map((c) => {
                const blocked = c.criticalPermissionsMissing.length > 0;
                return (
                  <li key={c.externalAccountId}>
                    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${chosen.includes(c.externalAccountId) ? 'border-primary bg-primary/5' : ''}`}>
                      <input type="checkbox" className="mt-1" checked={chosen.includes(c.externalAccountId)} onChange={(e) => setChosen((x) => pending.reconnectAccountId ? (e.target.checked ? [c.externalAccountId] : []) : e.target.checked ? [...x, c.externalAccountId] : x.filter((y) => y !== c.externalAccountId))} data-testid="candidate" />
                      <span className="min-w-0">
                        <span className="block font-medium">{c.displayName ?? c.username ?? c.externalAccountId}</span>
                        <span className="block text-xs text-muted-foreground">{t(`social.accountType.${c.accountType}`)}{c.username ? ` · @${c.username.replace(/^@/, '')}` : ''}{c.alreadyConnected ? ` · ${t('social.select.alreadyConnected')}` : ''}</span>
                        {blocked && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">{t('social.select.missing', { list: c.criticalPermissionsMissing.join(', ') })}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => { setPending(null); clearParams(); }}>{t('common.cancel')}</Button>
              <Button onClick={() => void confirmSelection()} disabled={chosen.length === 0 || selecting} data-testid="select-confirm">{selecting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('social.select.confirm', { count: chosen.length })}</Button>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={disconnecting !== null}
        title={t('social.accounts.disconnectTitle')}
        description={t('social.accounts.disconnectText', { name: disconnecting?.displayName ?? '' })}
        confirmLabel={t('social.accounts.disconnect')}
        cancelLabel={t('common.cancel')}
        onClose={() => setDisconnecting(null)}
        onConfirm={async () => {
          if (!disconnecting || !active) return;
          await api(`/social/accounts/${disconnecting.id}/disconnect`, { method: 'POST', json: {}, businessId: active.id });
          setDisconnecting(null);
          void accounts.reload();
          void status.reload();
        }}
      />
    </div>
  );
}
