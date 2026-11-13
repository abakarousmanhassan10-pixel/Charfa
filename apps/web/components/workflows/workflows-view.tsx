'use client';
import { useEffect, useRef, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError, api } from '@/lib/api-client';
import { useResource, type Paged } from '@/lib/use-resource';

interface Workflow {
  id: string;
  name: string;
  currentVersion: number;
  isActive: boolean;
}
interface StepView {
  key: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
}
interface RunView {
  id: string;
  status: string;
  errorCode: string | null;
  createdAt: string;
  workflowVersion: number | null;
  deadLetteredAt: string | null;
  steps: StepView[];
}

const BUSY = ['PENDING', 'RUNNING'];
const OPEN = ['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED'];
const variant = (s: string) => (s === 'COMPLETED' ? 'success' : s === 'FAILED' || s === 'WAITING_APPROVAL' ? 'warning' : s === 'PAUSED' || s === 'CANCELLED' || s === 'SKIPPED' ? 'muted' : 'default') as 'success' | 'warning' | 'muted' | 'default';

/** The demonstration workflow: product analysis → content draft → human approval → calendar scheduling (every adapter is a simulation). */
const DEMO = {
  triggers: [{ type: 'manual' }],
  input: { topic: { type: 'string', required: true, maxLength: 200 } },
  steps: [
    { key: 'product_analysis', adapter: 'simulated.product-analysis' },
    { key: 'content_draft', adapter: 'simulated.content-draft', dependsOn: ['product_analysis'] },
    { key: 'calendar_schedule', adapter: 'simulated.calendar-schedule', dependsOn: ['content_draft'], requiresApproval: true },
  ],
};

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

/** Workflows: list, activate, start, and follow each execution step by step with the approval and recovery controls. */
export function WorkflowsView() {
  const { t } = useI18n();
  const { active } = useBusiness();
  const canManage = active?.role === 'OWNER' || active?.role === 'ADMIN'; // the API enforces this; the UI only hides what would be refused
  const list = useResource<Paged<Workflow>>('/workflows?pageSize=50', active?.id);
  const [selected, setSelected] = useState<string | null>(null);
  const execs = useResource<Paged<RunView>>(selected ? `/workflows/${selected}/executions?pageSize=10` : null, active?.id);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow executions that are still moving.
  // Also while an opened panel is still empty: the first execution is started right after the panel opens, and the list that was
  // fetched at that moment can be older than the new run (it would otherwise stay empty until the panel is reopened).
  const moving = (execs.data?.items.some((r) => BUSY.includes(r.status)) ?? false) || (selected !== null && execs.data !== null && execs.data.items.length === 0);
  const reloadExecs = execs.reload;
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => void reloadExecs(), 2500);
    return () => clearInterval(id);
  }, [moving, reloadExecs]);

  // A double click fires two clicks before React disables the button: the ref blocks the second one at once.
  const inflight = useRef(false);
  async function act(path: string, json?: unknown) {
    if (!active || inflight.current) return;
    inflight.current = true;
    setBusy(path);
    setError(null);
    try {
      await api(path, { method: 'POST', businessId: active.id, ...(json !== undefined ? { json } : {}), headers: path.endsWith('/executions') ? { 'Idempotency-Key': newKey() } : undefined });
      await Promise.all([list.reload(), selected ? execs.reload() : Promise.resolve()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('workflows.error'));
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }

  async function createDemo() {
    if (!active) return;
    setBusy('demo');
    setError(null);
    try {
      await api('/workflows', { method: 'POST', businessId: active.id, json: { name: t('workflows.demoName'), definition: DEMO } });
      await list.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('workflows.error'));
    } finally {
      setBusy(null);
    }
  }

  if (list.error instanceof ApiError && list.error.status === 404) return <EmptyState title={t('workflows.disabled')} />;
  if (list.error) return <ErrorState message={t('workflows.error')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} />;
  if (!list.data) return <LoadingRows rows={3} label={t('common.loading')} />;

  const statusLabel = (s: string) => t(`workflows.status.${s}`);

  return (
    <div className="grid gap-4" data-testid="workflows">
      <p className="text-sm text-muted-foreground">{t('workflows.simulated')}</p>
      {error && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {error}
        </div>
      )}
      {list.data.items.length === 0 ? (
        <EmptyState title={t('workflows.none')} action={canManage ? <Button onClick={() => void createDemo()} disabled={busy === 'demo'}>{t('workflows.createDemo')}</Button> : undefined} />
      ) : (
        list.data.items.map((w) => (
          <Card key={w.id} data-testid="workflow-card">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">{w.name}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="muted">{t('workflows.version')} {w.currentVersion}</Badge>
                <Badge variant={w.isActive ? 'success' : 'muted'}>{w.isActive ? t('workflows.active') : t('workflows.inactive')}</Badge>
                {canManage && (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/workflows/${w.id}/${w.isActive ? 'deactivate' : 'activate'}`)}>
                    {w.isActive ? t('workflows.deactivate') : t('workflows.activate')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setSelected(selected === w.id ? null : w.id)}>
                  {selected === w.id ? t('workflows.hideExecutions') : t('workflows.showExecutions')}
                </Button>
              </div>
            </CardHeader>
            {w.isActive && (
              <CardContent className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1 text-sm">
                  {t('workflows.topic')}
                  <Input value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} placeholder={t('workflows.topicPlaceholder')} />
                </label>
                <Button disabled={busy !== null || !topic.trim()} onClick={() => { setSelected(w.id); void act(`/workflows/${w.id}/executions`, { input: { topic: topic.trim() } }); }}>
                  {t('workflows.start')}
                </Button>
              </CardContent>
            )}
            {selected === w.id && (
              <CardContent className="grid gap-3" data-testid="executions">
                <h3 className="text-sm font-semibold">{t('workflows.executions')}</h3>
                {!execs.data ? (
                  <LoadingRows rows={2} label={t('common.loading')} />
                ) : execs.data.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('workflows.noExecutions')}</p>
                ) : (
                  execs.data.items.map((r) => (
                    <div key={r.id} className="grid gap-2 rounded-md border p-3" data-testid="execution">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={variant(r.status)}>{statusLabel(r.status)}</Badge>
                          <span className="text-xs text-muted-foreground">v{r.workflowVersion} · {new Date(r.createdAt).toLocaleString()}</span>
                          {r.deadLetteredAt && <span className="text-xs text-muted-foreground">{t('workflows.deadLetter')}</span>}
                        </div>
                        {canManage && (
                          <div className="flex flex-wrap gap-2">
                            {['PENDING', 'RUNNING', 'WAITING_APPROVAL'].includes(r.status) && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/pause`)}>{t('workflows.pause')}</Button>}
                            {r.status === 'PAUSED' && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/resume`)}>{t('workflows.resume')}</Button>}
                            {OPEN.includes(r.status) && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/cancel`)}>{t('workflows.cancel')}</Button>}
                            {r.status === 'FAILED' && <Button size="sm" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/retry`)}>{t('workflows.retry')}</Button>}
                          </div>
                        )}
                      </div>
                      <ol className="grid gap-1 text-sm">
                        {r.steps.map((s) => (
                          <li key={s.key} className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs">{s.key}</span>
                            <Badge variant={variant(s.status)}>{statusLabel(s.status)}</Badge>
                            {s.attempts > 1 && <span className="text-xs text-muted-foreground">{s.attempts}/{s.maxAttempts} {t('workflows.attempts')}</span>}
                            {s.status === 'WAITING_APPROVAL' && (
                              <>
                                <span className="text-xs text-muted-foreground">{t('workflows.needsApproval')}</span>
                                {canManage && (
                                  <>
                                    <Button size="sm" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/steps/${s.key}/approve`)}>{t('workflows.approve')}</Button>
                                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/steps/${s.key}/reject`)}>{t('workflows.reject')}</Button>
                                  </>
                                )}
                              </>
                            )}
                            {s.status === 'FAILED' && s.errorCode === 'OUTCOME_UNKNOWN' && (
                              <>
                                <span className="text-xs">{t('workflows.outcomeUnknown')}</span>
                                {canManage && (
                                  <>
                                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/steps/${s.key}/resolve`, { resolution: 'EXECUTED' })}>{t('workflows.resolveExecuted')}</Button>
                                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(`/runs/${r.id}/steps/${s.key}/resolve`, { resolution: 'NOT_EXECUTED' })}>{t('workflows.resolveNotExecuted')}</Button>
                                  </>
                                )}
                              </>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))
                )}
              </CardContent>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
