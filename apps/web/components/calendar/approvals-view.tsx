'use client';
import { useCallback, useState } from 'react';
import { Check, X } from 'lucide-react';
import { addDays } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { EmptyState, LoadingRows } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { useResource } from '@/lib/use-resource';
import { EntryDialog } from './entry-dialog';
import { PlatformDot, StatusBadge } from './status';
import type { ApprovalsResponse, DecidedRecord, Entry, RangeResponse } from './types';
import { useCalendarWrite, useErrorText, useOverview } from './use-calendar';

/** The approval queue: what waits for a decision, what is approved and ready to schedule, and every recent decision. */
export function ApprovalsView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const errorText = useErrorText();
  const overview = useOverview();
  const { send, dialog } = useCalendarWrite();
  const pending = useResource<ApprovalsResponse>('/calendar/approvals?view=pending&pageSize=50', active?.id);
  const today = overview.data?.today ?? new Date().toISOString().slice(0, 10);
  const ready = useResource<RangeResponse>(`/calendar/entries?from=${today}&to=${addDays(today, 44)}&status=APPROVED`, active?.id);
  const decided = useResource<{ items: DecidedRecord[] }>('/calendar/approvals?view=decided&pageSize=10', active?.id);
  const [open, setOpen] = useState<Entry | null>(null);
  const [rejecting, setRejecting] = useState<Entry | null>(null);
  const [approving, setApproving] = useState<Entry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fmt = (iso: string, tz?: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
  const reload = useCallback(() => {
    void pending.reload();
    void ready.reload();
    void decided.reload();
    void overview.reload();
  }, [pending, ready, decided, overview]);

  async function act(e: Entry, action: 'approve' | 'reject', body?: Record<string, unknown>) {
    setBusy(e.id);
    setError(null);
    try {
      await send<Entry>(`/entries/${e.id}/${action}`, 'POST', body);
      setRejecting(null);
      setApproving(null);
      setReason('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      reload();
    }
  }

  const row = (e: Entry, actions?: React.ReactNode) => (
    <li key={e.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-start" data-testid="approval-item" data-entry-id={e.id}>
      <div className="min-w-0">
        <button type="button" className="flex items-center gap-2 text-start font-medium hover:underline" onClick={() => setOpen(e)}>
          <PlatformDot platform={e.platform} />
          <span className="truncate">{e.title}</span>
        </button>
        <p className="mt-0.5 text-xs text-muted-foreground">{e.platform && t(`calendar.platforms.${e.platform}`)} · {fmt(e.scheduledAt, e.timezone)} · <StatusBadge status={e.status} className="ms-1" /></p>
        {e.content?.caption && <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm text-muted-foreground">{e.content.caption}</p>}
        {e.content?.origin !== 'HUMAN' && <p className="mt-1 text-xs text-muted-foreground">{t('calendar.approvals.aiNote')}</p>}
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">{actions}</div>
    </li>
  );

  return (
    <div className="grid gap-6">
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="approvals-error">{error}</p>}
      <Card>
        <CardHeader><CardTitle>{t('calendar.approvals.pending')}</CardTitle></CardHeader>
        <CardContent>
          {pending.loading && !pending.data ? <LoadingRows rows={3} label={t('common.loading')} /> : (pending.data?.items.length ?? 0) === 0 ? <EmptyState title={t('calendar.approvals.emptyTitle')} hint={t('calendar.approvals.emptyText')} /> : (
            <ul className="grid gap-3" data-testid="pending-list">
              {pending.data!.items.map((e) =>
                row(e, can('content.approve') ? (
                  <>
                    <Button size="sm" onClick={() => setApproving(e)} disabled={busy === e.id} data-testid="quick-approve"><Check className="h-4 w-4" aria-hidden />{t('calendar.actions.approve')}</Button>
                    <Button size="sm" variant="outline" onClick={() => { setRejecting(e); setReason(''); }} disabled={busy === e.id} data-testid="quick-reject"><X className="h-4 w-4" aria-hidden />{t('calendar.actions.reject')}</Button>
                  </>
                ) : <span className="text-xs text-muted-foreground">{t('calendar.entry.needsApprover')}</span>),
              )}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('calendar.approvals.ready')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('calendar.approvals.readyHint')}</p>
          {(ready.data?.items.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('calendar.approvals.readyEmpty')}</p> : (
            <ul className="grid gap-3" data-testid="ready-list">
              {ready.data!.items.map((e) => row(e, <Button size="sm" variant="outline" onClick={() => setOpen(e)}>{can('publication.schedule') ? t('calendar.actions.review') : t('calendar.actions.open')}</Button>))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('calendar.approvals.decisions')}</CardTitle></CardHeader>
        <CardContent>
          {(decided.data?.items.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('calendar.approvals.decisionsEmpty')}</p> : (
            <ol className="grid gap-2 text-sm" data-testid="decision-list">
              {decided.data!.items.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2 border-b pb-2 last:border-0">
                  <span className="font-medium">{t(`calendar.decision.${r.decision}`)}</span>
                  <span>{r.entry?.title}</span>
                  <span className="text-muted-foreground">· {r.actorName ?? t('calendar.entry.system')} · {fmt(r.createdAt)}</span>
                  {r.note && <span className="w-full text-xs text-muted-foreground">“{r.note}”</span>}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Dialog open={approving !== null} onClose={() => setApproving(null)} title={t('calendar.approvals.approveTitle')} description={t('calendar.approvals.approveText')} closeLabel={t('common.close')}>
        {approving && (
          <div className="grid gap-3" data-testid="approve-dialog">
            <dl className="grid gap-1 rounded-md bg-muted/50 p-3 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t('calendar.approvals.what')}</dt><dd className="min-w-0 truncate font-medium">{approving.title}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t('calendar.approvals.where')}</dt><dd>{approving.platform && t(`calendar.platforms.${approving.platform}`)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{t('calendar.approvals.when')}</dt><dd>{fmt(approving.scheduledAt, approving.timezone)} ({approving.timezone})</dd></div>
            </dl>
            {approving.content?.caption && <p className="line-clamp-4 whitespace-pre-line text-sm text-muted-foreground" dir="auto">{approving.content.caption}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setApproving(null)}>{t('common.cancel')}</Button>
              <Button disabled={busy === approving.id} onClick={() => void act(approving, 'approve')} data-testid="quick-approve-confirm"><Check className="h-4 w-4" aria-hidden />{t('calendar.approvals.confirmApprove')}</Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={rejecting !== null} onClose={() => setRejecting(null)} title={t('calendar.approvals.rejectTitle')} closeLabel={t('common.close')}>
        <div className="grid gap-3">
          <Field id="qr-reason" label={t('calendar.entry.rejectReason')}><Textarea id="qr-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRejecting(null)}>{t('common.cancel')}</Button>
            <Button disabled={reason.trim().length < 3 || (rejecting !== null && busy === rejecting.id)} onClick={() => rejecting && void act(rejecting, 'reject', { reason: reason.trim() })} data-testid="quick-reject-confirm">{t('calendar.actions.rejectConfirm')}</Button>
          </div>
        </div>
      </Dialog>
      <EntryDialog entry={open} conflicts={[]} publishingAvailable={Boolean(overview.data?.publishing.available)} onClose={() => setOpen(null)} onChanged={reload} />
      {dialog}
    </div>
  );
}
