'use client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';

interface Hours { days: number[]; from: string; to: string }
interface AccountView {
  account: { id: string; platform: string; name: string; status: string }; supported: boolean;
  platform: { perPostConfirmation: boolean; limitations: string; consent: string; contentKinds: string[] } | null;
  policy: { mode: string; consentGrantedAt: string | null; consentRevokedAt: string | null; maximumPostsPerDay: number; timezone: string; allowedPublishingHours: Hours[]; allowedContentTypes: string[]; automationEnabled: boolean; pausedAt: string | null } | null;
  effectiveMode: string; consentRequired: boolean; currentConsentVersion: string;
}
interface Row { id: string; calendarEventId: string; action: string; risk: string; mode: string; reasons: Array<{ code: string; message: string }>; contentVersion: number; entry: { title: string; scheduledAt: string; platform: string | null } | null }
interface Result { id: string; platform: string; status: string; simulated: boolean; errorCode: string | null; publishedAt: string | null; scheduledAt: string }
interface Usage { calls: { used: number; limit: number | null }; budget: { usedMicros: number; limitMicros: number | null } }

/** Customer view of the publishing automation: consent and mode per connected account, hours and daily limit, pause, posts waiting for approval, schedule and results. */
export function PublishingView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const biz = active?.id;
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [reviews, setReviews] = useState<Row[]>([]);
  const [schedule, setSchedule] = useState<Row[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consented, setConsented] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    if (!biz) return;
    try {
      const [a, r, s, res] = await Promise.all([api<AccountView[]>('/publishing/accounts', { businessId: biz }), api<Row[]>('/publishing/reviews', { businessId: biz }), api<Row[]>('/publishing/schedule', { businessId: biz }), api<Result[]>('/publishing/results', { businessId: biz })]);
      setAccounts(a); setReviews(r); setSchedule(s); setResults(res); setLoaded(true);
      api<Usage>('/agents/usage', { businessId: biz }).then(setUsage).catch(() => setUsage(null));
    } catch (e) { if (e instanceof ApiError && e.status === 404) setNotEnabled(true); else setError(e instanceof ApiError ? e.message : 'error'); }
  }, [biz]);
  useEffect(() => { void load(); const i = setInterval(() => void load(), 5000); return () => clearInterval(i); }, [load]);
  async function run(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'error'); } finally { setBusy(false); } }
  const call = (path: string, method: 'POST' | 'PUT', json: unknown = {}) => api(`/publishing/${path}`, { method, businessId: biz, json });
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  if (notEnabled) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="publishing-disabled">{t('publishing.notEnabled')}</p>;
  if (!loaded) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const manage = can('autopublish.manage'), approve = can('content.approve') && can('publication.schedule');
  return (
    <div className="grid gap-4" data-testid="publishing-view">
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="publishing-note">{t('publishing.note')}</p>
      {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert" data-testid="publishing-error">{error}</p>}
      {usage && <p className="text-sm text-muted-foreground" data-testid="publishing-usage">{t('publishing.usage')}: {usage.calls.used}{usage.calls.limit != null ? ` / ${usage.calls.limit}` : ''} · ${(usage.budget.usedMicros / 1_000_000).toFixed(4)} ({t('publishing.estimated')})</p>}
      {accounts.length === 0 && <p className="text-sm text-muted-foreground">{t('publishing.noAccounts')}</p>}
      {accounts.map((a) => (
        <Card key={a.account.id} data-testid="publishing-account">
          <CardHeader>
            <CardTitle>{a.account.platform} · {a.account.name}</CardTitle>
            <CardDescription data-testid="effective-mode">{t('publishing.effective')}: <strong>{a.effectiveMode}</strong>{a.policy?.pausedAt ? ` · ${t('publishing.paused')}` : ''}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {!a.supported && <p className="text-muted-foreground">{t('publishing.unsupported')}</p>}
            {a.supported && a.platform && <p className="text-xs text-muted-foreground">{a.platform.limitations}{a.platform.perPostConfirmation ? ` ${t('publishing.perPost')}` : ''}</p>}
            {a.supported && manage && a.consentRequired && (
              <label className="flex items-start gap-2"><input type="checkbox" checked={!!consented[a.account.id]} onChange={(e) => setConsented({ ...consented, [a.account.id]: e.target.checked })} data-testid="consent-check" />
                <span>{t('publishing.consentText')} <em>({a.currentConsentVersion})</em></span></label>
            )}
            {a.supported && manage && a.consentRequired && <div><Button size="sm" disabled={busy || !consented[a.account.id]} data-testid="consent-accept" onClick={() => run(() => call(`accounts/${a.account.id}/consent`, 'POST', { accept: true, consentVersion: a.currentConsentVersion }))}>{t('publishing.accept')}</Button></div>}
            {a.supported && manage && !a.consentRequired && a.policy && (
              <div className="flex flex-wrap items-center gap-2">
                {(['MANUAL', 'HYBRID', 'AUTO'] as const).map((m) => <Button key={m} size="sm" variant={a.policy!.mode === m ? 'default' : 'outline'} disabled={busy} data-testid={`mode-${m}`} onClick={() => run(() => call(`accounts/${a.account.id}/policy`, 'PUT', { mode: m }))}>{m}</Button>)}
                <label className="flex items-center gap-1">{t('publishing.perDay')}<input type="number" min={1} max={10} className="h-8 w-16 rounded-md border bg-background px-2" defaultValue={a.policy.maximumPostsPerDay} data-testid="max-per-day" onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 10 && v !== a.policy!.maximumPostsPerDay) void run(() => call(`accounts/${a.account.id}/policy`, 'PUT', { maximumPostsPerDay: v })); }} /></label>
                <span className="text-xs text-muted-foreground" data-testid="hours">{t('publishing.hours')}: {a.policy.allowedPublishingHours.map((h) => `${h.from}–${h.to}`).join(', ')} ({a.policy.timezone})</span>
              </div>
            )}
            {a.supported && manage && a.policy && !a.consentRequired && (
              <div className="flex gap-2">
                {a.policy.pausedAt
                  ? <Button size="sm" disabled={busy} data-testid="resume" onClick={() => run(() => call(`accounts/${a.account.id}/resume`, 'POST'))}>{t('publishing.resume')}</Button>
                  : <Button size="sm" variant="outline" disabled={busy} data-testid="pause" onClick={() => run(() => call(`accounts/${a.account.id}/pause`, 'POST'))}>{t('publishing.pause')}</Button>}
                <Button size="sm" variant="outline" disabled={busy} data-testid="revoke" onClick={() => run(() => call(`accounts/${a.account.id}/consent/revoke`, 'POST'))}>{t('publishing.revoke')}</Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader><CardTitle>{t('publishing.reviews')}</CardTitle><CardDescription>{t('publishing.reviewsHelp')}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {reviews.length === 0 && <p className="text-muted-foreground" data-testid="reviews-empty">{t('publishing.noReviews')}</p>}
          {reviews.map((r) => (
            <div key={r.id} className="rounded-md border p-3" data-testid="review-row">
              <p className="font-medium">{r.entry?.title} <span className="text-xs text-muted-foreground">{r.entry ? fmt(r.entry.scheduledAt) : ''} · v{r.contentVersion}</span></p>
              <ul className="my-2 list-disc ps-5 text-muted-foreground">{r.reasons.map((x) => <li key={x.code}>{x.message}</li>)}</ul>
              {r.action === 'AWAITING_PLATFORM_CONFIRMATION' && <p className="mb-2 text-xs">{t('publishing.platformConfirm')}</p>}
              {approve && (
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} data-testid="review-approve" onClick={() => run(() => call(`entries/${r.calendarEventId}/approve`, 'POST'))}>{t('publishing.approve')}</Button>
                  <Button size="sm" variant="outline" disabled={busy} data-testid="review-reject" onClick={() => run(() => call(`entries/${r.calendarEventId}/reject`, 'POST', { reason: t('publishing.rejectReason') }))}>{t('publishing.reject')}</Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('publishing.schedule')}</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {schedule.length === 0 && <p className="text-muted-foreground">{t('publishing.noSchedule')}</p>}
          {schedule.map((s) => <p key={s.id} data-testid="schedule-row">{s.entry?.title} · {s.entry ? fmt(s.entry.scheduledAt) : ''} · <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{s.action}</span> <span className="text-xs text-muted-foreground">{s.risk}</span></p>)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('publishing.results')}</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {results.length === 0 && <p className="text-muted-foreground">{t('publishing.noResults')}</p>}
          {results.map((r) => <p key={r.id} data-testid="result-row">{r.platform} · {fmt(r.scheduledAt)} · <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.status}</span>{r.simulated ? ` · ${t('publishing.simulatedTag')}` : ''}{r.errorCode ? ` · ${r.errorCode}` : ''}</p>)}
        </CardContent>
      </Card>
    </div>
  );
}
