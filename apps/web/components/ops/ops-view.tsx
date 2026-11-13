'use client';
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';
import { useResource, type Paged } from '@/lib/use-resource';

type Source = 'measured' | 'unavailable';
interface Worker { state: 'up' | 'stale' | 'unknown' | 'unavailable'; lastHeartbeat: string | null }
interface Overview {
  capturedAt: string; database: { state: 'up' | 'down' }; redis: { state: 'up' | 'unavailable' }; maintenanceWorker: Worker; openAlerts: number;
  queues: Array<{ queue: string; source: Source; counts: { waiting: number; active: number; delayed: number; failed: number; completed: number } | null; worker: Worker }>;
}
interface Alert { id: string; queue: string; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; observed: number; threshold: number; occurrences: number; firstSeenAt: string; lastSeenAt: string }
interface Rules { items: Array<{ id: string; queue: string | null; threshold: number; enabled: boolean }>; queues: string[] }

const tone = (s: string) => (s === 'up' ? 'text-emerald-700 dark:text-emerald-400' : s === 'stale' || s === 'unknown' ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400');

/**
 * Operations control center (platform administrators). Every figure is read from the API, which reports whether it was
 * measured just now or is unavailable; nothing on this page is simulated, and unavailable values are never shown as zero.
 */
export function OpsView({ canManage }: { canManage: boolean }) {
  const { t, locale } = useI18n();
  const ov = useResource<Overview>('/admin/ops/overview', 'platform');
  const [alertPage, setAlertPage] = useState(1);
  const alerts = useResource<Paged<Alert>>(`/admin/ops/alerts?page=${alertPage}&pageSize=10`, 'platform');
  const rules = useResource<Rules>('/admin/ops/alert-rules', 'platform');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState('');

  const reload = ov.reload;
  const reloadAlerts = alerts.reload;
  useEffect(() => {
    const id = setInterval(() => { void reload(); void reloadAlerts(); }, 15_000);
    return () => clearInterval(id);
  }, [reload, reloadAlerts]);

  const act = useCallback(async (key: string, path: string, method: 'POST' | 'PUT', json: unknown = {}) => {
    setBusy(key);
    setError(null);
    try {
      await api(`/admin/ops${path}`, { method, json, businessId: 'platform' });
      await Promise.all([reload(), reloadAlerts(), rules.reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(null);
    }
  }, [reload, reloadAlerts, rules, t]);

  if (ov.loading && !ov.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (!ov.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void ov.reload()} />;
  const o = ov.data;
  const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) + ' UTC' : '—');
  const global = rules.data?.items.find((r) => r.queue === null);
  const spin = (k: string) => busy === k && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;

  return (
    <div className="grid gap-6" data-testid="ops-view">
      <p className="text-xs text-muted-foreground" data-testid="ops-source">{t('ops.source', { at: fmt(o.capturedAt) })}</p>
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="ops-error">{error}</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="ops-tiles">
        {([['database', o.database.state], ['redis', o.redis.state], ['maintenanceWorker', o.maintenanceWorker.state]] as const).map(([k, v]) => (
          <div key={k} className="rounded-xl border p-4" data-testid="ops-tile" data-tile={k}><p className="text-xs text-muted-foreground">{t(`ops.tile.${k}`)}</p><p className={`mt-1 text-xl font-bold ${tone(v)}`}>{t(`ops.state.${v}`)}</p></div>
        ))}
        <div className="rounded-xl border p-4" data-testid="ops-tile" data-tile="openAlerts"><p className="text-xs text-muted-foreground">{t('ops.tile.openAlerts')}</p><p className="mt-1 text-xl font-bold">{o.openAlerts}</p></div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2"><CardTitle>{t('ops.queues')}</CardTitle>
          {canManage && <Button size="sm" variant="outline" onClick={() => void act('collect', '/collect', 'POST')} disabled={busy !== null} data-testid="ops-collect">{spin('collect')}{t('ops.collect')}</Button>}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="ops-queues">
            <thead><tr className="text-start text-xs text-muted-foreground"><th className="py-1 text-start">{t('ops.col.queue')}</th><th className="text-end">{t('ops.col.waiting')}</th><th className="text-end">{t('ops.col.active')}</th><th className="text-end">{t('ops.col.delayed')}</th><th className="text-end">{t('ops.col.failed')}</th><th className="text-start ps-4">{t('ops.col.worker')}</th><th className="text-start">{t('ops.col.data')}</th></tr></thead>
            <tbody>
              {o.queues.map((q) => (
                <tr key={q.queue} className="border-t" data-testid="ops-queue" data-queue={q.queue} data-source={q.source}>
                  <td className="py-1.5 font-mono text-xs">{q.queue}</td>
                  {(['waiting', 'active', 'delayed', 'failed'] as const).map((k) => <td key={k} className="text-end">{q.counts ? q.counts[k] : '—'}</td>)}
                  <td className={`ps-4 ${tone(q.worker.state)}`}>{t(`ops.state.${q.worker.state}`)}</td>
                  <td className="text-xs text-muted-foreground">{t(`ops.sourceLabel.${q.source}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">{t('ops.unavailableNote')}</p>
        </CardContent>
      </Card>

      <Card data-testid="ops-alerts">
        <CardHeader><CardTitle>{t('ops.alerts')}</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {alerts.data && alerts.data.items.length === 0 && <p className="text-sm text-muted-foreground">{t('ops.noAlerts')}</p>}
          <ul className="grid gap-2">
            {alerts.data?.items.map((a) => (
              <li key={a.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="ops-alert" data-status={a.status}>
                <p className="font-medium">{t(`ops.alertStatus.${a.status}`)} · <span className="font-mono text-xs">{a.queue}</span></p>
                <p className="text-xs text-muted-foreground">{t('ops.alertDetail', { observed: a.observed, threshold: a.threshold, count: a.occurrences, since: fmt(a.firstSeenAt) })}</p>
                {canManage && a.status !== 'RESOLVED' && (
                  <div className="mt-2 flex gap-2">
                    {a.status === 'OPEN' && <Button size="sm" variant="outline" onClick={() => void act(`k${a.id}`, `/alerts/${a.id}/acknowledge`, 'POST')} disabled={busy !== null} data-testid="ops-ack">{spin(`k${a.id}`)}{t('ops.acknowledge')}</Button>}
                    <Button size="sm" onClick={() => void act(`r${a.id}`, `/alerts/${a.id}/resolve`, 'POST')} disabled={busy !== null} data-testid="ops-resolve">{spin(`r${a.id}`)}{t('ops.resolve')}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {alerts.data && alerts.data.pageCount > 1 && <Pagination page={alerts.data.page} pageCount={alerts.data.pageCount} total={alerts.data.total} onPage={setAlertPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.pageOf', { page: alerts.data.page, pages: alerts.data.pageCount }) }} />}
        </CardContent>
      </Card>

      <Card data-testid="ops-rule">
        <CardHeader><CardTitle>{t('ops.rule')}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p className="text-muted-foreground">{t('ops.ruleHint', { threshold: global?.threshold ?? '—' })}</p>
          {canManage && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const n = Number(threshold); if (Number.isInteger(n) && n >= 1) void act('rule', '/alert-rules', 'PUT', { queue: null, threshold: n, enabled: true }); }}>
              <label className="grid gap-1 text-xs">{t('ops.threshold')}<Input type="number" min={1} max={100000} value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-32" data-testid="ops-threshold" /></label>
              <Button type="submit" size="sm" disabled={busy !== null || !threshold} data-testid="ops-save-rule">{spin('rule')}{t('ops.saveRule')}</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
