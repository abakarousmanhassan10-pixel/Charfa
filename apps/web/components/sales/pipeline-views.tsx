'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import { IntentBadge, LeadBadge, flag } from './badges';
import type { Intent, LeadStatus } from './types';

interface LeadItem { id: string; name: string | null; email: string | null; phone: string | null; purchaseIntent: Intent; lastIntent: string | null; interests: string[]; lastSeenAt: string; followUpAt: string | null }
const STAGES: LeadStatus[] = ['ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'WON', 'LOST'];

/** Customers by lead stage. Stages move forward automatically with what the customer says and shares; a person sets WON and LOST. */
export function LeadsView() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const res = useResource<{ groups: Record<string, LeadItem[]> }>('/sales/leads', active?.id);
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  if (res.loading && !res.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (res.error && !res.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void res.reload()} />;
  const total = STAGES.reduce((s, k) => s + (res.data?.groups[k]?.length ?? 0), 0);
  if (total === 0) return <Card><CardContent className="pt-6"><EmptyState title={t('sales.leads.emptyTitle')} hint={t('sales.leads.emptyHint')} /></CardContent></Card>;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5" data-testid="lead-board">
      {STAGES.map((s) => (
        <section key={s} className="grid content-start gap-2 rounded-xl border p-3" data-testid="lead-column" data-stage={s} aria-label={t(`sales.lead.${s}`)}>
          <h2 className="flex items-center justify-between text-sm font-semibold"><LeadBadge status={s} /><span className="text-muted-foreground">{res.data?.groups[s]?.length ?? 0}</span></h2>
          {(res.data?.groups[s] ?? []).map((c) => (
            <Link key={c.id} href="/dashboard/sales/customers" className="rounded-lg border bg-background p-2.5 text-sm hover:bg-muted/50" data-testid="lead-card">
              <span className="font-medium">{c.name ?? t('sales.anonymousVisitor')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{c.lastIntent ? t(`sales.intent.${c.lastIntent}`) : '—'} · {fmt(c.lastSeenAt)}</span>
              <span className="mt-1 flex flex-wrap gap-1"><IntentBadge intent={c.purchaseIntent} />{(c.email || c.phone) && <span className="text-xs text-muted-foreground">{t('sales.leads.hasContact')}</span>}</span>
            </Link>
          ))}
        </section>
      ))}
    </div>
  );
}

interface Opp { customer: { id: string; name: string | null; email: string | null; phone: string | null; leadStatus: LeadStatus; purchaseIntent: Intent; lastSeenAt: string; followUpAt: string | null }; products: Array<{ id: string; name: string; price: string | null; currency: string | null; availability: string }> }
interface FollowUp { type: string; priority: 'HIGH' | 'MEDIUM' | 'LOW'; conversationId?: string; customerId?: string; reason: string; since: string }

/** Sales opportunities (what to close) and follow-up recommendations (what to do next and why). */
export function OpportunitiesView() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const opp = useResource<{ items: Opp[] }>('/sales/opportunities', active?.id);
  const fu = useResource<{ items: FollowUp[] }>('/sales/follow-ups', active?.id);
  const money = (v: string | null, c: string | null) => (v === null ? null : new Intl.NumberFormat(locale, { style: 'currency', currency: c ?? 'USD' }).format(Number(v)));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('sales.opportunities.title')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('sales.opportunities.hint')}</p>
          {opp.loading && !opp.data ? <LoadingRows rows={3} label={t('common.loading')} /> : (opp.data?.items.length ?? 0) === 0 ? <EmptyState title={t('sales.opportunities.emptyTitle')} hint={t('sales.opportunities.emptyHint')} /> : (
            <ul className="grid gap-3" data-testid="opportunity-list">
              {opp.data!.items.map((o) => (
                <li key={o.customer.id} className="rounded-lg border p-3" data-testid="opportunity">
                  <p className="flex flex-wrap items-center gap-2 font-medium">{o.customer.name ?? t('sales.anonymousVisitor')}<LeadBadge status={o.customer.leadStatus} /><IntentBadge intent={o.customer.purchaseIntent} /></p>
                  <p className="text-sm text-muted-foreground">{[o.customer.phone, o.customer.email].filter(Boolean).join(' · ') || t('sales.customers.noContact')}</p>
                  {o.products.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">{o.products.map((p) => <li key={p.id} className="rounded-md border px-2 py-1 text-xs" data-testid="opportunity-product">{p.name} · {money(p.price, p.currency) ?? t('sales.priceOnRequest')}</li>)}</ul>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('sales.followUps.title')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('sales.followUps.hint')}</p>
          {fu.loading && !fu.data ? <LoadingRows rows={3} label={t('common.loading')} /> : (fu.data?.items.length ?? 0) === 0 ? <EmptyState title={t('sales.followUps.emptyTitle')} hint={t('sales.followUps.emptyHint')} /> : (
            <ul className="grid gap-2" data-testid="followup-list">
              {fu.data!.items.map((f, i) => (
                <li key={i} className="rounded-lg border p-3 text-sm" data-testid="followup" data-type={f.type} data-priority={f.priority}>
                  <p className="font-medium">{t(`sales.followUps.types.${f.type}`)} <span className="text-xs font-normal text-muted-foreground">· {t(`sales.priority.${f.priority}`)}</span></p>
                  <p className="text-muted-foreground">{f.reason}</p>
                  {f.conversationId && <Link className="text-primary hover:underline" href={`/dashboard/sales?c=${f.conversationId}`}>{t('sales.followUps.open')}</Link>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface Faq { verified: Array<{ id: string; title: string; body: string }>; unverified: Array<{ id: string; title: string; body: string }>; unanswered: Array<{ question: string; count: number; conversationIds: string[] }>; topIntents: Array<{ intent: string; count: number }> }

/** Verified FAQ, and the questions customers asked that the agent could not answer: the gaps to fill. */
export function FaqView() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const res = useResource<Faq>('/sales/faq', active?.id);
  const [draft, setDraft] = useState<{ question: string; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function save() {
    if (!draft || !active) return;
    setError(null);
    try {
      await api('/sales/faq/drafts', { method: 'POST', json: draft, businessId: active.id });
      setDraft(null);
      setMessage(t('sales.faq.saved'));
      await res.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    }
  }
  if (res.loading && !res.data) return <LoadingRows rows={4} label={t('common.loading')} />;
  if (res.error && !res.data) return <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void res.reload()} />;
  const d = res.data!;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {message && <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm lg:col-span-2" data-testid="faq-message">{message}</p>}
      <Card>
        <CardHeader><CardTitle>{t('sales.faq.unansweredTitle')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('sales.faq.unansweredHint')}</p>
          {d.unanswered.length === 0 ? <EmptyState title={t('sales.faq.unansweredEmpty')} hint="" /> : (
            <ul className="grid gap-2" data-testid="unanswered-list">
              {d.unanswered.map((u) => (
                <li key={u.question} className="grid gap-1 rounded-lg border p-3 text-sm" data-testid="unanswered">
                  <p className="font-medium" dir="auto">{u.question}</p>
                  <p className="text-xs text-muted-foreground">{t('sales.faq.asked', { count: u.count })}</p>
                  {can('knowledge.write') && <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setDraft({ question: u.question, answer: '' })} data-testid="answer-question">{t('sales.faq.answer')}</Button>}
                </li>
              ))}
            </ul>
          )}
          {draft && (
            <form className="mt-4 grid gap-2 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="faq-form">
              <Input value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} maxLength={300} aria-label={t('sales.faq.question')} data-testid="faq-question" />
              <Textarea value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} rows={4} maxLength={4000} placeholder={t('sales.faq.answerPlaceholder')} aria-label={t('sales.faq.answerPlaceholder')} data-testid="faq-answer" />
              <p className="text-xs text-muted-foreground">{t('sales.faq.unverifiedNote')}</p>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2"><Button type="submit" size="sm" disabled={draft.question.trim().length < 3 || draft.answer.trim().length < 3} data-testid="faq-save">{t('sales.faq.save')}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('common.cancel')}</Button></div>
            </form>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('sales.faq.verifiedTitle')}</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {d.unverified.length > 0 && <div className="rounded-lg border border-dashed p-3 text-sm" data-testid="unverified-faq"><p className="font-medium">{t('sales.faq.waitingVerification', { count: d.unverified.length })}</p><Link className="text-primary hover:underline" href="/dashboard/knowledge">{t('sales.faq.openKnowledge')}</Link></div>}
          {d.verified.length === 0 ? <EmptyState title={t('sales.faq.verifiedEmpty')} hint={t('sales.faq.verifiedHint')} /> : (
            <ul className="grid gap-2" data-testid="verified-faq">{d.verified.map((f) => <li key={f.id} className="rounded-lg border p-3 text-sm"><p className="font-medium">{f.title}</p><p className="text-muted-foreground">{f.body}</p></li>)}</ul>
          )}
          {d.topIntents.length > 0 && <div><h3 className="text-sm font-medium">{t('sales.faq.topIntents')}</h3><ul className="mt-1 flex flex-wrap gap-2">{d.topIntents.slice(0, 8).map((i) => <li key={i.intent} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{t(`sales.intent.${i.intent}`)} · {i.count}</li>)}</ul></div>}
        </CardContent>
      </Card>
    </div>
  );
}

export { flag };
