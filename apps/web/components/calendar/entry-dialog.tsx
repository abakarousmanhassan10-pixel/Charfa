'use client';
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CALENDAR_LIMITS } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { Select } from '@/components/ui/select';
import { useAccounts } from '@/components/social/use-social';
import { PlatformDot, StatusBadge } from './status';
import type { Entry, HistoryRecord } from './types';
import { useCalendarWrite, useErrorText } from './use-calendar';

const EDITABLE = ['DRAFT', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED', 'FAILED'];
const DELETABLE = ['DRAFT', 'REJECTED', 'CANCELLED', 'FAILED'];

/** Everything about one entry: its text, its time and where it is in the approval workflow. */
export function EntryDialog({
  entry,
  conflicts,
  publishingAvailable,
  onClose,
  onChanged,
}: {
  entry: Entry | null;
  conflicts: Array<{ code: string; message: string; withEntryId?: string }>;
  publishingAvailable: boolean;
  onClose: () => void;
  onChanged: (e: Entry | null) => void;
}) {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const errorText = useErrorText();
  const { send, dialog } = useCalendarWrite();
  const [current, setCurrent] = useState<Entry | null>(entry);
  const [form, setForm] = useState({ title: '', caption: '', hashtags: '', callToAction: '', brief: '', notes: '' });
  const [when, setWhen] = useState({ date: '', time: '' });
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [authorize, setAuthorize] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryRecord[] | null>(null);
  const socialAccounts = useAccounts();

  const sync = useCallback((e: Entry) => {
    setCurrent(e);
    setForm({ title: e.title, caption: e.content?.caption ?? '', hashtags: (e.content?.hashtags ?? []).join(' '), callToAction: e.content?.callToAction ?? '', brief: e.brief ?? '', notes: e.notes ?? '' });
    setWhen({ date: e.local.date, time: e.local.time });
  }, []);

  useEffect(() => {
    setError(null);
    setIssues([]);
    setRejecting(false);
    setAuthorize(false);
    setReason('');
    setHistory(null);
    if (entry) sync(entry);
    else setCurrent(null);
  }, [entry, sync]);

  useEffect(() => {
    if (!entry || !active) return;
    let alive = true;
    api<{ items: HistoryRecord[] }>(`/calendar/entries/${entry.id}/history`, { businessId: active.id })
      .then((r) => alive && setHistory(r.items))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [entry, active, current?.status, current?.content?.version]);

  const e = current;
  const status = e?.status ?? 'DRAFT';
  const canWrite = can('content.write');
  const canApprove = can('content.approve');
  const canSchedule = can('publication.schedule');
  const editable = Boolean(e) && EDITABLE.includes(status) && canWrite;
  const hashtagList = form.hashtags.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);

  async function run(name: string, fn: () => Promise<Entry | { deleted: boolean } | null>) {
    setBusy(name);
    setError(null);
    setIssues([]);
    try {
      const res = await fn();
      if (!res) return;
      if ('deleted' in res) {
        onChanged(null);
        onClose();
        return;
      }
      sync(res);
      onChanged(res);
    } catch (err) {
      setError(errorText(err));
      const details = (err as { details?: string[] }).details;
      if (details?.length) setIssues(details);
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run('save', () =>
      send<Entry>(`/entries/${e!.id}`, 'PATCH', { title: form.title.trim(), caption: form.caption.trim() || null, hashtags: hashtagList, callToAction: form.callToAction.trim() || null, brief: form.brief.trim() || null, notes: form.notes.trim() || null }),
    );
  const platformAccounts = (socialAccounts.data?.items ?? []).filter((a) => a.platform === e?.platform && a.status === 'CONNECTED');
  const action = (name: string, body?: Record<string, unknown>) => run(name, () => send<Entry>(`/entries/${e!.id}/${name}`, 'POST', body));
  const dirty = Boolean(e) && (form.title !== e!.title || form.caption !== (e!.content?.caption ?? '') || form.hashtags !== (e!.content?.hashtags ?? []).join(' ') || form.callToAction !== (e!.content?.callToAction ?? '') || form.brief !== (e!.brief ?? '') || form.notes !== (e!.notes ?? ''));
  const timeChanged = Boolean(e) && (when.date !== e!.local.date || when.time !== e!.local.time);
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <>
      <Dialog open={Boolean(entry)} onClose={onClose} title={e?.title ?? ''} closeLabel={t('common.close')} className="max-w-2xl">
        {e && (
          <div className="grid gap-5" data-testid="entry-dialog" data-status={status}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={status} />
              {e.platform && (
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <PlatformDot platform={e.platform} />
                  {t(`calendar.platforms.${e.platform}`)}
                </span>
              )}
              {e.pillar && <Badge variant="muted">{t(`calendar.pillars.${e.pillar}`)}</Badge>}
              {e.content?.origin !== 'HUMAN' && <Badge variant="default">{t('calendar.entry.aiAssisted')}</Badge>}
            </div>

            {error && (
              <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="entry-error">
                <p>{error}</p>
                {issues.length > 0 && <ul className="mt-1 list-disc ps-5">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              </div>
            )}
            {status === 'FAILED' && e.lastError && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-300" data-testid="entry-failure">{t('calendar.entry.failedWith', { error: e.lastError })}</p>}
            {status === 'REJECTED' && e.content?.rejectionReason && <p className="rounded-md bg-orange-500/10 px-3 py-2 text-sm" data-testid="entry-rejection">{t('calendar.entry.rejectedWith', { reason: e.content.rejectionReason })}</p>}
            {status === 'SCHEDULED' && !publishingAvailable && <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="entry-no-publisher">{t('calendar.entry.noPublisher')}</p>}
            {conflicts.length > 0 && (
              <ul className="grid gap-1" data-testid="entry-conflicts">
                {conflicts.map((c, i) => <li key={i} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm dark:bg-amber-950/30">⚠ {t(`calendar.conflict.codes.${c.code}`)}</li>)}
              </ul>
            )}

            <section aria-labelledby="entry-when" className="grid gap-3 rounded-lg border p-3">
              <h3 id="entry-when" className="text-sm font-semibold">{t('calendar.entry.when')}</h3>
              <p className="text-sm">
                <span data-testid="entry-time">{fmt(e.scheduledAt)}</span> <span className="text-muted-foreground">({e.timezone})</span>
              </p>
              <p className="text-xs text-muted-foreground" data-testid="entry-time-source" data-source={e.timeSource}>
                <Badge variant={e.timeSource === 'ANALYTICS' ? 'success' : e.timeSource === 'ESTIMATE' ? 'warning' : 'muted'} className="me-2">{t(`calendar.timeSource.${e.timeSource}`)}</Badge>
                {e.timeNote ?? t(`calendar.timeSource.${e.timeSource}Hint`)}
              </p>
              {EDITABLE.includes(status) && (canWrite && (status !== 'SCHEDULED' || canSchedule)) && (
                <div className="flex flex-wrap items-end gap-2">
                  <Field id="mv-date" label={t('calendar.entry.date')}><Input id="mv-date" type="date" value={when.date} onChange={(ev) => setWhen((w) => ({ ...w, date: ev.target.value }))} /></Field>
                  <Field id="mv-time" label={t('calendar.entry.time')}><Input id="mv-time" type="time" value={when.time} onChange={(ev) => setWhen((w) => ({ ...w, time: ev.target.value }))} /></Field>
                  <Button variant="outline" disabled={!timeChanged || !when.date || !when.time || busy !== null} onClick={() => action(status === 'FAILED' ? 'retry' : 'reschedule', { localDate: when.date, localTime: when.time })}>
                    {busy === 'reschedule' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {status === 'FAILED' ? t('calendar.actions.retryAt') : t('calendar.actions.move')}
                  </Button>
                </div>
              )}
            </section>

            <section aria-labelledby="entry-content" className="grid gap-3">
              <h3 id="entry-content" className="text-sm font-semibold">{t('calendar.entry.content')}</h3>
              <Field id="en-title" label={t('calendar.entry.title')}><Input id="en-title" value={form.title} maxLength={CALENDAR_LIMITS.titleMax} disabled={!editable} onChange={(ev) => setForm((f) => ({ ...f, title: ev.target.value }))} /></Field>
              <Field id="en-caption" label={t('calendar.entry.caption')} hint={t('calendar.entry.captionHint', { count: form.caption.length, max: CALENDAR_LIMITS.captionMax })}>
                <Textarea id="en-caption" rows={5} value={form.caption} maxLength={CALENDAR_LIMITS.captionMax} disabled={!editable} onChange={(ev) => setForm((f) => ({ ...f, caption: ev.target.value }))} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="en-tags" label={t('calendar.entry.hashtags')}><Input id="en-tags" value={form.hashtags} disabled={!editable} onChange={(ev) => setForm((f) => ({ ...f, hashtags: ev.target.value }))} /></Field>
                <Field id="en-cta" label={t('calendar.entry.cta')}><Input id="en-cta" value={form.callToAction} disabled={!editable} onChange={(ev) => setForm((f) => ({ ...f, callToAction: ev.target.value }))} /></Field>
              </div>
              <Field id="en-brief" label={t('calendar.entry.brief')} hint={t('calendar.entry.briefHint')}><Textarea id="en-brief" rows={2} value={form.brief} disabled={!editable} onChange={(ev) => setForm((f) => ({ ...f, brief: ev.target.value }))} /></Field>
              {editable && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={save} disabled={!dirty || busy !== null || !form.title.trim()} data-testid="entry-save">
                    {busy === 'save' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {t('calendar.actions.save')}
                  </Button>
                  {['IN_REVIEW', 'APPROVED', 'SCHEDULED'].includes(status) && <p className="text-xs text-muted-foreground">{t('calendar.entry.editWarning')}</p>}
                </div>
              )}
            </section>

            <section aria-labelledby="entry-workflow" className="grid gap-3 rounded-lg border bg-muted/30 p-3">
              <h3 id="entry-workflow" className="text-sm font-semibold">{t('calendar.entry.workflow')}</h3>
              <p className="text-sm text-muted-foreground">{t(`calendar.workflow.${status}`)}</p>
              <div className="flex flex-wrap gap-2">
                {(status === 'DRAFT' || status === 'REJECTED') && canWrite && (
                  <Button onClick={() => action('submit')} disabled={busy !== null || dirty} data-testid="act-submit">
                    {busy === 'submit' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {t('calendar.actions.submit')}
                  </Button>
                )}
                {status === 'IN_REVIEW' && canApprove && !rejecting && (
                  <>
                    <Button onClick={() => action('approve')} disabled={busy !== null} data-testid="act-approve">{busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('calendar.actions.approve')}</Button>
                    <Button variant="outline" onClick={() => setRejecting(true)} disabled={busy !== null} data-testid="act-reject-open">{t('calendar.actions.reject')}</Button>
                  </>
                )}
                {status === 'IN_REVIEW' && !canApprove && <p className="text-sm text-muted-foreground">{t('calendar.entry.needsApprover')}</p>}
                {status === 'SCHEDULED' && canSchedule && <Button variant="outline" onClick={() => action('unschedule')} disabled={busy !== null} data-testid="act-unschedule">{t('calendar.actions.unschedule')}</Button>}
                {status === 'FAILED' && canSchedule && <Button onClick={() => action('retry', {})} disabled={busy !== null} data-testid="act-retry">{t('calendar.actions.retry')}</Button>}
                {!['PUBLISHING', 'PUBLISHED', 'CANCELLED'].includes(status) && canWrite && (status !== 'SCHEDULED' || canSchedule) && (
                  <Button variant="outline" onClick={() => action('cancel')} disabled={busy !== null} data-testid="act-cancel">{t('calendar.actions.cancel')}</Button>
                )}
                {DELETABLE.includes(status) && canWrite && (
                  <Button variant="ghost" className="text-destructive" onClick={() => run('delete', () => send<{ deleted: boolean }>(`/entries/${e.id}`, 'DELETE'))} disabled={busy !== null} data-testid="act-delete">{t('calendar.actions.delete')}</Button>
                )}
              </div>
              {rejecting && (
                <div className="grid gap-2">
                  <Field id="rj-reason" label={t('calendar.entry.rejectReason')}><Textarea id="rj-reason" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} /></Field>
                  <div className="flex gap-2">
                    <Button disabled={reason.trim().length < 3 || busy !== null} onClick={() => action('reject', { reason: reason.trim() })} data-testid="act-reject">{t('calendar.actions.rejectConfirm')}</Button>
                    <Button variant="outline" onClick={() => setRejecting(false)}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
              {status === 'APPROVED' && canSchedule && (
                <div className="grid gap-2 rounded-md border bg-card p-3" data-testid="authorize-box">
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={authorize} onChange={(ev) => setAuthorize(ev.target.checked)} data-testid="authorize-check" />
                    <span>{t('calendar.entry.authorizeText', { when: fmt(e.scheduledAt) })}</span>
                  </label>
                  {platformAccounts.length > 1 && (
                    <Field id="en-account" label={t('social.publishing.account')} hint={e.socialAccountId ? undefined : t('social.publishing.accountRequired')}>
                      <Select id="en-account" value={e.socialAccountId ?? ''} onChange={(ev) => run('account', () => send<Entry>(`/entries/${e.id}/account`, 'PUT', { socialAccountId: ev.target.value }))}>
                        <option value="">{t('social.publishing.chooseAccount')}</option>
                        {platformAccounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ?? a.externalAccountId}</option>)}
                      </Select>
                    </Field>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={!authorize || busy !== null} onClick={() => action('authorize', {})} data-testid="act-authorize">{busy === 'authorize' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('calendar.actions.authorize')}</Button>
                    <Button variant="outline" disabled={!authorize || busy !== null || !publishingAvailable} onClick={() => action('publish-now', {})} data-testid="act-publish-now">{busy === 'publish-now' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('social.publishing.publishNow')}</Button>
                  </div>
                </div>
              )}
              {status === 'APPROVED' && !canSchedule && <p className="text-sm text-muted-foreground">{t('calendar.entry.needsScheduler')}</p>}
            </section>

            <section aria-labelledby="entry-history">
              <h3 id="entry-history" className="mb-2 text-sm font-semibold">{t('calendar.entry.history')}</h3>
              {!history ? <p className="text-sm text-muted-foreground">{t('common.loading')}</p> : history.length === 0 ? <p className="text-sm text-muted-foreground">{t('calendar.entry.noHistory')}</p> : (
                <ol className="grid gap-1.5 text-sm" data-testid="entry-history">
                  {history.map((h) => (
                    <li key={h.id} className="flex flex-wrap gap-x-2 text-muted-foreground">
                      <span className="font-medium text-foreground">{t(`calendar.decision.${h.decision}`)}</span>
                      <span>{h.actorName ?? t('calendar.entry.system')}</span>
                      <span>· {fmt(h.createdAt)}</span>
                      <span>· v{h.version}</span>
                      {h.snapshotHash && <span title={h.snapshotHash} data-testid="snapshot">· {t('calendar.entry.snapshot', { hash: h.snapshotHash.slice(0, 8) })}</span>}
                      {h.note && <span className="w-full ps-0 text-xs">“{h.note}”</span>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </Dialog>
      {dialog}
    </>
  );
}

