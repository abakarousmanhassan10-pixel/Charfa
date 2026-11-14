'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError, api } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

interface Overview {
  simulatedPlatforms: boolean;
  campaigns: { byStatus: Record<string, number>; recent: Array<{ id: string; name: string; status: string; paused: boolean }> };
  pendingApprovals: number;
  agentActivity: { last7Days: Record<string, number> };
  experiments: Array<{ id: string; hypothesis: string; status: string; verdict: string | null; origin: string | null }>;
  recommendations: Array<{ id: string; kind: string; title: string; priority: number }>;
  alerts: Array<{ id: string; kind: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; occurrences: number }>;
  cost: { usedMicros: number; limitMicros: number; executionsUsed: number; executionLimit: number };
  quotas: { publicationsToday: number; publicationsMax: number; repliesToday: number; repliesMax: number };
  metricsOrigin: { publishedSimulated: number; publishedReal: number; publicationsTotal: number };
}
const SEV = { CRITICAL: 'warning', WARNING: 'warning', INFO: 'muted' } as const;

/** Business control center (N21). Reads and proposes; the merchant decides. Simulated and real data are labelled apart. */
export function IntelligenceView() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const o = useResource<Overview>('/intelligence/overview', active?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const analyst = can('ai.use');
  const admin = can('content.approve');

  async function act(path: string, label: string) {
    if (!active) return;
    setBusy(label); setError(null); setNote(null);
    try {
      const r = await api<Record<string, unknown>>(`/intelligence${path}`, { method: 'POST', json: {}, businessId: active.id });
      if (label === 'evaluate') setNote(t('intelligence.evaluated', { score: String((r.suites as Array<{ score: number }>).map((s) => s.score).join(' / ')) }));
      await o.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally { setBusy(null); }
  }
  const btn = (path: string, label: string, enabled: boolean) => <Button size="sm" variant="outline" disabled={!enabled || busy !== null} onClick={() => void act(path, label)} data-testid={`act-${label}`}>{busy === label && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t(`intelligence.actions.${label}`)}</Button>;

  if (o.loading && !o.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (o.error && !o.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void o.reload()} />;
  const d = o.data!;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return (
    <div className="grid gap-6" data-testid="intelligence">
      <p className={`rounded-md px-3 py-2 text-sm ${d.simulatedPlatforms ? 'bg-amber-500/10' : 'bg-emerald-500/10'}`} data-testid="data-origin">
        {d.simulatedPlatforms ? t('intelligence.simulated') : t('intelligence.real')} {t('intelligence.origin', { sim: d.metricsOrigin.publishedSimulated, real: d.metricsOrigin.publishedReal })}
      </p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {note && <p className="text-sm" data-testid="eval-note">{note}</p>}
      <div className="flex flex-wrap gap-2">
        {btn('/alerts/scan', 'scan', analyst)}
        {btn('/recommendations/generate', 'generate', analyst)}
        {btn('/evaluations/run', 'evaluate', analyst)}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>{t('intelligence.campaigns')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm" data-testid="campaigns-card">
          <p>{Object.entries(d.campaigns.byStatus).map(([s, n]) => `${t(`campaigns.status.${s}`)}: ${n}`).join(' · ') || t('intelligence.none')}</p>
          <ul>{d.campaigns.recent.map((c) => <li key={c.id}>{c.name} <Badge variant="muted">{t(`campaigns.status.${c.status}`)}</Badge>{c.paused && <> <Badge variant="warning">{t('campaigns.paused')}</Badge></>}</li>)}</ul>
          <Link href="/dashboard/campaigns" className="text-primary underline-offset-2 hover:underline">{t('intelligence.openCampaigns')}</Link>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('intelligence.approvals')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm" data-testid="approvals-card">
          <p><span className="text-2xl font-semibold" data-testid="pending-count">{d.pendingApprovals}</span> {t('intelligence.pending')}</p>
          <Link href="/dashboard/calendar/approvals" className="text-primary underline-offset-2 hover:underline">{t('intelligence.openApprovals')}</Link>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('intelligence.alerts')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="alerts-card">
          {d.alerts.length === 0 ? <p className="text-muted-foreground">{t('intelligence.noAlerts')}</p> : <ul className="grid gap-1">{d.alerts.map((a) => <li key={a.id} data-severity={a.severity}><Badge variant={SEV[a.severity]}>{t(`intelligence.severity.${a.severity}`)}</Badge> {a.title}{a.occurrences > 1 && <span className="text-muted-foreground"> ×{a.occurrences}</span>}</li>)}</ul>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('intelligence.recommendations')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="recs-card">
          {d.recommendations.length === 0 ? <p className="text-muted-foreground">{t('intelligence.noRecs')}</p> : <ul className="grid gap-2">{d.recommendations.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2" data-kind={r.kind}><span className="flex-1">{r.title}</span><Badge variant="muted">{r.priority}</Badge>
              {admin && <><Button size="sm" disabled={busy !== null} onClick={() => void act(`/recommendations/${r.id}/approve`, 'approve')}>{t('intelligence.approve')}</Button><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(`/recommendations/${r.id}/reject`, 'reject')}>{t('intelligence.reject')}</Button></>}
            </li>))}</ul>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('intelligence.experiments')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="experiments-card">
          {d.experiments.length === 0 ? <p className="text-muted-foreground">{t('intelligence.noExperiments')}</p> : <ul className="grid gap-2">{d.experiments.map((e) => <li key={e.id}>{e.hypothesis}<br /><Badge variant="muted">{e.verdict ? t(`intelligence.verdict.${e.verdict}`) : e.status}</Badge>{e.origin && <> <Badge variant={e.origin === 'REAL' ? 'success' : 'warning'}>{t(`intelligence.origins.${e.origin}`)}</Badge></>}</li>)}</ul>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('intelligence.agents')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="agents-card">
          <p>{Object.entries(d.agentActivity.last7Days).map(([s, n]) => `${s}: ${n}`).join(' · ') || t('intelligence.none')}</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('intelligence.costQuota')}</CardTitle></CardHeader><CardContent className="grid gap-1 text-sm" data-testid="cost-card">
          <p>{t('intelligence.cost', { usd: (d.cost.usedMicros / 1_000_000).toFixed(2), limit: (d.cost.limitMicros / 1_000_000).toFixed(2) })}</p>
          <p>{t('intelligence.executions', { used: d.cost.executionsUsed, max: d.cost.executionLimit })}</p>
          <p>{t('intelligence.publications', { used: d.quotas.publicationsToday, max: d.quotas.publicationsMax, pct: pct(d.quotas.publicationsToday, d.quotas.publicationsMax) })}</p>
          <p>{t('intelligence.replies', { used: d.quotas.repliesToday, max: d.quotas.repliesMax })}</p>
        </CardContent></Card>
      </div>
    </div>
  );
}
