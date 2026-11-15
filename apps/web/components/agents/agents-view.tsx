'use client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';

interface AgentRow { id: string; type: string; label: string; name: string; enabled: boolean }
interface Catalog { types: Array<{ type: string; label: string; role: string; allowedByPlan: boolean }>; templates: Array<{ name: string; agents: string[] }> }
interface TaskRow { id: string; template: string; state: string; errorCode: string | null; topic: string | null; createdAt: string }
interface Approval { id: string; status: string; channel: string; contentHash: string; upToDate: boolean; content: { title: string | null; body: string | null; version: number } | null }
interface Usage { period: { start: string; end: string }; plan: string | null; access: { state: string; hasAccess: boolean }; calls: { used: number; reserved: number; limit: number | null; remaining: number | null }; budget: { usedMicros: number; limitMicros: number | null; remainingMicros: number | null; currency: string }; stopped: { scope: string } | null }
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

/** Customer view of the AI agents: agents, tasks and their states, approval queue (approve the exact version you read), consumption and remaining quotas. Everything is simulated until a real provider is enabled. */
export function AgentsView() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const biz = active?.id;
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [topic, setTopic] = useState('');
  const [template, setTemplate] = useState('agents-research-brief');
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!biz) return;
    try {
      const [a, c, tk, ap, u] = await Promise.all([
        api<AgentRow[]>('/agents', { businessId: biz }), api<Catalog>('/agents/catalog', { businessId: biz }), api<{ items: TaskRow[] }>('/agents/tasks', { businessId: biz }),
        api<Approval[]>('/agents/approvals?status=PENDING', { businessId: biz }), api<Usage>('/agents/usage', { businessId: biz }),
      ]);
      setAgents(a); setCatalog(c); setTasks(tk.items); setApprovals(ap); setUsage(u);
    } catch (e) { if (e instanceof ApiError && e.status === 404) setNotEnabled(true); else setError(e instanceof ApiError ? e.message : 'error'); }
  }, [biz]);
  useEffect(() => { void load(); const i = setInterval(() => void load(), 4000); return () => clearInterval(i); }, [load]);
  async function run<T>(fn: () => Promise<T>) { setBusy(true); setError(null); try { await fn(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'error'); } finally { setBusy(false); } }
  if (notEnabled) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="agents-disabled">{t('agents.notEnabled')}</p>;
  if (!usage || !catalog) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const canManage = can('agents.manage'), canRun = can('agents.run'), canApprove = can('agents.approve');
  const missing = catalog.types.filter((ty) => !agents.some((a) => a.type === ty.type && a.enabled) && ty.allowedByPlan);
  return (
    <div className="grid gap-4" data-testid="agents-view">
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="agents-simulated">{t('agents.simulatedNote')}</p>
      {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert" data-testid="agents-error">{error}</p>}
      {usage.stopped && <p className="rounded-md border border-destructive/40 p-3 text-sm" role="alert" data-testid="agents-stopped">{t('agents.stopped')}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-2xl font-bold" data-testid="agents-calls">{usage.calls.used}{usage.calls.limit != null ? ` / ${usage.calls.limit}` : ''}</p><p className="text-xs text-muted-foreground">{t('agents.calls')}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-2xl font-bold" data-testid="agents-budget">{usd(usage.budget.usedMicros)}{usage.budget.limitMicros != null ? ` / ${usd(usage.budget.limitMicros)}` : ''}</p><p className="text-xs text-muted-foreground">{t('agents.budget')}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-2xl font-bold" data-testid="agents-access">{usage.access.state}</p><p className="text-xs text-muted-foreground">{t('agents.access')} · {usage.plan ?? '—'}</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>{t('agents.agents')}</CardTitle><CardDescription>{t('agents.agentsHelp')}</CardDescription></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {agents.length === 0 && <p className="text-muted-foreground">{t('agents.noAgents')}</p>}
          {agents.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2" data-testid="agent-row">
              <span>{a.label} · {a.name} {!a.enabled && <em className="text-muted-foreground">({t('agents.disabled')})</em>}</span>
              {canManage && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/agents/${a.id}/${a.enabled ? 'disable' : 'enable'}`, { method: 'POST', businessId: biz, json: {} }))}>{a.enabled ? t('agents.disable') : t('agents.enable')}</Button>}
            </div>
          ))}
          {canManage && missing.map((ty) => (
            <Button key={ty.type} size="sm" variant="secondary" disabled={busy} data-testid={`agent-create-${ty.type}`} onClick={() => run(() => api('/agents', { method: 'POST', businessId: biz, json: { type: ty.type, name: ty.label } }))}>{t('agents.create')} {ty.label}</Button>
          ))}
        </CardContent>
      </Card>
      {canRun && (
        <Card>
          <CardHeader><CardTitle>{t('agents.newTask')}</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={template} onChange={(e) => setTemplate(e.target.value)} aria-label={t('agents.template')} data-testid="task-template">
              {catalog.templates.map((tp) => <option key={tp.name} value={tp.name}>{tp.name}</option>)}
            </select>
            <input className="h-9 min-w-48 flex-1 rounded-md border bg-background px-2 text-sm" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} placeholder={t('agents.topic')} aria-label={t('agents.topic')} data-testid="task-topic" />
            <Button disabled={busy || !topic.trim()} data-testid="task-create" onClick={() => run(async () => { await api('/agents/tasks', { method: 'POST', businessId: biz, json: { template, topic }, headers: { 'Idempotency-Key': crypto.randomUUID() } }); setTopic(''); })}>{t('agents.run')}</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>{t('agents.approvals')}</CardTitle><CardDescription>{t('agents.approvalsHelp')}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {approvals.length === 0 && <p className="text-muted-foreground" data-testid="approvals-empty">{t('agents.noApprovals')}</p>}
          {approvals.map((a) => (
            <div key={a.id} className="rounded-md border p-3" data-testid="approval-row">
              <p className="font-medium">{a.content?.title} <span className="text-xs text-muted-foreground">v{a.content?.version} · {a.channel}</span></p>
              <p className="my-2 whitespace-pre-wrap">{a.content?.body}</p>
              {canApprove && (
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || !a.upToDate} data-testid="approval-approve" onClick={() => run(() => api(`/agents/approvals/${a.id}/approve`, { method: 'POST', businessId: biz, json: { contentHash: a.contentHash } }))}>{t('agents.approve')}</Button>
                  <Button size="sm" variant="outline" disabled={busy} data-testid="approval-reject" onClick={() => run(() => api(`/agents/approvals/${a.id}/reject`, { method: 'POST', businessId: biz, json: {} }))}>{t('agents.reject')}</Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('agents.tasks')}</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {tasks.length === 0 && <p className="text-muted-foreground">{t('agents.noTasks')}</p>}
          {tasks.map((tk) => (
            <div key={tk.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="task-row">
              <span>{tk.topic ?? tk.template}</span>
              <span className="flex items-center gap-2"><span className="rounded bg-muted px-1.5 py-0.5 text-xs" data-testid="task-state">{tk.state}</span>
                {canRun && ['FAILED', 'BLOCKED'].includes(tk.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/agents/tasks/${tk.id}/retry`, { method: 'POST', businessId: biz, json: {} }))}>{t('agents.retry')}</Button>}
                {canRun && ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'].includes(tk.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/agents/tasks/${tk.id}/cancel`, { method: 'POST', businessId: biz, json: {} }))}>{t('agents.cancel')}</Button>}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
