'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ImagePlus, Loader2, Send, X } from 'lucide-react';
import { CALENDAR_LIMITS, addDays, todayIn } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { StatusBadge } from '@/components/calendar/status';
import { PLATFORMS, type Entry, type Platform, type RangeResponse } from '@/components/calendar/types';
import { useCalendarWrite, useErrorText, useOverview } from '@/components/calendar/use-calendar';
import { useI18n } from '@/components/i18n-provider';
import { MediaPicker } from '@/components/media/media-picker';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/states';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useResource } from '@/lib/use-resource';
import { PlatformLabel } from './platform';
import { emptyTikTokDraft, TikTokPanel, TikTokSummary, type TikTokDraft } from './tiktok-panel';
import { api } from '@/lib/api-client';
import type { TikTokPostSettings } from '@touma/shared';
import { useAccounts, useSocialStatus } from './use-social';

type Kind = 'TEXT' | 'IMAGE' | 'CAROUSEL' | 'VIDEO';
const KINDS: Kind[] = ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'];

/**
 * Compose a post and move it through the approval workflow to publication: save a draft, submit it, get it approved, then publish
 * now or schedule it from the calendar. Publishing always needs an explicit authorization by a person who may schedule publications.
 */
export function PublishingView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const errorText = useErrorText();
  const status = useSocialStatus();
  const accounts = useAccounts();
  const overview = useOverview();
  const { send, dialog } = useCalendarWrite();
  const tz = overview.data?.timezone ?? 'UTC';
  const today = overview.data?.today ?? todayIn(tz);
  const connected = useMemo(() => PLATFORMS.filter((p) => accounts.data?.items.some((a) => a.platform === p && a.status === 'CONNECTED')), [accounts.data]);
  const [f, setF] = useState({ platform: '' as Platform | '', accountId: '', title: '', kind: 'TEXT' as Kind, caption: '', hashtags: '', date: '', time: '' });
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = useResource<RangeResponse>(`/calendar/entries?from=${today}&to=${addDays(today, 44)}`, active?.id);
  const [now, setNow] = useState<Entry | null>(null);
  const [authorize, setAuthorize] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [tt, setTt] = useState<TikTokDraft>(emptyTikTokDraft());
  const [ttReady, setTtReady] = useState(false);
  const [ttEntry, setTtEntry] = useState<{ entry: Entry; draft: TikTokDraft; media: MediaItem[]; ready: boolean } | null>(null);

  useEffect(() => {
    if (!f.platform && connected.length) setF((x) => ({ ...x, platform: connected[0]! }));
  }, [connected, f.platform]);

  const platformAccounts = (accounts.data?.items ?? []).filter((a) => a.platform === f.platform && a.status === 'CONNECTED');
  const info = status.data?.platforms.find((p) => p.platform === f.platform);
  const unsupported = info && !info.capabilities.supports[f.kind];
  const needsMedia = f.kind !== 'TEXT';
  const isTikTok = f.platform === 'TIKTOK';
  const tiktokAccountId = (f.accountId || platformAccounts[0]?.id) ?? null;
  const accountFor = (e: Entry) => e.socialAccountId ?? (accounts.data?.items.find((a) => a.platform === 'TIKTOK' && a.status === 'CONNECTED')?.id ?? null);

  const pipeline = (range.data?.items ?? []).filter((e) => ['DRAFT', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED', 'FAILED'].includes(e.status));

  async function create(e: React.FormEvent, withTime: boolean) {
    e.preventDefault();
    if (!f.platform) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        title: f.title.trim(), platform: f.platform, contentType: f.kind, ...(f.caption.trim() ? { caption: f.caption.trim() } : {}), hashtags: f.hashtags.split(/[\s,]+/).map((h) => h.replace(/^#/, '')).filter(Boolean),
        ...(media.length ? { mediaIds: media.map((m) => m.id) } : {}), localDate: f.date || addDays(today, 1), ...(withTime && f.time ? { localTime: f.time } : {}),
      };
      const created = await send<Entry>('/entries', 'POST', body);
      if (created) {
        if (f.accountId) await send<Entry>(`/entries/${created.id}/account`, 'PUT', { socialAccountId: f.accountId });
        if (isTikTok) await send<Entry>(`/entries/${created.id}/tiktok-settings`, 'PUT', { ...tt, privacyLevel: tt.privacyLevel || undefined });
        setMessage(t('social.publishing.saved'));
        setF((x) => ({ ...x, title: '', caption: '', hashtags: '' }));
        setMedia([]);
        setTt(emptyTikTokDraft());
        void range.reload();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const act = useCallback(
    async (entry: Entry, action: 'submit' | 'approve' | 'publish-now') => {
      setActing(entry.id);
      setError(null);
      try {
        await send<Entry>(`/entries/${entry.id}/${action}`, 'POST', {});
        if (action === 'publish-now') {
          setNow(null);
          setAuthorize(false);
          setMessage(t('social.publishing.handedOver'));
        }
      } catch (err) {
        setError(errorText(err));
      } finally {
        setActing(null);
        void range.reload();
      }
    },
    [send, errorText, range, t],
  );

  async function openTikTok(entry: Entry) {
    if (!active) return;
    const ids = entry.content?.mediaIds ?? [];
    const items = (await Promise.all(ids.map((id) => api<MediaItem>(`/media/${id}`, { businessId: active.id }).catch(() => null)))).filter((m): m is MediaItem => Boolean(m));
    setTtEntry({ entry, draft: emptyTikTokDraft(entry.content?.platformOptions?.tiktok as Partial<TikTokPostSettings> | undefined), media: items, ready: false });
  }
  async function saveTikTok() {
    if (!ttEntry) return;
    setActing(ttEntry.entry.id);
    setError(null);
    try {
      await send<Entry>(`/entries/${ttEntry.entry.id}/tiktok-settings`, 'PUT', { ...ttEntry.draft, privacyLevel: ttEntry.draft.privacyLevel || undefined });
      setTtEntry(null);
      setMessage(t('social.tiktok.saved'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setActing(null);
      void range.reload();
    }
  }

  const accountLabel = (id: string | null) => accounts.data?.items.find((a) => a.id === id)?.displayName ?? null;
  const fmt = (iso: string, zone: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(iso));

  return (
    <div className="grid gap-6">
      {!status.data?.publishing.available && status.data && <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground" data-testid="publishing-unavailable">{t('social.publishing.unavailable')}</p>}
      {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="publishing-error">{error}</p>}
      {message && <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm" data-testid="publishing-message">{message}</p>}

      <Card>
        <CardHeader><CardTitle>{t('social.publishing.composeTitle')}</CardTitle></CardHeader>
        <CardContent>
          {connected.length === 0 && accounts.data ? (
            <EmptyState title={t('social.publishing.noAccountsTitle')} hint={t('social.publishing.noAccountsHint')} action={<Button asChild><Link href="/dashboard/social/accounts">{t('social.tabs.accounts')}</Link></Button>} />
          ) : (
            <form className="grid gap-4" onSubmit={(e) => void create(e, true)} data-testid="composer">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field id="cp-platform" label={t('calendar.entry.platform')}>
                  <Select id="cp-platform" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value as Platform, accountId: '' })}>
                    {connected.map((p) => <option key={p} value={p}>{t(`calendar.platforms.${p}`)}</option>)}
                  </Select>
                </Field>
                {platformAccounts.length > 1 && (
                  <Field id="cp-account" label={t('social.publishing.account')}>
                    <Select id="cp-account" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                      <option value="">{t('social.publishing.chooseAccount')}</option>
                      {platformAccounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ?? a.externalAccountId}</option>)}
                    </Select>
                  </Field>
                )}
                <Field id="cp-kind" label={t('calendar.entry.type')}>
                  <Select id="cp-kind" value={f.kind} onChange={(e) => { setF({ ...f, kind: e.target.value as Kind }); setMedia([]); }}>
                    {KINDS.map((k) => <option key={k} value={k}>{t(`calendar.types.${k}`)}</option>)}
                  </Select>
                </Field>
              </div>
              {unsupported && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="manual-warning">{t('social.publishing.manualWarning', { platform: t(`calendar.platforms.${f.platform as Platform}`), kind: t(`calendar.types.${f.kind}`) })}</p>}
              <Field id="cp-title" label={t('calendar.entry.title')}><Input id="cp-title" required maxLength={CALENDAR_LIMITS.titleMax} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
              <Field id="cp-caption" label={t('calendar.entry.caption')} hint={info ? t('social.publishing.captionHint', { count: f.caption.length, max: info.capabilities.captionMax }) : undefined}>
                <Textarea id="cp-caption" rows={4} maxLength={CALENDAR_LIMITS.captionMax} value={f.caption} onChange={(e) => setF({ ...f, caption: e.target.value })} />
              </Field>
              <Field id="cp-tags" label={t('calendar.entry.hashtags')}><Input id="cp-tags" value={f.hashtags} onChange={(e) => setF({ ...f, hashtags: e.target.value })} /></Field>
              {needsMedia && (
                <div className="grid gap-2">
                  <span className="text-sm font-medium">{t('social.publishing.media')}</span>
                  <div className="flex flex-wrap items-center gap-2" data-testid="composer-media">
                    {media.map((m) => (
                      <span key={m.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                        {m.originalFilename}
                        <button type="button" onClick={() => setMedia((x) => x.filter((y) => y.id !== m.id))} aria-label={t('social.publishing.removeMedia', { name: m.originalFilename })}><X className="h-3 w-3" aria-hidden /></button>
                      </span>
                    ))}
                    <Button type="button" variant="outline" size="sm" onClick={() => setPicker(true)} data-testid="add-media"><ImagePlus className="h-4 w-4" aria-hidden />{t('social.publishing.chooseMedia')}</Button>
                  </div>
                  {info && <p className="text-xs text-muted-foreground">{t('social.publishing.mediaRules', { images: info.capabilities.imageMimes.map((m) => m.replace('image/', '')).join(', ') || '—', carousel: `${info.capabilities.carouselMin}–${info.capabilities.carouselMax}` })}</p>}
                </div>
              )}
              {isTikTok && f.kind !== 'TEXT' && <TikTokPanel accountId={tiktokAccountId} kind={f.kind} media={media as MediaItem[]} draft={tt} onChange={setTt} onValidity={setTtReady} />}
              {isTikTok && f.kind === 'TEXT' && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="tiktok-needs-media">{t('social.publishing.manualWarning', { platform: t('calendar.platforms.TIKTOK'), kind: t('calendar.types.TEXT') })}</p>}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="cp-date" label={t('calendar.entry.date')}><Input id="cp-date" type="date" min={today} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
                <Field id="cp-time" label={t('calendar.entry.time')} hint={t('calendar.new.timeHint')}><Input id="cp-time" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
              </div>
              <p className="text-xs text-muted-foreground">{t('calendar.timezoneNote', { tz })} {t('social.publishing.estimateNote')}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !f.title.trim() || !f.platform || (isTikTok && f.kind !== 'TEXT' && !ttReady)} data-testid="save-draft">{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('social.publishing.saveDraft')}</Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('social.publishing.pipelineTitle')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('social.publishing.pipelineHint')}</p>
          {pipeline.length === 0 ? <p className="text-sm text-muted-foreground">{t('social.publishing.pipelineEmpty')}</p> : (
            <ul className="grid gap-3" data-testid="pipeline">
              {pipeline.map((e) => (
                <li key={e.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-center" data-testid="pipeline-item" data-status={e.status} data-entry-id={e.id}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{e.platform && <PlatformLabel platform={e.platform} />}<span className="truncate">{e.title}</span><StatusBadge status={e.status} /></p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{fmt(e.scheduledAt, e.timezone)}{e.socialAccountId && accountLabel(e.socialAccountId) ? ` · ${accountLabel(e.socialAccountId)}` : ''}</p>
                    {e.status === 'FAILED' && e.lastError && <p className="mt-1 text-xs text-destructive">{e.lastError}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    {e.platform === 'TIKTOK' && can('content.write') && !['PUBLISHED', 'PUBLISHING', 'CANCELLED'].includes(e.status) && <Button size="sm" variant="outline" onClick={() => void openTikTok(e)} data-testid="pipe-tiktok">{t('social.tiktok.editSettings')}</Button>}
                    {(e.status === 'DRAFT' || e.status === 'REJECTED') && can('content.write') && <Button size="sm" variant="outline" disabled={acting === e.id} onClick={() => void act(e, 'submit')} data-testid="pipe-submit">{t('calendar.actions.submit')}</Button>}
                    {e.status === 'IN_REVIEW' && can('content.approve') && <Button size="sm" disabled={acting === e.id} onClick={() => void act(e, 'approve')} data-testid="pipe-approve">{t('calendar.actions.approve')}</Button>}
                    {e.status === 'APPROVED' && can('publication.schedule') && <Button size="sm" onClick={() => { setNow(e); setAuthorize(false); }} data-testid="pipe-publish-now"><Send className="h-4 w-4" aria-hidden />{t('social.publishing.publishNow')}</Button>}
                    <Button size="sm" variant="ghost" asChild><Link href={`/dashboard/calendar/day?date=${e.local.date}`}>{t('social.publishing.openInCalendar')}</Link></Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <MediaPicker open={picker} onClose={() => setPicker(false)} businessId={active?.id ?? ''} multiple={f.kind === 'CAROUSEL'} initial={media} onSelect={setMedia} />
      <Dialog open={ttEntry !== null} onClose={() => setTtEntry(null)} title={t('social.tiktok.settingsTitle')} description={t('social.tiktok.settingsText')} closeLabel={t('common.close')}>
        {ttEntry && (
          <div className="grid gap-4" data-testid="tiktok-settings-dialog">
            <TikTokPanel accountId={accountFor(ttEntry.entry)} kind={(ttEntry.entry.content?.type ?? 'VIDEO') as 'IMAGE' | 'VIDEO' | 'CAROUSEL' | 'TEXT'} media={ttEntry.media} draft={ttEntry.draft} onChange={(d) => setTtEntry((x) => (x ? { ...x, draft: d } : x))} onValidity={(ok) => setTtEntry((x) => (x && x.ready !== ok ? { ...x, ready: ok } : x))} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setTtEntry(null)}>{t('common.cancel')}</Button>
              <Button disabled={!ttEntry.ready || acting === ttEntry.entry.id} onClick={() => void saveTikTok()} data-testid="tiktok-save">{acting === ttEntry.entry.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('social.tiktok.save')}</Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={now !== null} onClose={() => setNow(null)} title={t('social.publishing.nowTitle')} description={t('social.publishing.nowText')} closeLabel={t('common.close')}>
        {now && (
          <div className="grid gap-4" data-testid="publish-now-dialog">
            <p className="text-sm"><span className="font-medium">{now.title}</span> · {now.platform && t(`calendar.platforms.${now.platform}`)}</p>
            {now.platform === 'TIKTOK' && <TikTokSummary settings={now.content?.platformOptions?.tiktok as Partial<TikTokPostSettings> | undefined} nickname={accountLabel(accountFor(now))} />}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} data-testid="now-authorize" /><span>{now.platform === 'TIKTOK' ? t('social.tiktok.confirmNow') : t('social.publishing.authorizeNow')}</span></label>
            {now.platform === 'TIKTOK' && <p className="text-xs text-muted-foreground">{t('social.tiktok.processing')}</p>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setNow(null)}>{t('common.cancel')}</Button>
              <Button disabled={!authorize || acting === now.id || (now.platform === 'TIKTOK' && !now.content?.platformOptions?.tiktok)} onClick={() => void act(now, 'publish-now')} data-testid="now-confirm">{acting === now.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('social.publishing.publishNow')}</Button>
            </div>
          </div>
        )}
      </Dialog>
      {dialog}
    </div>
  );
}

