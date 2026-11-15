'use client';
import { Loader2 } from 'lucide-react';
import { formatMinor } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';
import { useEffect, useState } from 'react';

interface Overview {
  subscriptions: { activePaid: number; trialing: number; pending: number; pastDue: number; gracePeriod: number; canceled: number; expired: number };
  failedPayments: { last30Days: number; recent: Array<{ id: string; amountMinor: number; currency: string; failureCode: string | null; simulated: boolean; createdAt: string }> };
  revenue: { simulated: Array<{ currency: string; amountMinor: number; invoices: number }>; real: Array<{ currency: string; amountMinor: number; invoices: number }>; note: string };
  upcomingRenewals: Array<{ businessId: string; business: string; mode: string; interval: string; amountMinor: number; currency: string; at: string; trial: boolean }>;
  events: Array<{ id: string; businessId: string; action: string; fromStatus: string | null; toStatus: string | null; reason: string | null; createdAt: string }>;
  providers: Array<{ provider: string; label: string; enabled: boolean; verifiedAt: string | null; capabilities: { recurringSubscriptions: string; verifiedAgainstOfficialDocs: boolean } }>;
}

/** Platform administrators: subscriptions by state, failures, SIMULATED revenue (never presented as collected money), upcoming renewals, events and provider readiness. */
export function BillingAdminView() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { api<Overview>('/admin/billing/overview').then(setData).catch((e) => setError(e instanceof ApiError ? e : null)); }, []);
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  if (error) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="billing-admin-error">{error.status === 404 ? t('billing.notEnabled') : t('billing.loadFailed')}</p>;
  if (!data) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const s = data.subscriptions;
  const counters: Array<[string, number]> = [['activePaid', s.activePaid], ['trialing', s.trialing], ['pending', s.pending], ['pastDue', s.pastDue], ['gracePeriod', s.gracePeriod], ['canceled', s.canceled], ['expired', s.expired]];
  return (
    <div className="grid gap-4" data-testid="billing-admin">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counters.map(([k, v]) => <Card key={k}><CardContent className="p-4"><p className="text-2xl font-bold" data-testid={`admin-count-${k}`}>{v}</p><p className="text-xs text-muted-foreground">{t(`billing.admin.${k}`)}</p></CardContent></Card>)}
        <Card><CardContent className="p-4"><p className="text-2xl font-bold" data-testid="admin-failed">{data.failedPayments.last30Days}</p><p className="text-xs text-muted-foreground">{t('billing.admin.failed30')}</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.revenueTitle')}</CardTitle><CardDescription data-testid="admin-revenue-note">{t('billing.admin.revenueNote')}</CardDescription></CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {data.revenue.simulated.length === 0 && data.revenue.real.length === 0 && <p className="text-muted-foreground">{t('billing.admin.noRevenue')}</p>}
          {data.revenue.simulated.map((r) => <p key={`s${r.currency}`} data-testid="admin-revenue-simulated">{formatMinor(r.amountMinor, r.currency, locale)} <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs">{t('billing.simulatedTag')}</span> · {r.invoices}</p>)}
          {data.revenue.real.map((r) => <p key={`r${r.currency}`}>{formatMinor(r.amountMinor, r.currency, locale)} · {r.invoices}</p>)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.upcomingTitle')}</CardTitle></CardHeader>
        <CardContent>
          {data.upcomingRenewals.length === 0 ? <p className="text-sm text-muted-foreground">{t('billing.historyEmpty')}</p> : (
            <ul className="grid gap-1 text-sm" data-testid="admin-upcoming">{data.upcomingRenewals.map((u) => <li key={u.businessId} className="flex flex-wrap justify-between gap-2"><span>{u.business}</span><span>{fmt(u.at)}</span><span>{formatMinor(u.amountMinor, u.currency, locale)} · {t(`billing.modes.${u.mode}`)}</span></li>)}</ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.providersTitle')}</CardTitle><CardDescription>{t('billing.admin.providersHelp')}</CardDescription></CardHeader>
        <CardContent><ul className="grid gap-1 text-sm" data-testid="admin-providers">{data.providers.map((p) => <li key={p.provider} className="flex justify-between gap-2"><span>{p.label}</span><span className="text-muted-foreground">{p.enabled ? t('billing.admin.enabled') : t('billing.admin.disabled')} · {t(`billing.admin.cap.${p.capabilities.recurringSubscriptions}`)}</span></li>)}</ul></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.eventsTitle')}</CardTitle></CardHeader>
        <CardContent><ul className="grid gap-1 text-xs text-muted-foreground" data-testid="admin-events">{data.events.slice(0, 20).map((e) => <li key={e.id} className="flex justify-between gap-2"><span>{fmt(e.createdAt)}</span><span>{e.action.replace(/_/g, ' ')}{e.toStatus ? ` ${e.fromStatus ?? ''}→${e.toStatus}` : ''}</span></li>)}</ul></CardContent>
      </Card>
    </div>
  );
}
