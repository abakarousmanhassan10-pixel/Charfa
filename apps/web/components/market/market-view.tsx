'use client';
import { Fragment, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError, api } from '@/lib/api-client';
import { qs, useDebounced, useResource, type Paged } from '@/lib/use-resource';

type Level = 'FRESH' | 'RECENT' | 'STALE' | 'OUTDATED';
interface Amount { status: 'OK' | 'UNKNOWN'; amount: string | null; note?: string }
interface Component { key: string; weight: number; status: 'OK' | 'UNKNOWN'; evidence: string; points: number | null }
interface Analysis {
  id: string;
  createdAt: string;
  profitability: Record<'revenue' | 'acquisitionCost' | 'shippingCost' | 'paymentFees' | 'returnsAllowance' | 'advertisingCost' | 'contributionBeforeAds' | 'contributionAfterAds' | 'marginPercent' | 'breakEvenAdCost', Amount> & { currency: string };
  score: { score: number | null; verdict: 'PROMISING' | 'MIXED' | 'WEAK' | 'INSUFFICIENT_EVIDENCE'; coverage: number; confidence: string; components: Component[]; flags: string[] };
}
interface Product {
  id: string;
  name: string;
  country: string;
  category: string | null;
  supplierName: string | null;
  source: { type: string; name: string | null; url: string };
  observedAt: string;
  freshness: { days: number; level: Level };
  costCurrency: string;
  sellingCurrency: string;
  latestAnalysis: Analysis | null;
}

const LINES = ['revenue', 'acquisitionCost', 'shippingCost', 'paymentFees', 'returnsAllowance', 'contributionBeforeAds', 'advertisingCost', 'contributionAfterAds', 'marginPercent', 'breakEvenAdCost'] as const;
const freshVariant = (l: Level) => (l === 'FRESH' ? 'success' : l === 'RECENT' ? 'default' : 'warning') as 'success' | 'default' | 'warning';
const verdictVariant = (v: string) => (v === 'PROMISING' ? 'success' : v === 'MIXED' ? 'default' : v === 'WEAK' ? 'warning' : 'muted') as 'success' | 'default' | 'warning' | 'muted';
/** Spreadsheet formulas in a cell would run when the file is opened: neutralise them. */
const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

const EMPTY_FORM = { name: '', country: '', category: '', supplierName: '', sourceUrl: '', sourceName: '', observedAt: '', costCurrency: '', unitCost: '', shippingCost: '', sellingCurrency: '', sellingPrice: '', estimatedDeliveryDays: '', supplierRating: '', supplierRatingSource: '', monthlySearches: '', demandSource: '', competitorCount: '', competitorSource: '' };
type Form = typeof EMPTY_FORM;
/** Example values for the fee fields only: the person confirms or replaces them. Nothing else is pre-filled. */
const EMPTY_ASSUMPTIONS = { paymentFeePercent: '2.9', paymentFixedFee: '0.30', returnsAllowancePercent: '5', advertisingCostPerAcquisition: '', fxRate: '', fxSource: '', fxDate: '' };

export function MarketView() {
  const { t } = useI18n();
  const { active } = useBusiness();
  const canWrite = active?.role !== 'VIEWER'; // the API enforces catalog.write; the UI only hides what would be refused
  const [country, setCountry] = useState('');
  const [category, setCategory] = useState('');
  const [freshness, setFreshness] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const list = useResource<Paged<Product>>(`/market/products${qs({ country: country.toUpperCase().length === 2 ? country.toUpperCase() : undefined, category, freshness, q: debounced, pageSize: 20 })}`, active?.id);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [ass, setAss] = useState(EMPTY_ASSUMPTIONS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Array<{ id: string; name: string; similarity: number }>>([]);
  const [open, setOpen] = useState<string | null>(null);

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : t('market.error'));
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setA = (k: keyof typeof EMPTY_ASSUMPTIONS) => (e: React.ChangeEvent<HTMLInputElement>) => setAss((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    if (!active) return;
    setBusy('save');
    setError(null);
    setSimilar([]);
    const ints = new Set(['estimatedDeliveryDays', 'monthlySearches', 'competitorCount']);
    const body: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(form)) {
      const x = v.trim();
      if (!x) continue;
      body[k] = k === 'observedAt' ? new Date(`${x}T00:00:00Z`).toISOString() : k === 'country' || k.endsWith('Currency') ? x.toUpperCase() : ints.has(k) ? Number(x) : x;
    }
    try {
      const res = await api<Product & { possibleDuplicates: Array<{ id: string; name: string; similarity: number }> }>('/market/products', { method: 'POST', businessId: active.id, json: body });
      setSimilar(res.possibleDuplicates);
      setForm(EMPTY_FORM);
      await list.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function analyze(p: Product) {
    if (!active) return;
    setBusy(p.id);
    setError(null);
    const assumptions: Record<string, unknown> = {};
    if (ass.paymentFeePercent.trim()) assumptions.paymentFeePercent = ass.paymentFeePercent.trim();
    if (ass.paymentFixedFee.trim()) assumptions.paymentFixedFee = ass.paymentFixedFee.trim();
    if (ass.returnsAllowancePercent.trim()) assumptions.returnsAllowancePercent = ass.returnsAllowancePercent.trim();
    if (ass.advertisingCostPerAcquisition.trim()) assumptions.advertisingCostPerAcquisition = ass.advertisingCostPerAcquisition.trim();
    if (ass.fxRate.trim() && ass.fxSource.trim() && ass.fxDate.trim() && p.costCurrency !== p.sellingCurrency) assumptions.fx = { source: ass.fxSource.trim(), asOf: ass.fxDate.trim(), rates: { [p.costCurrency]: ass.fxRate.trim() } };
    try {
      await api(`/market/products/${p.id}/analyses`, { method: 'POST', businessId: active.id, json: { assumptions } });
      setOpen(p.id);
      await list.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    const rows = list.data?.items ?? [];
    const head = ['name', 'market', 'category', 'supplier', 'source_url', 'observed_at', 'freshness', 'margin_percent', 'break_even_ad_cost', 'score', 'verdict'];
    const body = rows.map((p) => [p.name, p.country, p.category, p.supplierName, p.source.url, p.observedAt, p.freshness.level, p.latestAnalysis?.profitability.marginPercent.amount ?? null, p.latestAnalysis?.profitability.breakEvenAdCost.amount ?? null, p.latestAnalysis?.score.score ?? null, p.latestAnalysis?.score.verdict ?? null]);
    const blob = new Blob([[head, ...body].map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'market-research.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (list.error instanceof ApiError && list.error.status === 404) return <EmptyState title={t('market.disabled')} />;
  const unknown = t('market.unknown');
  const money = (a: Amount | undefined, cur: string) => (a?.status === 'OK' && a.amount !== null ? `${a.amount} ${cur}` : unknown);

  const input = (k: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="grid gap-1 text-sm">{label}<Input value={form[k]} onChange={set(k)} {...props} /></label>
  );

  return (
    <div className="grid gap-4" data-testid="market">
      <p className="text-sm text-muted-foreground">{t('market.notice')}</p>
      {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">{error}</div>}
      {similar.length > 0 && (
        <div role="status" className="rounded-md border p-3 text-sm">
          {t('market.possibleDuplicates')} {similar.map((s) => `${s.name} (${Math.round(s.similarity * 100)}%)`).join(', ')}
        </div>
      )}

      {canWrite && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('market.import')}</CardTitle><p className="text-sm text-muted-foreground">{t('market.importHint')}</p></CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {input('name', t('market.f.name'), { maxLength: 160 })}
              {input('country', t('market.f.country'), { maxLength: 2, placeholder: 'TD' })}
              {input('category', t('market.f.category'), { maxLength: 60 })}
              {input('supplierName', t('market.f.supplier'), { maxLength: 120 })}
              {input('sourceUrl', t('market.f.sourceUrl'), { type: 'url', placeholder: 'https://' })}
              {input('sourceName', t('market.f.sourceName'), { maxLength: 120 })}
              {input('observedAt', t('market.f.observedAt'), { type: 'date' })}
              {input('costCurrency', t('market.f.costCurrency'), { maxLength: 3, placeholder: 'CNY' })}
              {input('unitCost', t('market.f.unitCost'), { inputMode: 'decimal', placeholder: '20.00' })}
              {input('shippingCost', t('market.f.shippingCost'), { inputMode: 'decimal' })}
              {input('sellingCurrency', t('market.f.sellingCurrency'), { maxLength: 3, placeholder: 'USD' })}
              {input('sellingPrice', t('market.f.sellingPrice'), { inputMode: 'decimal' })}
              {input('estimatedDeliveryDays', t('market.f.deliveryDays'), { inputMode: 'numeric' })}
              {input('supplierRating', t('market.f.rating'), { inputMode: 'decimal' })}
              {input('supplierRatingSource', t('market.f.ratingSource'))}
              {input('monthlySearches', t('market.f.searches'), { inputMode: 'numeric' })}
              {input('demandSource', t('market.f.searchesSource'))}
              {input('competitorCount', t('market.f.competitors'), { inputMode: 'numeric' })}
              {input('competitorSource', t('market.f.competitorsSource'))}
            </div>
            <div><Button onClick={() => void save()} disabled={busy !== null || !form.name.trim() || !form.sourceUrl.trim() || !form.observedAt || form.country.length !== 2 || form.costCurrency.length !== 3 || form.sellingCurrency.length !== 3}>{t('market.save')}</Button></div>
          </CardContent>
        </Card>
      )}

      {canWrite && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('market.a.title')}</CardTitle><p className="text-sm text-muted-foreground">{t('market.a.hint')}</p></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="grid gap-1 text-sm">{t('market.a.feePercent')}<Input value={ass.paymentFeePercent} onChange={setA('paymentFeePercent')} inputMode="decimal" /></label>
            <label className="grid gap-1 text-sm">{t('market.a.feeFixed')}<Input value={ass.paymentFixedFee} onChange={setA('paymentFixedFee')} inputMode="decimal" /></label>
            <label className="grid gap-1 text-sm">{t('market.a.returns')}<Input value={ass.returnsAllowancePercent} onChange={setA('returnsAllowancePercent')} inputMode="decimal" /></label>
            <label className="grid gap-1 text-sm">{t('market.a.cpa')}<Input value={ass.advertisingCostPerAcquisition} onChange={setA('advertisingCostPerAcquisition')} inputMode="decimal" /></label>
            <label className="grid gap-1 text-sm">{t('market.a.fxRate')}<Input value={ass.fxRate} onChange={setA('fxRate')} inputMode="decimal" /></label>
            <label className="grid gap-1 text-sm">{t('market.a.fxSource')}<Input value={ass.fxSource} onChange={setA('fxSource')} /></label>
            <label className="grid gap-1 text-sm">{t('market.a.fxDate')}<Input value={ass.fxDate} onChange={setA('fxDate')} type="date" /></label>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">{t('market.filters.country')}<Input className="w-24" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} placeholder="TD" /></label>
        <label className="grid gap-1 text-sm">{t('market.filters.category')}<Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} /></label>
        <label className="grid gap-1 text-sm">{t('market.filters.freshness')}
          <Select value={freshness} onChange={(e) => setFreshness(e.target.value)}>
            <option value="">{t('market.filters.all')}</option>
            {(['FRESH', 'RECENT', 'STALE', 'OUTDATED'] as const).map((l) => <option key={l} value={l}>{t(`market.fresh.${l}`)}</option>)}
          </Select>
        </label>
        <label className="grid gap-1 text-sm">{t('market.filters.search')}<Input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} /></label>
        <Button variant="outline" onClick={exportCsv} disabled={!list.data?.items.length}>{t('market.filters.export')}</Button>
      </div>

      {list.error ? (
        <ErrorState message={t('market.error')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} />
      ) : !list.data ? (
        <LoadingRows rows={3} label={t('common.loading')} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title={t('market.none')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="market-table">
            <thead className="text-start text-xs text-muted-foreground">
              <tr>{(['product', 'market', 'freshness', 'margin', 'breakEven', 'score', 'source'] as const).map((c) => <th key={c} className="p-2 text-start">{t(`market.th.${c}`)}</th>)}<th /></tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => {
                const a = p.latestAnalysis;
                return (
                  <Fragment key={p.id}>
                    <tr className="border-t" data-testid="market-row">
                      <td className="p-2 font-medium">{p.name}</td>
                      <td className="p-2">{p.country}</td>
                      <td className="p-2"><Badge variant={freshVariant(p.freshness.level)}>{t(`market.fresh.${p.freshness.level}`)}</Badge> <span className="text-xs text-muted-foreground">{p.freshness.days} {t('market.days')}</span></td>
                      <td className="p-2">{a?.profitability.marginPercent.status === 'OK' ? `${a.profitability.marginPercent.amount}%` : unknown}</td>
                      <td className="p-2">{a ? money(a.profitability.breakEvenAdCost, a.profitability.currency) : unknown}</td>
                      <td className="p-2">{a ? <><strong>{a.score.score ?? unknown}</strong> <Badge variant={verdictVariant(a.score.verdict)}>{t(`market.verdict.${a.score.verdict}`)}</Badge></> : <span className="text-muted-foreground">{t('market.noAnalysis')}</span>}</td>
                      <td className="p-2"><a className="underline" href={p.source.url} target="_blank" rel="noopener noreferrer">{p.source.name ?? new URL(p.source.url).hostname}</a></td>
                      <td className="p-2 text-end">
                        <div className="flex justify-end gap-2">
                          {canWrite && <Button size="sm" disabled={busy !== null} onClick={() => void analyze(p)}>{t('market.analyze')}</Button>}
                          <Button size="sm" variant="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? t('market.hide') : t('market.details')}</Button>
                        </div>
                      </td>
                    </tr>
                    {open === p.id && <tr className="border-t bg-muted/30"><td colSpan={8} className="p-3"><Details product={p} businessId={active?.id} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Details({ product, businessId }: { product: Product; businessId: string | undefined }) {
  const { t } = useI18n();
  const unknown = t('market.unknown');
  const money = (a: Amount | undefined, cur: string) => (a?.status === 'OK' && a.amount !== null ? `${a.amount} ${cur}` : unknown);
  const a = product.latestAnalysis;
  const history = useResource<Paged<Analysis>>(`/market/products/${product.id}/analyses?pageSize=10`, businessId);
  return (
    <div className="grid gap-4 text-sm" data-testid="market-details">
      <div>
        <h4 className="font-semibold">{t('market.provenance')}</h4>
        <p>{product.source.type} · <a className="underline" href={product.source.url} target="_blank" rel="noopener noreferrer">{product.source.url}</a> · {t('market.observed')} {new Date(product.observedAt).toLocaleDateString()}</p>
      </div>
      {!a ? <p className="text-muted-foreground">{t('market.noAnalysis')}</p> : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="font-semibold">{t('market.economics')}</h4>
              <table className="w-full"><tbody>{LINES.map((k) => <tr key={k}><td className="py-0.5 pe-2">{t(`market.line.${k}`)}</td><td className="py-0.5 text-end">{k === 'marginPercent' ? (a.profitability[k].amount !== null ? `${a.profitability[k].amount}%` : unknown) : money(a.profitability[k], a.profitability.currency)}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h4 className="font-semibold">{t('market.components')} <span className="font-normal text-muted-foreground">· {t('market.coverage')} {a.score.coverage}% · {t('market.confidence')} {a.score.confidence}</span></h4>
              <table className="w-full"><tbody>{a.score.components.map((c) => (
                <tr key={c.key} className="align-top"><td className="py-0.5 pe-2">{t(`market.comp.${c.key}`)} <span className="text-xs text-muted-foreground">({t('market.weight')} {c.weight})</span></td><td className="py-0.5 pe-2 text-end">{c.points ?? unknown}</td><td className="py-0.5 text-xs text-muted-foreground">{c.evidence}</td></tr>
              ))}</tbody></table>
            </div>
          </div>
        </>
      )}
      <div>
        <h4 className="font-semibold">{t('market.history')}</h4>
        {!history.data ? <LoadingRows rows={1} label={t('common.loading')} /> : <ul>{history.data.items.map((h) => <li key={h.id}>{new Date(h.createdAt).toLocaleString()} · {h.score.score ?? unknown} · {t(`market.verdict.${h.score.verdict}`)}</li>)}</ul>}
      </div>
    </div>
  );
}
