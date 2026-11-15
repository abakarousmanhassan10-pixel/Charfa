'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { formatMinor } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

type Mode = 'AUTO' | 'MANUAL';
type Interval = 'MONTHLY' | 'YEARLY';
interface Plan { code: string; name: string; description: string | null; currency: string; priceAmountMinor: number; yearlyPriceAmountMinor: number }
interface Status {
  enabled: boolean;
  simulation: boolean;
  graceDays: number;
  reminderDays: number;
  plans: Plan[];
  provider: { id: string; live: boolean; recurringSubscriptions: string; hostedPaymentSession: string; methods: string[]; verifiedAgainstOfficialDocs: boolean } | null;
  entitlement: { state: string; hasAccess: boolean; chargeable: boolean; accessUntil: string | null };
  subscription: {
    status: string; plan: string; billingMode: Mode; billingInterval: Interval; amountMinor: number; currency: string; trial: boolean; trialEndsAt: string | null; currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean; autoRenewConsentAt: string | null; cardSaved: boolean; subscribed: boolean; failedPayments: number; pendingChange: { plan: string; billingInterval: Interval } | null;
  } | null;
  nextPayment: { at: string | null; amountMinor: number; currency: string; mode: Mode; plan: string; interval: Interval } | null;
  renewalOpen: boolean;
  providerMigration: { required: boolean; from: string | null };
}
interface Invoice { id: string; number: string; status: string; amountMinor: number; currency: string; planCode: string; description: string | null; periodStart: string; periodEnd: string; issuedAt: string; paidAt: string | null; simulated: boolean }
interface History {
  payments: Array<{ id: string; amountMinor: number; currency: string; status: string; kind: string | null; simulated: boolean; paidAt: string | null; createdAt: string }>;
  events: Array<{ id: string; action: string; from: string | null; to: string | null; at: string }>;
}
interface Session { paymentId: string; hostedUrl: string | null; amountMinor: number; currency: string; periodStart: string; periodEnd: string; simulated: boolean }

/** Subscription, renewal and invoices for the active business. Every decision is made by the server; this screen only shows it and sends the owner's explicit actions. */
export function BillingView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const status = useResource<Status>('/billing/status', active?.id);
  const history = useResource<History>('/billing/history', active?.id);
  const invoices = useResource<Invoice[]>('/billing/invoices', active?.id);
  const [plan, setPlan] = useState('STARTER');
  const [interval, setIntervalValue] = useState<Interval>('MONTHLY');
  const [mode, setMode] = useState<Mode>('MANUAL');
  const [consent, setConsent] = useState(false);
  const [changePlan, setChangePlan] = useState('');
  const [changeInterval, setChangeInterval] = useState<Interval>('MONTHLY');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const manage = can('billing.manage');
  const tz = active?.timezone;
  const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) : '—');
  const money = (minor: number, currency: string) => formatMinor(minor, currency, locale);

  async function act<T = unknown>(path: string, body: object = {}): Promise<T | null> {
    if (!active) return null;
    setPending(path);
    setError(null);
    setNote(null);
    try {
      const res = await api<T>(`/billing/${path}`, { method: 'POST', json: body, businessId: active.id });
      await Promise.all([status.reload(), history.reload(), invoices.reload()]);
      return res;
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
      return null;
    } finally {
      setPending(null);
    }
  }
  const returnUrl = () => `${window.location.origin}/dashboard/billing`;

  if (status.loading && !status.data) return <p className="text-sm text-muted-foreground" aria-busy="true" data-testid="billing-loading"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  if (status.error || !status.data) {
    const off = status.error instanceof ApiError && status.error.status === 404;
    return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="billing-unavailable">{off ? t('billing.notEnabled') : t('billing.loadFailed')}</p>;
  }
  const s = status.data;
  const sub = s.subscription;
  const state = s.entitlement.state;
  const founder = state === 'FOUNDER_LIFETIME';
  const busy = pending !== null;
  const errText = error ? (t(`billing.errors.${error.code}`).startsWith('billing.errors.') ? error.message : t(`billing.errors.${error.code}`)) : null;
  const providerNote = !s.provider ? t('billing.providerNone') : s.provider.id === 'simulated' ? t('billing.providerSimulated') : !s.provider.verifiedAgainstOfficialDocs ? t('billing.providerUnverified') : null;
  const priceOf = (p: Plan, i: Interval) => (i === 'YEARLY' ? p.yearlyPriceAmountMinor : p.priceAmountMinor);
  const planChoice = s.plans.find((p) => p.code === plan);

  async function renew() {
    const res = await act<Session>('renewals', { returnUrl: returnUrl() });
    if (res) { setSession(res); if (!s.simulation) setNote(res.hostedUrl); }
  }
  async function simulate(path: 'confirm' | 'due', outcome: 'success' | 'declined') {
    const res = await act(`simulator/${path}`, path === 'confirm' ? { paymentId: session?.paymentId, outcome } : { outcome });
    if (res && path === 'confirm') setSession(null);
  }

  return (
    <div className="grid gap-4" data-testid="billing-view">
      {s.simulation && <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm font-medium" role="status" data-testid="billing-simulation-banner">{t('billing.simulationBanner')}</p>}
      {providerNote && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="billing-provider-note">{providerNote}</p>}
      {s.providerMigration.required && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" role="status">{t('billing.migrationNeeded')}</p>}
      {errText && <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm" role="alert" data-testid="billing-error">{errText}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">{t('billing.currentTitle')} <Badge variant={s.entitlement.hasAccess ? 'default' : 'muted'} data-testid="billing-state">{t(`billing.states.${state}`)}</Badge></CardTitle>
          <CardDescription>{founder ? t('billing.founderNote') : t(`billing.stateHelp.${state}`)}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {sub && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t('billing.plan')}</dt><dd data-testid="billing-plan-current">{sub.plan} · {t(`billing.interval.${sub.billingInterval}`)}</dd>
              <dt className="text-muted-foreground">{t('billing.mode')}</dt><dd data-testid="billing-mode">{t(`billing.modes.${sub.billingMode}`)}</dd>
              <dt className="text-muted-foreground">{t('billing.amount')}</dt><dd>{money(sub.amountMinor, sub.currency)}</dd>
              {sub.trial && <><dt className="text-muted-foreground">{t('billing.trialEnds')}</dt><dd>{fmt(sub.trialEndsAt)}</dd></>}
              {!sub.trial && sub.currentPeriodEnd && <><dt className="text-muted-foreground">{t('billing.periodEnd')}</dt><dd>{fmt(sub.currentPeriodEnd)}</dd></>}
              {s.nextPayment && <><dt className="text-muted-foreground">{t('billing.nextPayment')}</dt><dd data-testid="billing-next-payment">{money(s.nextPayment.amountMinor, s.nextPayment.currency)} · {s.nextPayment.at ? fmt(s.nextPayment.at) : t('billing.afterFirstPayment')} · {t(`billing.modes.${s.nextPayment.mode}`)}</dd></>}
              {sub.billingMode === 'AUTO' && <><dt className="text-muted-foreground">{t('billing.card')}</dt><dd>{sub.cardSaved ? t('billing.cardSaved') : t('billing.cardMissing')}</dd></>}
              {sub.failedPayments > 0 && <><dt className="text-muted-foreground">{t('billing.failedPayments')}</dt><dd data-testid="billing-failed">{sub.failedPayments}</dd></>}
              {sub.pendingChange && <><dt className="text-muted-foreground">{t('billing.pendingChange')}</dt><dd data-testid="billing-pending-change">{sub.pendingChange.plan} · {t(`billing.interval.${sub.pendingChange.billingInterval}`)} — {t('billing.atNextRenewal')}</dd></>}
              {sub.cancelAtPeriodEnd && <><dt className="text-muted-foreground">{t('billing.cancellation')}</dt><dd data-testid="billing-cancel-pending">{t('billing.cancelPending')}</dd></>}
            </dl>
          )}
          {!founder && <p className="text-xs text-muted-foreground">{t('billing.graceInfo', { days: s.graceDays })}</p>}

          {manage && !founder && !sub && (
            <div className="grid gap-3 rounded-md border p-3" data-testid="billing-start">
              <label className="grid gap-1">{t('billing.plan')}
                <select className="h-9 rounded-md border bg-background px-2" value={plan} onChange={(e) => setPlan(e.target.value)} data-testid="billing-plan">
                  {s.plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                </select>
              </label>
              <fieldset className="grid gap-1"><legend className="mb-1">{t('billing.chooseInterval')}</legend>
                {(['MONTHLY', 'YEARLY'] as const).map((i) => (
                  <label key={i} className="flex items-center gap-2"><input type="radio" name="interval" checked={interval === i} onChange={() => setIntervalValue(i)} data-testid={`billing-interval-${i}`} />{t(`billing.interval.${i}`)}{planChoice && <span className="text-muted-foreground"> — {money(priceOf(planChoice, i), planChoice.currency)}</span>}</label>
                ))}
              </fieldset>
              <fieldset className="grid gap-1"><legend className="mb-1">{t('billing.chooseMode')}</legend>
                {(['MANUAL', 'AUTO'] as const).map((m) => (
                  <label key={m} className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1" checked={mode === m} onChange={() => setMode(m)} data-testid={`billing-mode-${m}`} /><span>{t(`billing.modes.${m}`)}<span className="block text-xs text-muted-foreground">{t(`billing.modeHelp.${m}`)}</span></span></label>
                ))}
              </fieldset>
              {mode === 'AUTO' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="billing-consent" />{t('billing.consent')}</label>}
              <div><Button onClick={() => void act('trial', { plan, billingMode: mode, billingInterval: interval, ...(mode === 'AUTO' ? { autoRenewConsent: consent } : {}) })} disabled={busy || (mode === 'AUTO' && !consent)} data-testid="billing-start-trial">{pending === 'trial' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('billing.startTrial')}</Button></div>
            </div>
          )}

          {manage && !founder && sub && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {s.renewalOpen && <Button onClick={() => void renew()} disabled={busy} data-testid="billing-renew">{pending === 'renewals' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('billing.renew')}</Button>}
              {sub.billingMode === 'AUTO' && !sub.cardSaved && <Button variant="outline" onClick={async () => { const r = await act<{ hostedUrl: string }>('card-setup', { returnUrl: returnUrl() }); if (r) setNote(s.simulation ? t('billing.simulatedCardPage') : r.hostedUrl); }} disabled={busy} data-testid="billing-card-setup">{t('billing.saveCard')}</Button>}
              {sub.billingMode === 'AUTO' && sub.cardSaved && !sub.subscribed && <Button variant="outline" onClick={() => void act('subscribe')} disabled={busy} data-testid="billing-subscribe">{t('billing.subscribe')}</Button>}
              {sub.billingMode === 'AUTO' && <Button variant="outline" onClick={() => void act('mode', { billingMode: 'MANUAL' })} disabled={busy} data-testid="billing-disable-auto">{t('billing.disableAuto')}</Button>}
              {sub.billingMode === 'MANUAL' && <Button variant="outline" onClick={() => setConsent((c) => !c)} data-testid="billing-enable-auto-toggle">{t('billing.enableAuto')}</Button>}
              {sub.status !== 'EXPIRED' && sub.status !== 'CANCELED' && !sub.cancelAtPeriodEnd && <Button variant="ghost" onClick={() => void act('cancel')} disabled={busy} data-testid="billing-cancel">{t('billing.cancel')}</Button>}
              {sub.cancelAtPeriodEnd && ['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'].includes(sub.status) && <Button variant="outline" onClick={() => void act('resume')} disabled={busy} data-testid="billing-resume">{t('billing.resume')}</Button>}
            </div>
          )}
          {manage && !founder && sub && sub.billingMode === 'MANUAL' && consent && (
            <div className="grid gap-2 rounded-md border p-3" data-testid="billing-enable-auto">
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked readOnly />{t('billing.consent')}</label>
              <div><Button size="sm" onClick={() => void act('mode', { billingMode: 'AUTO', autoRenewConsent: true })} disabled={busy} data-testid="billing-enable-auto-confirm">{t('billing.enableAutoConfirm')}</Button></div>
            </div>
          )}
          {note && <p className="rounded-md border px-3 py-2" data-testid="billing-card-note">{note}</p>}
          {manage && !founder && s.simulation && sub?.billingMode === 'AUTO' && !sub.cardSaved && note && (
            <div><Button size="sm" variant="outline" onClick={() => void act('simulator/card-saved')} disabled={busy} data-testid="billing-sim-card">{t('billing.simCardSaved')}</Button></div>
          )}

          {session && (
            <div className="grid gap-2 rounded-md border p-3" data-testid="billing-session">
              <p className="font-medium">{t('billing.sessionTitle', { amount: money(session.amountMinor, session.currency) })}</p>
              <p className="text-muted-foreground">{s.simulation ? t('billing.simulatedPaymentPage') : t('billing.redirectToProvider')}</p>
              {s.simulation && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void simulate('confirm', 'success')} disabled={busy} data-testid="billing-sim-success">{t('billing.simSuccess')}</Button>
                  <Button size="sm" variant="outline" onClick={() => void simulate('confirm', 'declined')} disabled={busy} data-testid="billing-sim-declined">{t('billing.simDeclined')}</Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t('billing.waitForConfirmation')}</p>
            </div>
          )}
          {manage && !founder && sub?.subscribed && s.simulation && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3" data-testid="billing-sim-due">
              <span className="text-xs text-muted-foreground">{t('billing.simDueHelp')}</span>
              <Button size="sm" variant="outline" onClick={() => void simulate('due', 'success')} disabled={busy} data-testid="billing-sim-due-success">{t('billing.simDueSuccess')}</Button>
              <Button size="sm" variant="outline" onClick={() => void simulate('due', 'declined')} disabled={busy} data-testid="billing-sim-due-declined">{t('billing.simDueDeclined')}</Button>
            </div>
          )}
          {!manage && <p className="text-muted-foreground">{t('billing.ownerOnly')}</p>}
          <p className="text-xs text-muted-foreground">{t('billing.trialTerms')}</p>
        </CardContent>
      </Card>

      {manage && !founder && sub && sub.status !== 'EXPIRED' && sub.status !== 'CANCELED' && (
        <Card>
          <CardHeader><CardTitle>{t('billing.changePlanTitle')}</CardTitle><CardDescription>{t('billing.changePlanHelp')}</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            <select className="h-9 rounded-md border bg-background px-2" value={changePlan || sub.plan} onChange={(e) => setChangePlan(e.target.value)} aria-label={t('billing.plan')} data-testid="billing-change-plan">
              {s.plans.map((p) => <option key={p.code} value={p.code}>{p.name} — {money(priceOf(p, changeInterval), p.currency)}</option>)}
            </select>
            <select className="h-9 rounded-md border bg-background px-2" value={changeInterval} onChange={(e) => setChangeInterval(e.target.value as Interval)} aria-label={t('billing.chooseInterval')} data-testid="billing-change-interval">
              <option value="MONTHLY">{t('billing.interval.MONTHLY')}</option><option value="YEARLY">{t('billing.interval.YEARLY')}</option>
            </select>
            <Button size="sm" variant="outline" onClick={() => void act('plan', { plan: changePlan || sub.plan, billingInterval: changeInterval })} disabled={busy} data-testid="billing-change-submit">{t('billing.changePlanSubmit')}</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t('billing.methodsTitle')}</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground" data-testid="billing-methods">
          {s.provider && s.provider.methods.length > 0 ? t('billing.methodsSimulated') : t('billing.methodsUnverified')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('billing.invoicesTitle')}</CardTitle></CardHeader>
        <CardContent>
          {invoices.data && invoices.data.length === 0 && <p className="text-sm text-muted-foreground" data-testid="billing-invoices-empty">{t('billing.invoicesEmpty')}</p>}
          <ul className="grid gap-1 text-sm" data-testid="billing-invoices">
            {invoices.data?.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="billing-invoice">
                <span className="font-mono text-xs">{i.number}</span>
                <span>{fmt(i.issuedAt)}</span>
                <span>{money(i.amountMinor, i.currency)}</span>
                <span className="flex gap-1"><Badge variant="muted">{t(`billing.invoiceStatus.${i.status}`)}</Badge>{i.simulated && <Badge variant="muted" data-testid="billing-invoice-simulated">{t('billing.simulatedTag')}</Badge>}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('billing.historyTitle')}</CardTitle></CardHeader>
        <CardContent>
          {history.data && history.data.payments.length === 0 && history.data.events.length === 0 && <p className="text-sm text-muted-foreground" data-testid="billing-history-empty">{t('billing.historyEmpty')}</p>}
          <ul className="grid gap-1 text-sm" data-testid="billing-history">
            {history.data?.payments.map((p) => <li key={p.id} className="flex justify-between gap-3"><span>{fmt(p.paidAt ?? p.createdAt)}</span><span>{money(p.amountMinor, p.currency)}</span><Badge variant="muted">{t(`billing.payment.${p.status}`)}</Badge></li>)}
            {history.data?.events.map((e) => <li key={e.id} className="flex justify-between gap-3 text-muted-foreground"><span>{fmt(e.at)}</span><span>{(() => { const k = `billing.event.${e.action}`; const m = t(k); return m === k ? e.action.replace(/_/g, ' ') : m; })()}{e.to ? ` → ${t(`billing.states.${e.to}`).startsWith('billing.states.') ? e.to : t(`billing.states.${e.to}`)}` : ''}</span></li>)}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
