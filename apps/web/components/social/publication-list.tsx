'use client';
import { useState } from 'react';
import { BarChart3, Copy, ExternalLink, Loader2, RotateCcw, SearchCheck } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';
import { PlatformLabel, PublicationStatusBadge } from './platform';
import type { Publication, PublicationAnalytics } from './types';

const METRIC_KEYS = ['views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'linkClicks'] as const;

/** Publications with their real status, platform link, error message and the actions a person may take. */
export function PublicationList({ items, onChanged, testId = 'publication-list' }: { items: Publication[]; onChanged: () => void; testId?: string }) {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<Publication | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [manualOk, setManualOk] = useState(false);
  const [unknownFor, setUnknownFor] = useState<Publication | null>(null);
  const [metrics, setMetrics] = useState<{ pub: Publication; data: PublicationAnalytics | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const schedule = can('publication.schedule');
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  const errText = (e: unknown) => (e instanceof ApiError ? (t(`social.errors.${e.code}`).startsWith('social.errors.') ? e.message : t(`social.errors.${e.code}`)) : t('common.loadError'));

  async function retry(p: Publication, confirmNotPublished = false) {
    if (!active) return;
    setBusy(p.id);
    setError(null);
    try {
      await api(`/social/publications/${p.id}/retry`, { method: 'POST', json: confirmNotPublished ? { confirmNotPublished: true } : {}, businessId: active.id });
      setUnknownFor(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  /** Asks the platform whether the post exists. Read-only: found = recorded as published; otherwise the person decides. */
  async function reconcile(p: Publication) {
    if (!active) return;
    setBusy(p.id);
    setError(null);
    try {
      await api(`/social/publications/${p.id}/reconcile`, { method: 'POST', json: {}, businessId: active.id });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function openManual(p: Publication) {
    if (!active) return;
    setManual(p);
    setManualUrl('');
    setManualOk(false);
    try {
      setManual(await api<Publication>(`/social/publications/${p.id}`, { businessId: active.id }));
    } catch {
      /* the summary is enough to continue */
    }
  }

  async function completeManual() {
    if (!active || !manual) return;
    setBusy(manual.id);
    setError(null);
    try {
      await api(`/social/publications/${manual.id}/manual-complete`, { method: 'POST', json: { confirmPublished: true, ...(manualUrl.trim() ? { externalUrl: manualUrl.trim() } : {}) }, businessId: active.id });
      setManual(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function openMetrics(p: Publication) {
    if (!active) return;
    setMetrics({ pub: p, data: null });
    try {
      setMetrics({ pub: p, data: await api<PublicationAnalytics>(`/social/analytics/publications/${p.id}`, { businessId: active.id }) });
    } catch (e) {
      setError(errText(e));
      setMetrics(null);
    }
  }

  async function refreshMetrics() {
    if (!active || !metrics) return;
    setBusy('metrics');
    try {
      setMetrics({ pub: metrics.pub, data: await api<PublicationAnalytics>(`/social/analytics/publications/${metrics.pub.id}/refresh`, { method: 'POST', json: {}, businessId: active.id }) });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="publication-error">{error}</p>}
      <ul className="grid gap-3" data-testid={testId}>
        {items.map((p) => (
          <li key={p.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto]" data-testid="publication-item" data-status={p.status} data-platform={p.platform}>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <PlatformLabel platform={p.platform} />
                <span className="truncate">{p.entryTitle ?? t('social.history.untitled')}</span>
                <PublicationStatusBadge status={p.status} />
                {p.mode === 'MANUAL' && p.status === 'PUBLISHED' && <span className="rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="manual-badge">{t('social.history.manual')}</span>}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {p.accountName} · {fmt(p.scheduledAt)} ({p.timezone}) {p.attempts > 0 && `· ${t('social.history.attempts', { count: p.attempts })}`}
                {p.status === 'PUBLISHED' && p.publishedAt && ` · ${t('social.history.publishedAt', { when: fmt(p.publishedAt) })}`}
              </p>
              {p.simulated && <p className="mt-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs" data-testid="simulated">{t('social.history.simulated')}</p>}
              {p.status === 'PUBLISHED' && !p.confirmedByProvider && <p className="mt-1 text-xs text-muted-foreground">{t('social.history.notConfirmed')}</p>}
              {p.error && p.status !== 'PUBLISHED' && <p className={`mt-1 text-xs ${p.status === 'FAILED' ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="publication-message">{p.errorCode && t(`social.publishErrors.${p.errorCode}`).indexOf('social.') !== 0 ? `${t(`social.publishErrors.${p.errorCode}`)} ` : ''}<span className="text-muted-foreground">{p.error}</span></p>}
              {p.outcomeUnknown && <p className="mt-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs" data-testid="outcome-unknown">{t('social.history.outcomeUnknown')}</p>}
              {p.status === 'PUBLISHED' && p.visibilityNote && <p className="mt-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs" data-testid="visibility-note"><span className="font-medium">{t('social.history.limitedVisibility')}</span> {p.visibilityNote}</p>}
              {p.outcomeUnknown && p.reconcile && <p className="mt-1 text-xs text-muted-foreground" data-testid="reconcile-result">{t(`social.reconcile.${p.reconcile.result}`)} {p.reconcile.note}</p>}
              {p.status === 'PUBLISHED' && p.reconcile?.foundOnPlatform && <p className="mt-1 text-xs text-muted-foreground" data-testid="reconcile-found">{t('social.reconcile.foundNote')}</p>}
              {p.externalUrl && <a href={p.externalUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="external-link"><ExternalLink className="h-3 w-3" aria-hidden />{t('social.history.openPost')}</a>}
            </div>
            <div className="flex flex-wrap items-start gap-2 sm:justify-end">
              {p.status === 'FAILED' && p.outcomeUnknown && schedule && (
                <Button size="sm" onClick={() => void reconcile(p)} disabled={busy === p.id} data-testid="reconcile-button">{busy === p.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SearchCheck className="h-4 w-4" aria-hidden />}{t('social.reconcile.check')}</Button>
              )}
              {p.status === 'FAILED' && schedule && (
                <Button size="sm" variant="outline" onClick={() => (p.outcomeUnknown ? setUnknownFor(p) : void retry(p))} disabled={busy === p.id} data-testid="retry-button">{busy === p.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}{t('social.history.retry')}</Button>
              )}
              {(p.status === 'MANUAL_REQUIRED' || (p.status === 'FAILED' && p.outcomeUnknown)) && schedule && <Button size="sm" onClick={() => void openManual(p)} data-testid="manual-button">{t('social.history.iPublished')}</Button>}
              {p.status === 'PUBLISHED' && <Button size="sm" variant="ghost" onClick={() => void openMetrics(p)} data-testid="metrics-button"><BarChart3 className="h-4 w-4" aria-hidden />{t('social.history.metrics')}</Button>}
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={manual !== null} onClose={() => setManual(null)} title={t('social.manual.title')} description={t('social.manual.text')} closeLabel={t('common.close')} className="max-w-xl">
        {manual && (
          <div className="grid gap-4" data-testid="manual-dialog">
            {manual.manualPackage && (
              <>
                <div>
                  <p className="mb-1 text-sm font-medium">{t('social.manual.textLabel')}</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm" data-testid="manual-text">{manual.manualPackage.text}</pre>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => { void navigator.clipboard?.writeText(manual.manualPackage!.text).then(() => setCopied(true)); }}><Copy className="h-4 w-4" aria-hidden />{copied ? t('social.manual.copied') : t('social.manual.copy')}</Button>
                </div>
                {manual.manualPackage.media.length > 0 && (
                  <ul className="grid gap-1 text-sm">
                    {manual.manualPackage.media.map((m) => <li key={m.id}><a className="text-primary hover:underline" href={`/api/v1${m.downloadUrl.replace(/^\/api\/v1/, '')}`} download>{t('social.manual.download', { name: m.filename })}</a></li>)}
                  </ul>
                )}
              </>
            )}
            {manual.outcomeUnknown && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm">{t('social.history.outcomeUnknown')}</p>}
            <Field id="mn-url" label={t('social.manual.url')} optional optionalLabel={t('common.optional')}><Input id="mn-url" type="url" placeholder="https://" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} /></Field>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={manualOk} onChange={(e) => setManualOk(e.target.checked)} data-testid="manual-confirm" /><span>{t('social.manual.confirm')}</span></label>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setManual(null)}>{t('common.cancel')}</Button>
              <Button onClick={() => void completeManual()} disabled={!manualOk || busy === manual.id} data-testid="manual-submit">{t('social.manual.submit')}</Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={unknownFor !== null} onClose={() => setUnknownFor(null)} title={t('social.unknown.title')} description={t('social.unknown.text')} closeLabel={t('common.close')}>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => setUnknownFor(null)}>{t('common.cancel')}</Button>
          <Button variant="outline" onClick={() => { const p = unknownFor; setUnknownFor(null); if (p) void openManual(p); }}>{t('social.history.iPublished')}</Button>
          <Button onClick={() => unknownFor && void retry(unknownFor, true)} data-testid="unknown-retry">{t('social.unknown.retry')}</Button>
        </div>
      </Dialog>

      <Dialog open={metrics !== null} onClose={() => setMetrics(null)} title={t('social.metrics.title')} closeLabel={t('common.close')}>
        {metrics && (
          <div className="grid gap-3" data-testid="metrics-dialog">
            {!metrics.data ? <p className="text-sm text-muted-foreground">{t('common.loading')}</p> : !metrics.data.measurable ? <p className="text-sm text-muted-foreground">{t(`social.metrics.not.${metrics.data.reason ?? 'NOT_PUBLISHED'}`)}</p> : !metrics.data.snapshot ? <p className="text-sm text-muted-foreground">{t('social.metrics.none')}</p> : (
              <>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  {METRIC_KEYS.map((k) => {
                    const v = metrics.data!.snapshot!.metrics[k];
                    return (
                      <div key={k} className="rounded-md border p-2" data-testid="metric" data-metric={k} data-available={v === null ? 'false' : 'true'}>
                        <dt className="text-xs text-muted-foreground">{t(`social.metrics.names.${k}`)}</dt>
                        <dd className="text-lg font-semibold">{v === null ? <span title={t('social.metrics.unavailable')}>—</span> : new Intl.NumberFormat(locale).format(v)}</dd>
                        {v === null && <p className="text-[11px] text-muted-foreground">{t('social.metrics.unavailable')}</p>}
                      </div>
                    );
                  })}
                  <div className="rounded-md border p-2 col-span-2" data-testid="metric" data-metric="engagement" data-available={metrics.data.snapshot.engagementRate === null ? 'false' : 'true'}>
                    <dt className="text-xs text-muted-foreground">{t('social.metrics.names.engagement')}</dt>
                    <dd className="text-lg font-semibold">{metrics.data.snapshot.engagementRate === null ? '—' : `${(metrics.data.snapshot.engagementRate * 100).toFixed(1)} %`}</dd>
                  </div>
                </dl>
                {metrics.data.snapshot.unavailableReason && <p className="text-xs text-muted-foreground">{metrics.data.snapshot.unavailableReason}</p>}
                <p className="text-xs text-muted-foreground">{t('social.metrics.legend')} · {t('social.metrics.fetched', { when: fmt(metrics.data.snapshot.fetchedAt) })}</p>
              </>
            )}
            {metrics.data?.measurable && can('social.manage') && <div><Button size="sm" variant="outline" onClick={() => void refreshMetrics()} disabled={busy === 'metrics'}>{busy === 'metrics' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('social.metrics.refresh')}</Button></div>}
          </div>
        )}
      </Dialog>
    </>
  );
}
