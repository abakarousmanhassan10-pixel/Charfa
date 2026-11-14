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
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError, api } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

interface Product { productId: string; name: string; currency: string; status: 'COMPLETE' | 'INCOMPLETE'; missing: string[]; contributionBeforeAds: string | null; marginPercentBeforeAds: string | null; breakEvenPrice: string | null; priceUsed: string | null }
interface Decision { id: string; kind: string; title: string; problem: string; evidence: Record<string, unknown>; expectedBenefit: { type: string; text?: string; reason?: string; assumptions?: string[] }; confidence: string; risk: string; requiredApproval: string; priority: number }
interface Overview {
  settings: { paused: boolean; dailyRunLimit: number };
  health: { dataCoveragePercent: number; verifiedSections: number; totalSections: number; note: string };
  sections: Record<string, { status: string; note: string }>;
  finance: { products: Product[]; summary: { products: number; complete: number; incomplete: number; losingMoney: number }; note: string };
  decisions: Decision[];
  latestRun: null | { id: string; status: string; createdAt: string; steps: Array<{ agent: string; status: string }> };
  campaigns: { byStatus: Record<string, number> };
  pendingApprovals: number;
  agentActivity: { last7Days: Record<string, number> };
  alerts: Array<{ id: string; severity: string; title: string }>;
  simulatedPlatforms: boolean;
  metricsOrigin: { publishedSimulated: number; publishedReal: number };
}
interface ScenarioResult { name: string; unit: { contributionBeforeAds: string | null }; ads: { orders: string; costPerOrder: string | null } | null; netProfit: string | null; flags: string[]; missing: string[] }

const TONE: Record<string, 'success' | 'warning' | 'muted'> = { VERIFIED: 'success', PARTIAL: 'warning', SIMULATED: 'warning', MISSING: 'muted', UNAVAILABLE: 'muted' };

/** Merchant command center (N22). Decision support only: nothing here changes a price, spends on ads, refunds, publishes or messages a customer. */
export function AutopilotView() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const allowed = can('billing.read');
  const o = useResource<Overview>(allowed ? '/executive/overview' : null, active?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState({ productId: '', price: '', shippingCost: '', adBudget: '100000', costPerClick: '50', conversionPercent: '2' });
  const [results, setResults] = useState<ScenarioResult[] | null>(null);
  const [cost, setCost] = useState({ productId: '', currency: 'XAF', unitCost: '', shippingCost: '', paymentFeePercent: '', paymentFixedFee: '', returnsAllowancePercent: '' });
  const admin = can('content.approve');
  const editFinance = can('business.update');

  async function call(label: string, path: string, method: 'POST' | 'PUT', json: Record<string, unknown> = {}) {
    if (!active) return null;
    setBusy(label); setError(null);
    try { const r = await api<unknown>(`/executive${path}`, { method, json, businessId: active.id }); await o.reload(); return r; }
    catch (e) { setError(e instanceof ApiError ? e.message : t('common.loadError')); return null; }
    finally { setBusy(null); }
  }
  async function simulate() {
    const ads = { adBudget: scenario.adBudget, costPerClick: scenario.costPerClick, conversionPercent: scenario.conversionPercent };
    const clean = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
    const r = (await call('simulate', '/scenarios', 'POST', { productId: scenario.productId, scenarios: [{ name: t('autopilot.current'), ...ads }, { name: t('autopilot.whatIf'), ...clean({ price: scenario.price, shippingCost: scenario.shippingCost }), ...ads }] })) as { results: ScenarioResult[] } | null;
    if (r) setResults(r.results);
  }
  const num = (v: string, k: keyof typeof cost) => <Input aria-label={t(`autopilot.fields.${k}`)} placeholder={t(`autopilot.fields.${k}`)} inputMode="decimal" value={cost[k]} onChange={(e) => setCost({ ...cost, [k]: e.target.value })} />;

  if (!allowed) return <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="restricted">{t('autopilot.restricted')}</p>;
  if (o.loading && !o.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (o.error && !o.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void o.reload()} />;
  const d = o.data!;
  const products = d.finance.products;
  return (
    <div className="grid gap-6" data-testid="autopilot">
      <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="autopilot-rule">{t('autopilot.rule')}</p>
      <p className={`rounded-md px-3 py-2 text-sm ${d.simulatedPlatforms ? 'bg-amber-500/10' : 'bg-emerald-500/10'}`} data-testid="origin">{d.simulatedPlatforms ? t('autopilot.simulated') : t('autopilot.real')} {t('autopilot.origin', { sim: d.metricsOrigin.publishedSimulated, real: d.metricsOrigin.publishedReal })}</p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {d.settings.paused && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium" data-testid="paused">{t('autopilot.paused')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy !== null || d.settings.paused} onClick={() => void call('run', '/run', 'POST')} data-testid="act-run">{busy === 'run' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('autopilot.run')}</Button>
        {admin && <Button size="sm" variant={d.settings.paused ? 'outline' : 'ghost'} className={d.settings.paused ? '' : 'text-destructive'} disabled={busy !== null} onClick={() => void call('stop', '/settings', 'PUT', { paused: !d.settings.paused })} data-testid="act-stop">{d.settings.paused ? t('autopilot.release') : t('autopilot.stop')}</Button>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>{t('autopilot.health')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm" data-testid="health-card">
          <p><span className="text-2xl font-semibold" data-testid="coverage">{d.health.dataCoveragePercent}%</span> {t('autopilot.coverage', { n: d.health.verifiedSections, total: d.health.totalSections })}</p>
          <ul className="grid gap-1">{Object.entries(d.sections).map(([k, s]) => <li key={k} data-section={k} data-status={s.status}><Badge variant={TONE[s.status] ?? 'muted'}>{t(`autopilot.status.${s.status}`)}</Badge> {t(`autopilot.sections.${k}`)}</li>)}</ul>
          <p className="text-xs text-muted-foreground">{d.health.note}</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('autopilot.profit')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm" data-testid="profit-card">
          {products.length === 0 ? <p className="text-muted-foreground">{t('autopilot.noProducts')}</p> : <ul className="grid gap-2">{products.map((p) => (
            <li key={p.productId} data-status={p.status}><span className="font-medium">{p.name}</span><br />
              {p.status === 'COMPLETE' ? <>{t('autopilot.contribution', { amount: p.contributionBeforeAds ?? '', currency: p.currency })} · {t('autopilot.breakEven', { price: p.breakEvenPrice ?? '-', currency: p.currency })}{Number(p.contributionBeforeAds) < 0 && <> <Badge variant="warning">{t('autopilot.losing')}</Badge></>}</>
                : <span className="text-muted-foreground">{t('autopilot.missingCosts', { list: p.missing.join(', ') })}</span>}</li>))}</ul>}
          <p className="text-xs text-muted-foreground">{d.finance.note}</p>
        </CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>{t('autopilot.decisions')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="decisions-card">
        {d.decisions.length === 0 ? <p className="text-muted-foreground">{t('autopilot.noDecisions')}</p> : <ul className="grid gap-4">{d.decisions.map((x) => (
          <li key={x.id} className="grid gap-1 rounded-md border p-3" data-kind={x.kind}>
            <p className="flex flex-wrap items-center gap-2 font-medium">{x.title} <Badge variant="muted">{t(`autopilot.confidence.${x.confidence}`)}</Badge></p>
            <p>{x.problem}</p>
            <p className="text-muted-foreground">{x.expectedBenefit.type === 'ESTIMATE' ? `${t('autopilot.estimate')}: ${x.expectedBenefit.text ?? ''}` : `${t('autopilot.notEstimated')}: ${x.expectedBenefit.reason ?? ''}`}</p>
            {x.expectedBenefit.assumptions && <p className="text-xs text-muted-foreground">{t('autopilot.assumptions')}: {x.expectedBenefit.assumptions.join(' ')}</p>}
            <p className="text-xs text-muted-foreground">{t('autopilot.risk')}: {x.risk}</p>
            {admin && <div className="flex gap-2 pt-1"><Button size="sm" disabled={busy !== null || d.settings.paused} onClick={() => void call('approve', `/decisions/${x.id}/approve`, 'POST')}>{t('autopilot.approve')}</Button><Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void call('reject', `/decisions/${x.id}/reject`, 'POST')}>{t('autopilot.reject')}</Button></div>}
          </li>))}</ul>}
      </CardContent></Card>
      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardTitle>{t('autopilot.campaigns')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm" data-testid="campaigns-card">
          <p>{Object.entries(d.campaigns.byStatus).map(([s, n]) => `${t(`campaigns.status.${s}`)}: ${n}`).join(' · ') || t('autopilot.none')}</p>
          <p><span className="text-2xl font-semibold" data-testid="pending">{d.pendingApprovals}</span> {t('autopilot.pending')}</p>
          <Link href="/dashboard/calendar/approvals" className="text-primary underline-offset-2 hover:underline">{t('autopilot.openApprovals')}</Link>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('autopilot.risks')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="risks-card">
          {d.alerts.length === 0 ? <p className="text-muted-foreground">{t('autopilot.noRisks')}</p> : <ul className="grid gap-1">{d.alerts.map((a) => <li key={a.id}><Badge variant="warning">{a.severity}</Badge> {a.title}</li>)}</ul>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{t('autopilot.agents')}</CardTitle></CardHeader><CardContent className="text-sm" data-testid="agents-card">
          {d.latestRun ? <><p>{t('autopilot.lastRun')}: {t(`autopilot.runStatus.${d.latestRun.status}`)}</p><ul>{d.latestRun.steps.map((s) => <li key={s.agent}>{s.agent}: {s.status}</li>)}</ul></> : <p className="text-muted-foreground">{t('autopilot.noRun')}</p>}
        </CardContent></Card>
      </div>
      {editFinance && (
        <Card><CardHeader><CardTitle>{t('autopilot.enterCosts')}</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-4" data-testid="costs-form">
          <Select aria-label={t('autopilot.product')} value={cost.productId} onChange={(e) => setCost({ ...cost, productId: e.target.value })}><option value="">{t('autopilot.product')}</option>{products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}</Select>
          {num('unitCost', 'unitCost')}{num('shippingCost', 'shippingCost')}{num('paymentFeePercent', 'paymentFeePercent')}{num('paymentFixedFee', 'paymentFixedFee')}{num('returnsAllowancePercent', 'returnsAllowancePercent')}
          <Button disabled={!cost.productId || busy !== null} onClick={() => { const { productId, ...body } = cost; void call('costs', `/economics/${productId}`, 'PUT', Object.fromEntries(Object.entries(body).filter(([, v]) => v !== ''))); }} data-testid="save-costs">{t('autopilot.saveCosts')}</Button>
          <p className="text-xs text-muted-foreground sm:col-span-4">{t('autopilot.costsHint')}</p>
        </CardContent></Card>
      )}
      <Card><CardHeader><CardTitle>{t('autopilot.scenarios')}</CardTitle></CardHeader><CardContent className="grid gap-3" data-testid="scenario-card">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select aria-label={t('autopilot.product')} value={scenario.productId} onChange={(e) => setScenario({ ...scenario, productId: e.target.value })}><option value="">{t('autopilot.product')}</option>{products.map((p) => <option key={p.productId} value={p.productId}>{p.name}</option>)}</Select>
          <Input aria-label={t('autopilot.whatIfPrice')} placeholder={t('autopilot.whatIfPrice')} inputMode="decimal" value={scenario.price} onChange={(e) => setScenario({ ...scenario, price: e.target.value })} />
          <Input aria-label={t('autopilot.whatIfShipping')} placeholder={t('autopilot.whatIfShipping')} inputMode="decimal" value={scenario.shippingCost} onChange={(e) => setScenario({ ...scenario, shippingCost: e.target.value })} />
          <Input aria-label={t('autopilot.adBudget')} value={scenario.adBudget} inputMode="decimal" onChange={(e) => setScenario({ ...scenario, adBudget: e.target.value })} />
          <Input aria-label={t('autopilot.costPerClick')} value={scenario.costPerClick} inputMode="decimal" onChange={(e) => setScenario({ ...scenario, costPerClick: e.target.value })} />
          <Input aria-label={t('autopilot.conversion')} value={scenario.conversionPercent} inputMode="decimal" onChange={(e) => setScenario({ ...scenario, conversionPercent: e.target.value })} />
        </div>
        <div><Button size="sm" variant="outline" disabled={!scenario.productId || busy !== null} onClick={() => void simulate()} data-testid="simulate">{t('autopilot.simulate')}</Button></div>
        <p className="text-xs text-muted-foreground">{t('autopilot.scenarioNote')}</p>
        {results && <table className="w-full text-left text-sm" data-testid="scenario-results"><thead><tr><th>{t('autopilot.scenario')}</th><th>{t('autopilot.perOrder')}</th><th>{t('autopilot.orders')}</th><th>{t('autopilot.net')}</th></tr></thead><tbody>
          {results.map((r) => <tr key={r.name} data-flags={r.flags.join(',')}><td>{r.name}</td><td>{r.unit.contributionBeforeAds ?? t('autopilot.unknown')}</td><td>{r.ads?.orders ?? t('autopilot.unknown')}</td><td>{r.netProfit ?? t('autopilot.unknown')}{r.flags.includes('NEGATIVE_NET_PROFIT') && <> <Badge variant="warning">{t('autopilot.loss')}</Badge></>}</td></tr>)}
        </tbody></table>}
      </CardContent></Card>
    </div>
  );
}
