'use client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';

interface Overview {
  simulated: boolean; period: { from: string; to: string };
  customers: Array<{ id: string; name: string }>; simulatedSubscriptions: Array<{ status: string; count: number }>;
  agents: Array<{ type: string; enabled: boolean; count: number }>; tasks: Record<string, number>; approvalsWaiting: number;
  usage: { calls?: number; estimated: boolean; note: string; byAgent?: unknown[]; byModel?: unknown[] } & Record<string, unknown>;
  controls: Array<{ id: string; scope: string; scopeId: string; reason: string | null }>;
  alerts: Array<{ kind: string; count: number }>; events: Array<{ id: string; action: string; businessId: string | null; createdAt: string }>;
}
const STATES = ['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED'];

/** Admin control center: customers, simulated subscriptions, agents, tasks by state, estimated consumption, alerts, events, filters and the stop controls. */
export function AgentsAdminView({ canStop = false }: { canStop?: boolean }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [businessId, setBusinessId] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    const from = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
    api<Overview>(`/admin/agents/overview?from=${encodeURIComponent(from)}${businessId ? `&businessId=${businessId}` : ''}`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e instanceof ApiError ? e : null));
  }, [businessId, days]);
  useEffect(() => { load(); }, [load]);
  async function control(path: 'stop' | 'resume', body: object) { setBusy(true); try { await api(`/admin/agents/${path}`, { method: 'POST', json: body }); load(); } finally { setBusy(false); } }
  if (err) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="agents-admin-error">{err.status === 404 ? t('agents.notEnabled') : t('agents.loadFailed')}</p>;
  if (!data) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const globalStopped = data.controls.some((c) => c.scope === 'GLOBAL');
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <div className="grid gap-4" data-testid="agents-admin">
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{data.usage.note}</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label>{t('agents.admin.customer')} <select className="h-9 rounded-md border bg-background px-2" value={businessId} onChange={(e) => setBusinessId(e.target.value)} data-testid="admin-filter-customer"><option value="">{t('agents.admin.all')}</option>{data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>{t('agents.admin.period')} <select className="h-9 rounded-md border bg-background px-2" value={days} onChange={(e) => setDays(e.target.value)} data-testid="admin-filter-period">{['1', '7', '30', '90'].map((d) => <option key={d} value={d}>{d}d</option>)}</select></label>
        {canStop && (globalStopped
          ? <Button size="sm" disabled={busy} data-testid="admin-resume-all" onClick={() => control('resume', { scope: 'GLOBAL' })}>{t('agents.admin.resumeAll')}</Button>
          : <Button size="sm" className="bg-red-600 text-white hover:bg-red-700" disabled={busy} data-testid="admin-stop-all" onClick={() => control('stop', { scope: 'GLOBAL', reason: 'admin', cancelPending: true })}>{t('agents.admin.stopAll')}</Button>)}
        {canStop && businessId && <Button size="sm" variant="outline" disabled={busy} onClick={() => control('stop', { scope: 'TENANT', scopeId: businessId, reason: 'admin', cancelPending: true })}>{t('agents.admin.stopTenant')}</Button>}
      </div>
      {data.alerts.length > 0 && <Card><CardHeader><CardTitle>{t('agents.admin.alerts')}</CardTitle></CardHeader><CardContent className="grid gap-1 text-sm">{data.alerts.map((a) => <p key={a.kind} data-testid="admin-alert">{a.kind} · {a.count}</p>)}</CardContent></Card>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STATES.map((s) => <Card key={s}><CardContent className="p-4"><p className="text-2xl font-bold" data-testid={`admin-tasks-${s}`}>{data.tasks[s] ?? 0}</p><p className="text-xs text-muted-foreground">{s}</p></CardContent></Card>)}
        <Card><CardContent className="p-4"><p className="text-2xl font-bold" data-testid="admin-approvals">{data.approvalsWaiting}</p><p className="text-xs text-muted-foreground">{t('agents.approvals')}</p></CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>{t('agents.admin.subscriptions')}</CardTitle><CardDescription>{t('agents.admin.simulated')}</CardDescription></CardHeader><CardContent className="grid gap-1 text-sm">{data.simulatedSubscriptions.map((s) => <p key={s.status}>{s.status} · {s.count}</p>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>{t('agents.agents')}</CardTitle></CardHeader><CardContent className="grid gap-1 text-sm">{data.agents.map((a, i) => <p key={i}>{a.type} {a.enabled ? '' : `(${t('agents.disabled')})`} · {a.count}</p>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>{t('agents.admin.events')}</CardTitle></CardHeader><CardContent className="grid gap-1 text-sm">{data.events.map((e) => <p key={e.id}>{fmt(e.createdAt)} · {e.action}</p>)}{data.events.length === 0 && <p className="text-muted-foreground">—</p>}</CardContent></Card>
    </div>
  );
}
