'use client';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatMinor } from '@touma/shared';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

interface Overview {
  subscriptions: { activePaid: number; trialing: number; pending: number; pastDue: number; gracePeriod: number; canceled: number; expired: number };
  failedPayments: { last30Days: number; recent: Array<{ id: string; amountMinor: number; currency: string; failureCode: string | null; simulated: boolean; createdAt: string }> };
  revenue: { simulated: Array<{ currency: string; amountMinor: number; invoices: number }>; real: Array<{ currency: string; amountMinor: number; invoices: number }>; note: string };
  upcomingRenewals: Array<{ businessId: string; business: string; mode: string; interval: string; amountMinor: number; currency: string; at: string; trial: boolean }>;
  events: Array<{ id: string; businessId: string; action: string; fromStatus: string | null; toStatus: string | null; reason: string | null; createdAt: string }>;
  environment: string;
  incidents: { windowDays: number; counts: Record<string, number>; failedNotifications: number; ignoredNotifications: number; recent: Array<{ id: string; businessId: string; action: string; reason: string | null; createdAt: string }> };
  providers: Array<{
    provider: string; label: string; enabled: boolean; verifiedAt: string | null; capabilities: { recurringSubscriptions: string; verifiedAgainstOfficialDocs: boolean };
    approval: { status: string; reference: string | null; note: string | null };
    productionGate: { allowed: boolean; reasons: string[] };
  }>;
}
interface SubRow { id: string; business: string; plan: string; status: string; mode: string; interval: string; amountMinor: number; currency: string; periodEnd: string | null; failedPayments: number; provider: string }
const APPROVABLE = ['payoneer', 'iyzico', 'paddle-sandbox', 'lemonsqueezy'];
const STATUSES = ['NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'];

/** Platform administrators: subscriptions by state, failures, SIMULATED revenue (never presented as collected money), upcoming renewals, events and provider readiness. */
export function BillingAdminView({ canApprove = false }: { canApprove?: boolean }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState('');
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [form, setForm] = useState<{ provider: string; status: string; reference: string; note: string }>({ provider: 'paddle-sandbox', status: 'PENDING_REVIEW', reference: '', note: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const load = useCallback(() => { api<Overview>('/admin/billing/overview').then(setData).catch((e) => setError(e instanceof ApiError ? e : null)); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<{ items: SubRow[] }>(`/admin/billing/subscriptions${filter ? `?status=${filter}` : ''}`).then((r) => setSubs(r.items)).catch(() => setSubs([])); }, [filter]);
  async function saveApproval() {
    setFormError(null);
    try { await api(`/admin/billing/providers/${form.provider}/approval`, { method: 'PUT', json: { status: form.status, reference: form.reference || undefined, note: form.note || undefined } }); load(); } catch (e) { setFormError(e instanceof ApiError ? e.message : 'error'); }
  }
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
        <CardHeader><CardTitle>{t('billing.admin.approvalTitle')}</CardTitle><CardDescription>{t('billing.admin.approvalHelp')}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p className="text-xs text-muted-foreground">{t('billing.admin.environment')}: <span data-testid="admin-environment">{data.environment}</span></p>
          <ul className="grid gap-2" data-testid="admin-providers">
            {data.providers.map((p) => (
              <li key={p.provider} className="rounded-md border p-2" data-testid={`admin-provider-${p.provider}`}>
                <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{p.label}</span><span className="text-muted-foreground">{p.enabled ? t('billing.admin.enabled') : t('billing.admin.disabled')} · {p.capabilities.recurringSubscriptions === 'sandbox' ? t('billing.admin.cap.sandbox') : t(`billing.admin.cap.${p.capabilities.recurringSubscriptions}`)}</span></div>
                <div className="mt-1 flex flex-wrap items-center gap-2"><Badge variant="muted" data-testid={`admin-approval-${p.provider}`}>{t(`billing.admin.status.${p.approval.status}`)}</Badge>{p.approval.reference && <span className="font-mono text-xs">{p.approval.reference}</span>}</div>
                <p className="mt-1 text-xs text-muted-foreground" data-testid={`admin-gate-${p.provider}`}>{p.productionGate.allowed ? '' : `${t('billing.admin.blocked')}: ${p.productionGate.reasons.map((r) => t(`billing.admin.reason.${r}`)).join(' · ')}`}</p>
              </li>
            ))}
          </ul>
          {canApprove && (
            <div className="grid gap-2 rounded-md border border-dashed p-3" data-testid="admin-approval-form">
              <select className="h-9 rounded-md border bg-background px-2" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} aria-label="provider">{APPROVABLE.map((p) => <option key={p} value={p}>{p}</option>)}</select>
              <select className="h-9 rounded-md border bg-background px-2" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} aria-label={t('billing.admin.approvalStatus')} data-testid="admin-approval-status">{STATUSES.map((st) => <option key={st} value={st}>{t(`billing.admin.status.${st}`)}</option>)}</select>
              <input className="h-9 rounded-md border bg-background px-2" placeholder={t('billing.admin.approvalReference')} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} data-testid="admin-approval-reference" />
              <input className="h-9 rounded-md border bg-background px-2" placeholder={t('billing.admin.approvalNote')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              {formError && <p className="text-xs text-destructive" role="alert" data-testid="admin-approval-error">{formError}</p>}
              <div><Button size="sm" onClick={() => void saveApproval()} data-testid="admin-approval-save">{t('billing.admin.approvalSave')}</Button></div>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.incidentsTitle')}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p className="text-xs text-muted-foreground">{t('billing.admin.failedNotifications')}: <span data-testid="admin-failed-notifications">{data.incidents.failedNotifications}</span> · {t('billing.admin.ignoredNotifications')}: {data.incidents.ignoredNotifications}</p>
          {data.incidents.recent.length === 0 ? <p className="text-muted-foreground" data-testid="admin-incidents-empty">{t('billing.admin.incidentsEmpty')}</p> : (
            <ul className="grid gap-1 text-xs" data-testid="admin-incidents">{data.incidents.recent.slice(0, 20).map((i) => <li key={i.id} className="flex justify-between gap-2"><span>{fmt(i.createdAt)}</span><span>{i.action.replace(/_/g, ' ')}{i.reason ? ` — ${i.reason}` : ''}</span></li>)}</ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.subscriptionsTitle')}</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <select className="h-9 w-fit rounded-md border bg-background px-2" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('billing.admin.subscriptionsTitle')} data-testid="admin-sub-filter">
            <option value="">{t('billing.admin.filterAll')}</option>{['PENDING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELED', 'EXPIRED'].map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
          <ul className="grid gap-1" data-testid="admin-subscriptions">{subs.map((r) => <li key={r.id} className="flex flex-wrap justify-between gap-2"><span>{r.business}</span><span>{r.plan} · {t(`billing.interval.${r.interval}`)}</span><span>{formatMinor(r.amountMinor, r.currency, locale)}</span><span className="text-muted-foreground">{r.status}{r.failedPayments ? ` (${r.failedPayments})` : ''}</span></li>)}</ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('billing.admin.eventsTitle')}</CardTitle></CardHeader>
        <CardContent><ul className="grid gap-1 text-xs text-muted-foreground" data-testid="admin-events">{data.events.slice(0, 20).map((e) => <li key={e.id} className="flex justify-between gap-2"><span>{fmt(e.createdAt)}</span><span>{e.action.replace(/_/g, ' ')}{e.toStatus ? ` ${e.fromStatus ?? ''}→${e.toStatus}` : ''}</span></li>)}</ul></CardContent>
      </Card>
    </div>
  );
}
