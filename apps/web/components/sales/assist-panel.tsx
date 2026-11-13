'use client';
import { useState } from 'react';
import { Check, Gauge, HandHelping, Loader2, MessageSquareQuote, X } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

interface Reason { rule: string; points: number; evidence: string }
interface Qualification { score: number; level: 'UNKNOWN' | 'COLD' | 'WARM' | 'HOT'; modelVersion: string; evaluatedMessages: number; reasons: Reason[]; signals: { budget?: { amount: string; currency: string | null } | null; quantity?: { value: number } | null; urgent?: boolean; hasContact?: boolean } }
interface Handoff { id: string; status: 'REQUESTED' | 'ACCEPTED' | 'RESOLVED' | 'CANCELLED'; reason: string; requestedBy: string; requestedAt: string; resolutionNote: string | null; summary: { customerMessages?: number; products?: Array<{ name: string }>; lastCustomerMessages?: Array<{ text: string }> } | null }
interface FollowUp { id: string; status: 'SUGGESTED' | 'APPROVED' | 'REJECTED' | 'BLOCKED'; language: string; suggestedText: string; blockedReason: string | null; createdAt: string }
interface Assist { qualification: Qualification | null; handoffs: Handoff[]; followUps: FollowUp[]; consent: { followUp: boolean; optedOut: boolean; conversionVerified: boolean } }

/**
 * The sales assistant's view of one conversation: the explained lead score, handoff records and follow-up drafts.
 * Nothing here is sent to the customer: a follow-up is a draft a person authorizes, and only with the customer's consent.
 * The panel stays hidden when the feature is off (the API answers 404).
 */
export function AssistPanel({ conversationId, canAct, onChanged }: { conversationId: string; canAct: boolean; onChanged?: () => void }) {
  const { t } = useI18n();
  const { active } = useBusiness();
  const res = useResource<Assist>(`/sales/conversations/${conversationId}/assist`, active?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a = res.data;
  if (!a) return null;

  async function act(key: string, path: string, json: unknown = {}) {
    if (!active) return;
    setBusy(key);
    setError(null);
    try {
      await api(`/sales${path}`, { method: 'POST', json, businessId: active.id });
      await res.reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('common.loadError'));
    } finally {
      setBusy(null);
    }
  }
  const q = a.qualification;
  const openHandoff = a.handoffs.some((h) => h.status === 'REQUESTED' || h.status === 'ACCEPTED');
  const pending = a.followUps.some((f) => f.status === 'SUGGESTED');
  const spin = (k: string) => busy === k && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />;

  return (
    <section className="grid gap-4 rounded-lg border p-3" data-testid="assist-panel" aria-label={t('sales.assist.title')}>
      <h3 className="flex items-center gap-2 text-sm font-medium"><Gauge className="h-4 w-4" aria-hidden />{t('sales.assist.title')}</h3>
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="assist-error">{error}</p>}

      <div data-testid="assist-qualification">
        {q ? (
          <>
            <p className="text-sm"><span className="font-semibold" data-testid="assist-level" data-level={q.level}>{t(`sales.assist.level.${q.level}`)}</span> · <span data-testid="assist-score">{q.score}/100</span></p>
            <p className="text-xs text-muted-foreground">{t('sales.assist.basis', { count: q.evaluatedMessages })}</p>
            {q.reasons.length > 0 && (
              <ul className="mt-2 grid gap-1 text-sm" data-testid="assist-reasons">
                {q.reasons.map((r) => <li key={r.rule} className="flex flex-wrap justify-between gap-2" data-rule={r.rule}><span>{t(`sales.assist.rule.${r.rule}`)} <span className="text-xs text-muted-foreground" dir="auto">« {r.evidence} »</span></span><span className="font-medium">+{r.points}</span></li>)}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{t('sales.assist.rulesNote')}</p>
          </>
        ) : <p className="text-sm text-muted-foreground">{t('sales.assist.noScore')}</p>}
      </div>

      <div data-testid="assist-handoffs">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="flex items-center gap-1.5 text-sm font-medium"><HandHelping className="h-4 w-4" aria-hidden />{t('sales.assist.handoffs')}</h4>
          {canAct && !openHandoff && <Button size="sm" variant="outline" onClick={() => void act('handoff', `/conversations/${conversationId}/handoffs`)} disabled={busy !== null} data-testid="assist-open-handoff">{spin('handoff')}{t('sales.assist.openHandoff')}</Button>}
        </div>
        {a.handoffs.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{t('sales.assist.noHandoffs')}</p>}
        <ul className="mt-2 grid gap-2">
          {a.handoffs.map((h) => (
            <li key={h.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="assist-handoff" data-status={h.status}>
              <p className="font-medium">{t(`sales.assist.handoffStatus.${h.status}`)} <span className="font-normal text-muted-foreground">· {t(`sales.handoffReasons.${h.reason}`)}</span></p>
              {h.summary && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="assist-handoff-summary">
                  {t('sales.assist.summary', { count: h.summary.customerMessages ?? 0 })}{h.summary.products && h.summary.products.length > 0 && ` · ${h.summary.products.map((p) => p.name).join(', ')}`}
                </p>
              )}
              {h.resolutionNote && <p className="mt-1 text-xs" dir="auto">{h.resolutionNote}</p>}
              {canAct && (h.status === 'REQUESTED' || h.status === 'ACCEPTED') && (
                <div className="mt-2 flex gap-2">
                  {h.status === 'REQUESTED' && <Button size="sm" onClick={() => void act(`a${h.id}`, `/handoffs/${h.id}/accept`)} disabled={busy !== null} data-testid="assist-accept">{spin(`a${h.id}`)}{t('sales.assist.accept')}</Button>}
                  <Button size="sm" variant="outline" onClick={() => void act(`r${h.id}`, `/handoffs/${h.id}/resolve`, {})} disabled={busy !== null} data-testid="assist-resolve">{spin(`r${h.id}`)}{t('sales.assist.resolve')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div data-testid="assist-followups">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="flex items-center gap-1.5 text-sm font-medium"><MessageSquareQuote className="h-4 w-4" aria-hidden />{t('sales.assist.followUps')}</h4>
          {canAct && !pending && <Button size="sm" variant="outline" onClick={() => void act('draft', `/conversations/${conversationId}/follow-up-drafts`)} disabled={busy !== null} data-testid="assist-suggest">{spin('draft')}{t('sales.assist.suggest')}</Button>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="assist-consent">{a.consent.optedOut ? t('sales.assist.optedOut') : a.consent.followUp ? t('sales.assist.consentYes') : t('sales.assist.consentNo')}</p>
        <p className="text-xs text-muted-foreground">{t('sales.assist.neverSent')}</p>
        <ul className="mt-2 grid gap-2">
          {a.followUps.map((f) => (
            <li key={f.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="assist-followup" data-status={f.status}>
              <p className="font-medium">{t(`sales.assist.followStatus.${f.status}`)}{f.blockedReason && <span className="font-normal text-muted-foreground"> · {t(`sales.assist.blocked.${f.blockedReason}`)}</span>}</p>
              {f.suggestedText && <p className="mt-1 whitespace-pre-wrap" dir="auto">{f.suggestedText}</p>}
              {canAct && f.status === 'SUGGESTED' && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void act(`ok${f.id}`, `/follow-up-drafts/${f.id}/approve`)} disabled={busy !== null} data-testid="assist-approve">{spin(`ok${f.id}`) || <Check className="h-4 w-4" aria-hidden />}{t('sales.assist.approve')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(`no${f.id}`, `/follow-up-drafts/${f.id}/reject`)} disabled={busy !== null} data-testid="assist-reject"><X className="h-4 w-4" aria-hidden />{t('sales.assist.reject')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
