'use client';
import { useCallback, useEffect, useState } from 'react';
import { AlertOctagon, CheckCircle2, Circle, Loader2, OctagonX, Play, RotateCw, XCircle } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { CampaignBuilder, type CampaignForm } from '@/components/creative/campaign-builder';
import { CreativeSection } from '@/components/creative/creative-section';
import { DailyQuota, useDailyQuota } from '@/components/creative/daily-quota';
import { CreativeError } from '@/components/creative/job';
import { StudioMedia } from '@/components/creative/studio-media';
import { useCreativeStatus } from '@/components/creative/use-creative';
import { useI18n } from '@/components/i18n-provider';
import type { MediaItem } from '@/components/media/media-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

interface Overview {
  mode: 'SIMULATION'; campaigns: { total: number; byStatus: Record<string, number> }; media: { photos: number; videos: number };
  tasks: { running: number; completed: number; failed: number }; posts: { scheduledSimulated: number; publishedSimulated: number; waitingApproval: number };
  waitingApproval: Array<{ id: string; campaignId: string; campaignName: string; platform: string; kind: string; scheduledAt: string; caption: string; contentHash: string; reasons: Array<{ code: string; message: string }> }>;
  errors: Array<{ id: string; campaignName: string; type: string; detail: { agent?: string; code?: string; message?: string } | null; createdAt: string }>;
}
interface Summary { id: string; name: string; platform: string; publishMode: string; status: string; stopped: boolean; photoCount: number; videoCount: number; tasks: { total: number; done: number; failed: number }; posts: { total: number; waiting: number } }
interface Post { id: string; kind: string; caption: string; scheduledAt: string; status: string; requestedMode: string; effectiveMode: string; risk: string; reasons: Array<{ code: string; message: string }>; contentHash: string; approved: boolean; media: MediaItem | null }
interface Detail extends Omit<Summary, 'tasks' | 'posts'> { tasks: Array<{ id: string; agent: string; label: string; itemIndex: number; status: string; errorCode: string | null; errorMessage: string | null; attempts: number }>; posts: Post[] }

const live = (s: string) => s === 'RUNNING';
const Step = ({ status }: { status: string }) => status === 'SUCCEEDED' ? <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden /> : status === 'RUNNING' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : status === 'FAILED' ? <XCircle className="h-4 w-4 text-destructive" aria-hidden /> : <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;

export default function CampaignControlCenter() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const quota = useDailyQuota();
  const status = useCreativeStatus();
  const free = status.data?.freeTestMode ?? false;
  const overview = useResource<Overview>('/creative/campaigns/overview', active?.id);
  const list = useResource<Summary[]>('/creative/campaigns', active?.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [edit, setEdit] = useState<{ id: string; caption: string } | null>(null);

  const loadDetail = useCallback(async (id: string) => { if (active) setDetail(await api<Detail>(`/creative/campaigns/${id}`, { businessId: active.id })); }, [active]);
  const reload = useCallback(() => { overview.reload(); list.reload(); quota.reload(); if (selected) void loadDetail(selected).catch(() => undefined); }, [overview, list, quota, selected, loadDetail]);
  useEffect(() => { setSelected(null); setDetail(null); }, [active?.id]);
  useEffect(() => { if (selected) void loadDetail(selected).catch(() => setDetail(null)); else setDetail(null); }, [selected, loadDetail]);
  // While something runs, follow it.
  const running = detail ? live(detail.status) : (list.data ?? []).some((c) => live(c.status));
  useEffect(() => { if (!running) return; const i = setInterval(reload, 1500); return () => clearInterval(i); }, [running, reload]);

  async function act<T>(fn: () => Promise<T>) {
    setBusy(true); setError(null);
    try { const r = await fn(); reload(); return r; } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e))); return null; } finally { setBusy(false); }
  }
  const post = (path: string, json?: unknown) => api<Detail>(`/creative/campaigns${path}`, { method: 'POST', json: json ?? {}, businessId: active!.id });
  async function create(f: CampaignForm) {
    const r = await act(() => api<Detail>('/creative/campaigns', { method: 'POST', json: f, businessId: active!.id }));
    if (r) setSelected(r.id);
    return !!r;
  }
  const o = overview.data;
  const stat = (k: string, v: number | string) => (<div key={k} className="rounded-xl border bg-card p-3" data-testid={`stat-${k}`}><p className="text-xs text-muted-foreground">{t(`creative.campaigns.stats.${k}`)}</p><p className="text-2xl font-semibold tabular-nums">{v}</p></div>);

  return (
    <CreativeSection title={t('creative.campaigns.title')} description={t('creative.campaigns.subtitle')}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm" role="note" data-testid="simulation-banner">
        <div className="min-w-0"><p className="font-semibold">{t('creative.campaigns.simTitle')}</p><p className="text-muted-foreground">{t('creative.campaigns.simText')}</p></div>
        {can('autopublish.manage') && <Button type="button" variant="outline" className="border-destructive text-destructive" disabled={busy} onClick={() => void act(() => post('/emergency-stop'))} data-testid="emergency-stop-all"><OctagonX className="h-4 w-4" aria-hidden />{t('creative.campaigns.stopAll')}</Button>}
      </div>
      {status.data && !free && <p className="mb-4 rounded-md border p-3 text-sm" role="alert">{t('creative.campaigns.liveMode')}</p>}
      <DailyQuota data={quota.data} />
      <CreativeError error={error} />

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7" aria-label={t('creative.campaigns.overview')}>
        {o && [stat('campaigns', o.campaigns.total), stat('photos', o.media.photos), stat('videos', o.media.videos), stat('running', o.tasks.running), stat('completed', o.tasks.completed), stat('scheduled', o.posts.scheduledSimulated), stat('waiting', o.posts.waitingApproval)]}
      </div>

      {free && can('ai.use') && <div className="mt-6"><CampaignBuilder canAuto={can('autopublish.manage')} disabled={busy} onCreate={create} /></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section aria-label={t('creative.campaigns.list')} className="grid content-start gap-2" data-testid="campaign-list">
          <h2 className="text-sm font-semibold">{t('creative.campaigns.list')}</h2>
          {list.data && list.data.length === 0 && <EmptyState title={t('creative.campaigns.emptyTitle')} hint={t('creative.campaigns.emptyText')} />}
          {(list.data ?? []).map((c) => (
            <button key={c.id} type="button" onClick={() => setSelected(c.id)} data-testid="campaign-row" className={`rounded-xl border p-3 text-left text-sm ${selected === c.id ? 'border-primary bg-primary/5' : ''}`}>
              <span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{c.name}</span><Badge>{t(`creative.campaigns.status.${c.status}`)}</Badge></span>
              <span className="mt-1 block text-xs text-muted-foreground">{c.platform} · {c.publishMode} · {c.photoCount}📷 {c.videoCount}🎬 · {c.tasks.done}/{c.tasks.total}</span>
            </button>
          ))}
        </section>

        <section aria-label={t('creative.campaigns.detail')} className="grid content-start gap-4" data-testid="campaign-detail">
          {!detail ? <EmptyState title={t('creative.campaigns.pickTitle')} hint={t('creative.campaigns.pickText')} /> : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{detail.name}</h2>
                <div className="flex flex-wrap gap-2">
                  <Badge data-testid="detail-status">{t(`creative.campaigns.status.${detail.status}`)}</Badge>
                  {detail.status === 'DRAFT' && <Button size="sm" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/start`))} data-testid="campaign-start"><Play className="h-4 w-4" aria-hidden />{t('creative.campaigns.startRun')}</Button>}
                  {detail.status === 'NEEDS_ATTENTION' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/retry`))} data-testid="campaign-retry"><RotateCw className="h-4 w-4" aria-hidden />{t('creative.campaigns.retry')}</Button>}
                  {detail.stopped && can('autopublish.manage') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/resume`))} data-testid="campaign-resume">{t('creative.campaigns.resume')}</Button>}
                  {!detail.stopped && !['CANCELLED'].includes(detail.status) && can('autopublish.manage') && detail.status !== 'DRAFT' && <Button size="sm" variant="outline" className="border-destructive text-destructive" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/emergency-stop`))} data-testid="campaign-stop"><AlertOctagon className="h-4 w-4" aria-hidden />{t('creative.campaigns.stop')}</Button>}
                  {!['CANCELLED', 'COMPLETED'].includes(detail.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/cancel`))} data-testid="campaign-cancel">{t('creative.campaigns.cancel')}</Button>}
                </div>
              </div>

              <ol className="grid gap-1 rounded-xl border p-3 text-sm" aria-label={t('creative.campaigns.tasks')} data-testid="campaign-tasks">
                {detail.tasks.map((x) => (
                  <li key={x.id} className="flex items-center gap-2" data-status={x.status}><Step status={x.status} /><span>{x.label}{['IMAGE', 'VIDEO'].includes(x.agent) ? ` #${x.itemIndex + 1}` : ''}</span><span className="text-xs text-muted-foreground">{t(`creative.campaigns.taskStatus.${x.status}`)}</span>{x.errorCode && <span className="text-xs text-destructive">{x.errorCode}</span>}</li>
                ))}
              </ol>

              <div className="grid gap-3" data-testid="campaign-posts">
                <h3 className="text-sm font-semibold">{t('creative.campaigns.posts')}</h3>
                {detail.posts.length === 0 && <p className="text-sm text-muted-foreground">{t('creative.campaigns.noPosts')}</p>}
                <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {detail.posts.map((p) => (
                    <li key={p.id} className="grid content-start gap-2 rounded-xl border p-3" data-testid="campaign-post" data-status={p.status}>
                      {p.media && <StudioMedia media={p.media} simulated ratio={p.media.width && p.media.height ? `${p.media.width}:${p.media.height}` : '1:1'} testid="post-media" />}
                      <div className="flex flex-wrap items-center gap-1 text-xs"><Badge variant={p.status === 'PENDING_APPROVAL' ? 'warning' : 'default'}>{t(`creative.campaigns.postStatus.${p.status}`)}</Badge><span className="text-muted-foreground">{new Date(p.scheduledAt).toLocaleString(locale)} · {p.effectiveMode}</span></div>
                      {edit?.id === p.id ? (
                        <div className="grid gap-2"><Textarea rows={3} value={edit.caption} maxLength={2200} onChange={(e) => setEdit({ id: p.id, caption: e.target.value })} aria-label={t('creative.campaigns.caption')} />
                          <div className="flex gap-2"><Button size="sm" disabled={busy || !edit.caption.trim()} onClick={() => void act(() => api<Detail>(`/creative/campaigns/${detail.id}/posts/${p.id}`, { method: 'PATCH', json: { caption: edit.caption }, businessId: active!.id }).then(() => setEdit(null)))}>{t('creative.campaigns.saveCaption')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('creative.studio.cancelEdit')}</Button></div></div>
                      ) : <p className="text-sm">{p.caption}</p>}
                      {p.reasons.length > 0 && <ul className="text-xs text-muted-foreground">{p.reasons.map((r) => <li key={r.code}>• {r.message}</li>)}</ul>}
                      <div className="flex flex-wrap gap-2">
                        {p.status === 'PENDING_APPROVAL' && can('content.approve') && <><Button size="sm" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/posts/${p.id}/approve`, { contentHash: p.contentHash }))} data-testid="post-approve">{t('creative.campaigns.approve')}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/posts/${p.id}/reject`))}>{t('creative.campaigns.reject')}</Button></>}
                        {['PENDING_APPROVAL', 'SIMULATED_SCHEDULED'].includes(p.status) && can('ai.use') && edit?.id !== p.id && <Button size="sm" variant="ghost" onClick={() => setEdit({ id: p.id, caption: p.caption })}>{t('creative.campaigns.editCaption')}</Button>}
                      </div>
                    </li>
                  ))}
                </ul>
                {can('publication.schedule') && detail.posts.some((p) => p.status === 'SIMULATED_SCHEDULED') && <div><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => post(`/${detail.id}/simulate-due`, { asOf: new Date(Date.now() + 365 * 86_400_000).toISOString() }))} data-testid="simulate-due">{t('creative.campaigns.simulatePublish')}</Button><p className="mt-1 text-xs text-muted-foreground">{t('creative.campaigns.simulatePublishHint')}</p></div>}
              </div>
            </>
          )}
        </section>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card><CardContent className="grid gap-2 p-4" data-testid="waiting-approval">
          <h2 className="text-sm font-semibold">{t('creative.campaigns.waitingTitle')} ({o?.posts.waitingApproval ?? 0})</h2>
          {o && o.waitingApproval.length === 0 && <p className="text-sm text-muted-foreground">{t('creative.campaigns.noWaiting')}</p>}
          <ul className="grid gap-2 text-sm">{o?.waitingApproval.map((w) => <li key={w.id} className="rounded-md border p-2"><button type="button" className="text-left text-primary hover:underline" onClick={() => setSelected(w.campaignId)}>{w.campaignName}</button> · {w.platform} · {w.kind} · {new Date(w.scheduledAt).toLocaleString(locale)}</li>)}</ul>
        </CardContent></Card>
        <Card><CardContent className="grid gap-2 p-4" data-testid="error-history">
          <h2 className="text-sm font-semibold">{t('creative.campaigns.errorsTitle')}</h2>
          {o && o.errors.length === 0 && <p className="text-sm text-muted-foreground">{t('creative.campaigns.noErrors')}</p>}
          <ul className="grid gap-2 text-sm">{o?.errors.map((e) => <li key={e.id} className="rounded-md border border-destructive/30 p-2"><span className="font-medium">{e.campaignName}</span> · {e.detail?.agent ?? e.type} · <span className="text-destructive">{e.detail?.code}</span><span className="block text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString(locale)}</span></li>)}</ul>
        </CardContent></Card>
      </div>
    </CreativeSection>
  );
}
