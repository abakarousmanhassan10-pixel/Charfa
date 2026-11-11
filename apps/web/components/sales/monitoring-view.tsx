'use client';
import { useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { useResource } from '@/lib/use-resource';

export interface Monitoring {
  days: number;
  health: { status: 'NOT_CONFIGURED' | 'IDLE' | 'OK' | 'DEGRADED' | 'DOWN'; recentCalls: number; recentFailures: number; lastErrorKind: string | null; provider: string; providerConfigured: boolean };
  ai: { calls: number; failures: number; failureRate: number | null; failuresByKind: Record<string, number>; retriesAndRepairs: number; latencyMs: { p50: number | null; p95: number | null; max: number | null }; tokens: { input: number; output: number }; costUsd: number | null; costConfigured: boolean; byModel: Array<{ model: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number | null }> };
  handoffs: { total: number; rate: number | null; byReason: Record<string, number>; aiUnavailable: number };
  drafts: { total: number; approved: number; rejected: number; pending: number; approvalRate: number | null; heldBecauseOfConfidence: number };
  confidence: Record<string, number>;
  conversations: number;
}

export function HealthBadge({ status }: { status: Monitoring['health']['status'] }) {
  const { t } = useI18n();
  const v = status === 'OK' ? 'success' : status === 'DEGRADED' || status === 'DOWN' ? 'warning' : 'muted';
  return <Badge variant={v} data-health={status} data-testid="health-badge">{t(`sales.monitoring.health.${status}`)}</Badge>;
}

const ms = (v: number | null) => (v === null ? '—' : `${v} ms`);

/** AI health and usage of this business: calls, failures, latency, tokens, cost, handoffs and draft approval. No message content. */
export function MonitoringView() {
  const { t } = useI18n();
  const { active } = useBusiness();
  const [days, setDays] = useState(7);
  const res = useResource<Monitoring>(`/sales/monitoring?days=${days}`, active?.id);
  if (res.loading && !res.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (res.error && !res.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void res.reload()} />;
  const m = res.data!;
  const tiles: Array<[string, string | number]> = [
    ['calls', m.ai.calls], ['failures', m.ai.failures], ['failureRate', m.ai.failureRate === null ? '—' : `${m.ai.failureRate}%`], ['p50', ms(m.ai.latencyMs.p50)], ['p95', ms(m.ai.latencyMs.p95)],
    ['tokens', (m.ai.tokens.input + m.ai.tokens.output).toLocaleString()], ['cost', m.ai.costUsd === null ? t('sales.monitoring.costUnknown') : `$${m.ai.costUsd.toFixed(4)}`], ['handoffRate', m.handoffs.rate === null ? '—' : `${m.handoffs.rate}%`],
  ];
  const list = (data: Record<string, number>, label: (k: string) => string) => {
    const e = Object.entries(data).sort((a, b) => b[1] - a[1]);
    return e.length ? <ul className="grid gap-1 text-sm">{e.map(([k, v]) => <li key={k} className="flex justify-between"><span>{label(k)}</span><span className="font-medium">{v}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">—</p>;
  };
  return (
    <div className="grid gap-6" data-testid="monitoring">
      <div className="flex flex-wrap items-end gap-4">
        <div className="rounded-xl border px-4 py-3"><p className="text-xs text-muted-foreground">{t('sales.monitoring.status')}</p><p className="mt-1"><HealthBadge status={m.health.status} /></p>{m.health.lastErrorKind && <p className="mt-1 text-xs text-muted-foreground">{t('sales.monitoring.lastError', { kind: t(`sales.monitoring.errorKinds.${m.health.lastErrorKind}`) })}</p>}</div>
        <div className="w-44"><label htmlFor="mon-days" className="mb-1 block text-xs font-medium text-muted-foreground">{t('sales.analytics.period')}</label><Select id="mon-days" value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="monitoring-days">{[1, 7, 30].map((d) => <option key={d} value={d}>{t('sales.analytics.lastDays', { days: d })}</option>)}</Select></div>
      </div>
      {m.health.status === 'NOT_CONFIGURED' && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="monitoring-not-configured">{t('sales.monitoring.notConfigured')}</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="monitoring-tiles">{tiles.map(([k, v]) => <div key={k} className="rounded-xl border p-4" data-stat={k}><p className="text-xs text-muted-foreground">{t(`sales.monitoring.tiles.${k}`)}</p><p className="mt-1 text-xl font-bold">{v}</p></div>)}</div>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Card><CardHeader><CardTitle>{t('sales.monitoring.failuresByKind')}</CardTitle></CardHeader><CardContent>{list(m.ai.failuresByKind, (k) => t(`sales.monitoring.errorKinds.${k}`))}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.analytics.handoffReasons')}</CardTitle></CardHeader><CardContent>{list(m.handoffs.byReason, (k) => t(`sales.handoffReasons.${k}`))}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.monitoring.confidence')}</CardTitle></CardHeader><CardContent>{list(m.confidence, (k) => (k === 'UNKNOWN' ? t('sales.analytics.unknown') : t(`sales.confidence.${k}`)))}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t('sales.monitoring.drafts')}</CardTitle></CardHeader><CardContent><dl className="grid gap-1 text-sm">{(['total', 'approved', 'rejected', 'pending', 'heldBecauseOfConfidence'] as const).map((k) => <div key={k} className="flex justify-between"><dt>{t(`sales.monitoring.draftStats.${k}`)}</dt><dd className="font-medium">{m.drafts[k]}</dd></div>)}<div className="flex justify-between"><dt>{t('sales.monitoring.draftStats.approvalRate')}</dt><dd className="font-medium" data-testid="approval-rate">{m.drafts.approvalRate === null ? '—' : `${m.drafts.approvalRate}%`}</dd></div></dl></CardContent></Card>
        <Card className="md:col-span-2"><CardHeader><CardTitle>{t('sales.monitoring.models')}</CardTitle></CardHeader><CardContent>{m.ai.byModel.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : <ul className="grid gap-1 text-sm">{m.ai.byModel.map((x) => <li key={x.model} className="flex flex-wrap justify-between gap-2"><span className="font-mono text-xs">{x.model}</span><span>{x.calls} · {(x.tokensIn + x.tokensOut).toLocaleString()} tok · {x.costUsd === null ? t('sales.monitoring.costUnknown') : `$${x.costUsd.toFixed(4)}`}</span></li>)}</ul>}{!m.ai.costConfigured && <p className="mt-2 text-xs text-muted-foreground">{t('sales.monitoring.costHint')}</p>}</CardContent></Card>
      </div>
      <p className="text-xs text-muted-foreground">{t('sales.monitoring.note')}</p>
    </div>
  );
}
