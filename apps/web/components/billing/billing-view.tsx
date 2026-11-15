'use client';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

interface Status {
  enabled: boolean;
  plans: Array<{ code: string; name: string; description: string | null; priceAmount: string; currency: string; interval: string }>;
  provider: { id: string; live: boolean; recurringSubscriptions: string; verifiedAgainstOfficialDocs: boolean } | null;
  entitlement: { state: string; hasAccess: boolean; chargeable: boolean; accessUntil: string | null };
  subscription: { status: string; plan: string; trialEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; cardSaved: boolean; subscribed: boolean; failedPayments: number } | null;
  providerMigration: { required: boolean; from: string | null };
}
interface History {
  payments: Array<{ id: string; amount: string; currency: string; status: string; paidAt: string | null; createdAt: string }>;
  events: Array<{ id: string; action: string; at: string; eventType: string | null }>;
}

/** Subscription and payment history for the active business. Every decision is made by the server; this screen only shows it and sends the owner's explicit actions. */
export function BillingView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const status = useResource<Status>('/billing/status', active?.id);
  const history = useResource<History>('/billing/history', active?.id);
  const [plan, setPlan] = useState('STARTER');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const manage = can('billing.manage');
  const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—');

  async function act(path: string, body: object = {}) {
    if (!active) return;
    setPending(path);
    setError(null);
    setNote(null);
    try {
      const res = await api<{ hostedUrl?: string }>(`/billing/${path}`, { method: 'POST', json: body, businessId: active.id });
      if (path === 'card-setup' && res.hostedUrl) setNote(status.data?.provider?.live ? res.hostedUrl : t('billing.simulatedCardPage'));
      await Promise.all([status.reload(), history.reload()]);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setPending(null);
    }
  }

  if (status.loading && !status.data) return <p className="text-sm text-muted-foreground" aria-busy="true" data-testid="billing-loading"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  if (status.error || !status.data) {
    const off = status.error instanceof ApiError && status.error.status === 404;
    return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="billing-unavailable">{off ? t('billing.notEnabled') : t('billing.loadFailed')}</p>;
  }
  const s = status.data;
  const sub = s.subscription;
  const state = s.entitlement.state;
  const errText = error ? (t(`billing.errors.${error.code}`).startsWith('billing.errors.') ? error.message : t(`billing.errors.${error.code}`)) : null;
  const providerNote = !s.provider ? t('billing.providerNone') : s.provider.id === 'simulated' ? t('billing.providerSimulated') : !s.provider.verifiedAgainstOfficialDocs ? t('billing.providerUnverified') : null;

  return (
    <div className="grid gap-4" data-testid="billing-view">
      {providerNote && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="billing-provider-note">{providerNote}</p>}
      {s.providerMigration.required && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" role="status">{t('billing.migrationNeeded')}</p>}
      {errText && <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm" role="alert" data-testid="billing-error">{errText}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">{t('billing.currentTitle')} <Badge variant={s.entitlement.hasAccess ? 'default' : 'muted'} data-testid="billing-state">{t(`billing.states.${state}`)}</Badge></CardTitle>
          <CardDescription>{state === 'FOUNDER_LIFETIME' ? t('billing.founderNote') : t(`billing.stateHelp.${state}`)}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {sub && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t('billing.plan')}</dt><dd>{sub.plan}</dd>
              {sub.status === 'TRIALING' && <><dt className="text-muted-foreground">{t('billing.trialEnds')}</dt><dd>{fmt(sub.trialEndsAt)}</dd></>}
              {sub.currentPeriodEnd && <><dt className="text-muted-foreground">{t('billing.periodEnd')}</dt><dd>{fmt(sub.currentPeriodEnd)}</dd></>}
              <dt className="text-muted-foreground">{t('billing.card')}</dt><dd>{sub.cardSaved ? t('billing.cardSaved') : t('billing.cardMissing')}</dd>
              {sub.failedPayments > 0 && <><dt className="text-muted-foreground">{t('billing.failedPayments')}</dt><dd data-testid="billing-failed">{sub.failedPayments}</dd></>}
              {sub.cancelAtPeriodEnd && <><dt className="text-muted-foreground">{t('billing.cancellation')}</dt><dd data-testid="billing-cancel-pending">{t('billing.cancelPending')}</dd></>}
            </dl>
          )}
          {note && <p className="rounded-md border px-3 py-2" data-testid="billing-card-note">{note}</p>}
          {manage && state !== 'FOUNDER_LIFETIME' && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {!sub && (
                <>
                  <select className="h-9 rounded-md border bg-background px-2 text-sm" value={plan} onChange={(e) => setPlan(e.target.value)} aria-label={t('billing.plan')} data-testid="billing-plan">
                    {s.plans.map((p) => <option key={p.code} value={p.code}>{p.name} — {p.priceAmount} {p.currency}</option>)}
                  </select>
                  <Button onClick={() => void act('trial', { plan })} disabled={pending !== null} data-testid="billing-start-trial">{pending === 'trial' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('billing.startTrial')}</Button>
                </>
              )}
              {sub && !sub.cardSaved && <Button onClick={() => void act('card-setup', { returnUrl: `${window.location.origin}/dashboard/billing` })} disabled={pending !== null} data-testid="billing-card-setup">{t('billing.saveCard')}</Button>}
              {sub && sub.cardSaved && !sub.subscribed && <Button onClick={() => void act('subscribe')} disabled={pending !== null} data-testid="billing-subscribe">{t('billing.subscribe')}</Button>}
              {sub && sub.subscribed && !sub.cancelAtPeriodEnd && <Button variant="outline" onClick={() => void act('cancel')} disabled={pending !== null} data-testid="billing-cancel">{t('billing.cancel')}</Button>}
              {sub && sub.cancelAtPeriodEnd && sub.status !== 'CANCELED' && <Button variant="outline" onClick={() => void act('resume')} disabled={pending !== null} data-testid="billing-resume">{t('billing.resume')}</Button>}
            </div>
          )}
          {!manage && <p className="text-muted-foreground">{t('billing.ownerOnly')}</p>}
          <p className="text-xs text-muted-foreground">{t('billing.trialTerms')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('billing.historyTitle')}</CardTitle></CardHeader>
        <CardContent>
          {history.data && history.data.payments.length === 0 && history.data.events.length === 0 && <p className="text-sm text-muted-foreground" data-testid="billing-history-empty">{t('billing.historyEmpty')}</p>}
          <ul className="grid gap-1 text-sm" data-testid="billing-history">
            {history.data?.payments.map((p) => <li key={p.id} className="flex justify-between gap-3"><span>{fmt(p.paidAt ?? p.createdAt)}</span><span>{p.amount} {p.currency}</span><Badge variant="muted">{t(`billing.payment.${p.status}`)}</Badge></li>)}
            {history.data?.events.map((e) => <li key={e.id} className="flex justify-between gap-3 text-muted-foreground"><span>{fmt(e.at)}</span><span>{(() => { const k = `billing.event.${e.action.replace(/\./g, '_')}`; const m = t(k); return m === k ? e.action : m; })()}</span></li>)}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
