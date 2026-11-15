'use client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';

interface Item { slug: string; name: string; summary: string; category: string; tags: string[]; demo: boolean; creator: { displayName: string; verified: boolean; demo: boolean }; pricing: { type: string; simulated: boolean; note: string | null }; latestVersion: string; compatibleModels: string[]; permissions: { count: number; sensitive: number }; installs: { count: number | null; note: string }; reviews: { count: number; average: number | null } }
interface Detail { slug: string; name: string; description: string; creator: Item['creator'] & { bio: string | null }; pricing: Item['pricing']; license: { type: string; terms: string }; latestVersion: { version: string; changelog: string; manifestHash: string }; capabilities: Array<{ tool: string; label: string; kind: string; requiresConfirmation: boolean; enabledToday: boolean }>; permissions: Array<{ key: string; description: string; sensitive: boolean }>; compatibleModels: string[]; agent: { mission: string; instructions: string; tone: string; language: string; mode: string }; history: Array<{ version: string; publishedAt: string; changelog: string; permissions: string[] }>; installs: Item['installs']; reviews: Item['reviews'] & { items: Array<{ rating: number; comment: string | null; version: string | null; date: string }>; note: string } }
const CATS = ['MARKETING', 'SOCIAL', 'SUPPORT', 'ECOMMERCE', 'RESEARCH', 'ANALYTICS', 'ASSISTANT', 'CUSTOM'];

/** Browse the agent catalog: search, category and pricing filters, agent pages with permissions, capabilities, models, licence and update history. Read-only in this release. */
export function MarketplaceView() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const biz = active?.id;
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [pricing, setPricing] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const load = useCallback(async () => {
    if (!biz) return;
    const p = new URLSearchParams(); if (q.trim()) p.set('q', q.trim()); if (category) p.set('category', category); if (pricing) p.set('pricing', pricing);
    try { setItems((await api<{ items: Item[] }>(`/marketplace/catalog?${p}`, { businessId: biz })).items); setError(null); }
    catch (e) { if (e instanceof ApiError && e.status === 404) setNotEnabled(true); else setError(e instanceof ApiError ? e.message : 'error'); }
  }, [biz, q, category, pricing]);
  useEffect(() => { void load(); }, [load]);
  const open = async (slug: string) => { try { setDetail(await api<Detail>(`/marketplace/listings/${slug}`, { businessId: biz })); } catch (e) { setError(e instanceof ApiError ? e.message : 'error'); } };
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  if (notEnabled) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="market-disabled">{t('marketplace.notEnabled')}</p>;
  if (!items) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const field = 'h-9 rounded-md border bg-background px-2 text-sm';
  return (
    <div className="grid gap-4" data-testid="marketplace">
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="market-note">{t('marketplace.note')}</p>
      {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <input className={`${field} min-w-48 flex-1`} placeholder={t('marketplace.search')} aria-label={t('marketplace.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="market-search" />
        <select className={field} value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('marketplace.category')} data-testid="market-category"><option value="">{t('marketplace.allCategories')}</option>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
        <select className={field} value={pricing} onChange={(e) => setPricing(e.target.value)} aria-label={t('marketplace.pricing')} data-testid="market-pricing"><option value="">{t('marketplace.allPricing')}</option><option value="FREE">{t('marketplace.free')}</option><option value="PREMIUM">{t('marketplace.premium')}</option></select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.length === 0 && <p className="text-sm text-muted-foreground">{t('marketplace.none')}</p>}
        {items.map((i) => (
          <Card key={i.slug} data-testid="market-card"><CardHeader><CardTitle>{i.name}</CardTitle><CardDescription>{i.creator.displayName}{i.demo ? ` · ${t('marketplace.demo')}` : ''}</CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm"><p>{i.summary}</p>
              <p className="text-xs text-muted-foreground">{i.category} · v{i.latestVersion} · {i.pricing.type === 'FREE' ? t('marketplace.free') : `${t('marketplace.premium')} (${t('marketplace.simulated')})`} · {i.permissions.count} {t('marketplace.permissions')}{i.permissions.sensitive ? ` (${i.permissions.sensitive} ${t('marketplace.sensitive')})` : ''}</p>
              <p className="text-xs text-muted-foreground">{i.reviews.count === 0 ? t('marketplace.noReviews') : `${i.reviews.average}/5 (${i.reviews.count})`} · {t('marketplace.noInstalls')}</p>
              <div><Button size="sm" variant="outline" data-testid="market-open" onClick={() => open(i.slug)}>{t('marketplace.details')}</Button></div></CardContent></Card>
        ))}
      </div>
      {detail && (
        <Card data-testid="market-detail"><CardHeader><CardTitle>{detail.name} <span className="text-sm font-normal text-muted-foreground">v{detail.latestVersion.version}</span></CardTitle><CardDescription>{detail.creator.displayName}{detail.creator.verified ? ` · ${t('marketplace.verified')}` : ` · ${t('marketplace.unverified')}`}</CardDescription></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>{detail.description}</p>
            {detail.pricing.note && <p className="text-xs" data-testid="market-price-note">{detail.pricing.note}</p>}
            <div><p className="font-medium">{t('marketplace.neededPermissions')}</p><ul className="list-disc ps-5" data-testid="market-permissions">{detail.permissions.map((p) => <li key={p.key}>{p.description}{p.sensitive ? ` — ${t('marketplace.sensitive')}` : ''}</li>)}</ul></div>
            <div><p className="font-medium">{t('marketplace.capabilities')}</p><ul className="list-disc ps-5">{detail.capabilities.map((c) => <li key={c.tool}>{c.label} ({c.kind}{c.requiresConfirmation ? `, ${t('marketplace.confirm')}` : ''})</li>)}</ul></div>
            <p>{t('marketplace.models')}: {detail.compatibleModels.join(', ')} · {t('marketplace.license')}: {detail.license.type} — {detail.license.terms}</p>
            <div><p className="font-medium">{t('marketplace.instructions')}</p><p className="text-muted-foreground">{detail.agent.instructions}</p></div>
            <div><p className="font-medium">{t('marketplace.history')}</p><ul className="list-disc ps-5" data-testid="market-history">{detail.history.map((h) => <li key={h.version}>v{h.version} · {fmt(h.publishedAt)} — {h.changelog}</li>)}</ul></div>
            <p className="text-xs text-muted-foreground">{detail.reviews.note}</p>
            <div><Button size="sm" variant="outline" onClick={() => setDetail(null)}>{t('marketplace.close')}</Button></div>
          </CardContent></Card>
      )}
    </div>
  );
}
