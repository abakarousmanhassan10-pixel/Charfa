'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError, api } from '@/lib/api-client';
import { useResource, type Paged } from '@/lib/use-resource';

interface Entry { id: string; kind: string; title: string; platform: string; approvalStatus: string }
interface Campaign {
  id: string; name: string; status: string; paused: boolean;
  goal: { type: string };
  budget: { executionLimit: number; executionsUsed: number; costLimitMicros: number; costUsedMicros: number };
  products: Array<{ id: string; name: string }>;
  entries: Entry[];
  executions: Array<{ id: string; agent: string; status: string; errorCode: string | null }>;
  plan: null | {
    market: { status: string; reason: string };
    audiences: { segments: Array<{ label: string }> };
    channels: Array<{ platform: string; accountConnected: boolean }>;
    costEstimate: { aiCostMicros: number; humanReviewMinutes: number; note: string };
    rejected: Array<{ index: number; code: string }>;
    evaluation?: { summary: string; counts: { real: number; simulated: number; unavailable: number }; recommendations: string[]; caveat: string };
  };
}
const GOALS = ['LAUNCH', 'AWARENESS', 'ENGAGEMENT', 'TRAFFIC'];

/** The AI Marketing Director (N20): drafts only. Every post is approved one by one on the calendar approvals page. */
export function CampaignsView() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const list = useResource<Paged<{ id: string; name: string; status: string; paused: boolean }>>('/campaigns', active?.id);
  const products = useResource<Paged<{ id: string; name: string; status: string }>>('/products?status=ACTIVE&pageSize=50', active?.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useResource<Campaign>(openId ? `/campaigns/${openId}` : null, active?.id);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('LAUNCH');
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = can('ai.use');
  const admin = can('content.approve');

  async function run(path: string, label: string, body: Record<string, unknown> = {}) {
    if (!active) return;
    setBusy(label); setError(null);
    try {
      const r = await api<Campaign>(`/campaigns${path}`, { method: 'POST', json: body, businessId: active.id });
      if (path === '') setOpenId(r.id);
      await Promise.all([list.reload(), detail.reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally { setBusy(null); }
  }
  const c = detail.data;
  const step = (path: string, label: string, enabled: boolean) => <Button size="sm" disabled={!enabled || busy !== null} onClick={() => void run(`/${c!.id}${path}`, label)} data-testid={`step-${label}`}>{busy === label && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t(`campaigns.steps.${label}`)}</Button>;

  return (
    <div className="grid gap-6" data-testid="campaigns">
      <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="campaigns-rule">{t('campaigns.rule')}</p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {write && (
        <Card>
          <CardHeader><CardTitle>{t('campaigns.new')}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-4">
            <Input aria-label={t('campaigns.name')} placeholder={t('campaigns.name')} value={name} onChange={(e) => setName(e.target.value)} />
            <Select aria-label={t('campaigns.goal')} value={goal} onChange={(e) => setGoal(e.target.value)}>{GOALS.map((g) => <option key={g} value={g}>{t(`campaigns.goals.${g}`)}</option>)}</Select>
            <Select aria-label={t('campaigns.product')} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">{t('campaigns.chooseProduct')}</option>
              {products.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Button disabled={!name.trim() || !productId || busy !== null} onClick={() => void run('', 'create', { name, goalType: goal, productIds: [productId] })} data-testid="create-campaign">{t('campaigns.create')}</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>{t('campaigns.list')}</CardTitle></CardHeader>
        <CardContent>
          {list.loading && !list.data ? <LoadingRows rows={2} label={t('common.loading')} /> : list.error && !list.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} /> : list.data!.items.length === 0 ? <EmptyState title={t('campaigns.emptyTitle')} hint={t('campaigns.emptyHint')} /> : (
            <ul className="grid gap-2" data-testid="campaign-list">
              {list.data!.items.map((x) => (
                <li key={x.id}><button type="button" className="flex w-full items-center justify-between rounded-md border p-3 text-left text-sm hover:bg-muted/40" onClick={() => setOpenId(x.id)} data-testid="campaign-item"><span className="font-medium">{x.name}</span><span className="flex gap-2"><Badge variant="muted">{t(`campaigns.status.${x.status}`)}</Badge>{x.paused && <Badge variant="warning">{t('campaigns.paused')}</Badge>}</span></button></li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {c && (
        <Card data-testid="campaign-detail">
          <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">{c.name}<Badge variant="muted" data-testid="campaign-status">{t(`campaigns.status.${c.status}`)}</Badge>{c.paused && <Badge variant="warning">{t('campaigns.paused')}</Badge>}</CardTitle></CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <p className="text-muted-foreground">{c.products.map((p) => p.name).join(', ')} · {t('campaigns.budget', { used: c.budget.executionsUsed, max: c.budget.executionLimit })} · {t('campaigns.cost', { usd: (c.budget.costUsedMicros / 1_000_000).toFixed(2) })}</p>
            {write && (
              <div className="flex flex-wrap gap-2">
                {step('/plan', 'plan', ['DRAFT', 'PLANNED'].includes(c.status) && !c.paused)}
                {step('/content', 'content', c.status === 'PLANNED' && !c.paused)}
                {step('/submit', 'submit', ['CONTENT_READY', 'AWAITING_APPROVAL', 'ACTIVE'].includes(c.status) && !c.paused)}
                {step('/metrics', 'metrics', ['ACTIVE', 'COMPLETED'].includes(c.status))}
                {admin && !['COMPLETED', 'CANCELLED'].includes(c.status) && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`/${c.id}/${c.paused ? 'resume' : 'pause'}`, 'pause')} data-testid="kill-switch">{t(c.paused ? 'campaigns.resume' : 'campaigns.pause')}</Button>}
                {admin && !['COMPLETED', 'CANCELLED'].includes(c.status) && <Button size="sm" variant="ghost" className="text-destructive" disabled={busy !== null} onClick={() => void run(`/${c.id}/cancel`, 'cancel')}>{t('campaigns.cancel')}</Button>}
              </div>
            )}
            {c.plan && (
              <div className="grid gap-1" data-testid="plan">
                <p className="font-medium">{t('campaigns.plan')}</p>
                <p>{t('campaigns.audiences')}: {c.plan.audiences.segments.map((s) => s.label).join(' · ')}</p>
                <p>{t('campaigns.channels')}: {c.plan.channels.map((ch) => `${ch.platform}${ch.accountConnected ? '' : ` (${t('campaigns.noAccount')})`}`).join(', ')}</p>
                <p className="text-muted-foreground" data-testid="market-note">{t('campaigns.market')}: {c.plan.market.status === 'UNAVAILABLE' ? t('campaigns.marketUnavailable') : c.plan.market.reason}</p>
                <p className="text-muted-foreground">{t('campaigns.estimate', { minutes: c.plan.costEstimate.humanReviewMinutes })}</p>
                {c.plan.rejected.length > 0 && <p className="text-amber-700 dark:text-amber-400">{t('campaigns.rejected', { count: c.plan.rejected.length })}</p>}
              </div>
            )}
            {c.entries.length > 0 && (
              <div data-testid="entries">
                <p className="font-medium">{t('campaigns.posts')}</p>
                <ul className="mt-1 grid gap-1">{c.entries.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-2" data-status={e.approvalStatus}><span>{e.title}</span><Badge variant="muted">{e.platform}</Badge><Badge variant="muted">{e.approvalStatus}</Badge></li>)}</ul>
                <Link href="/dashboard/calendar/approvals" className="mt-2 inline-block text-primary underline-offset-2 hover:underline">{t('campaigns.approveHere')}</Link>
              </div>
            )}
            {c.plan?.evaluation && (
              <div data-testid="evaluation" className="grid gap-1">
                <p className="font-medium">{t('campaigns.evaluation')}</p>
                <p>{t('campaigns.evalCounts', { real: c.plan.evaluation.counts.real, simulated: c.plan.evaluation.counts.simulated, unavailable: c.plan.evaluation.counts.unavailable })}</p>
                <ul className="list-disc pl-5 text-muted-foreground">{c.plan.evaluation.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>
                <p className="text-xs text-muted-foreground">{c.plan.evaluation.caveat}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
