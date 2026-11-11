'use client';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CALENDAR_LIMITS, CONTENT_PILLARS } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { PLATFORMS, type Entry, type Platform, type Recommendation } from './types';
import { useCalendarWrite, useErrorText } from './use-calendar';

/** Plan a post: title, platform, day, and either a time of your own or the recommended one (labelled as estimate or analytics). */
export function NewEntryDialog({ open, date, platform, onClose, onCreated }: { open: boolean; date: string; platform: Platform | ''; onClose: () => void; onCreated: (e: Entry) => void }) {
  const { t } = useI18n();
  const { active } = useBusiness();
  const errorText = useErrorText();
  const { send, dialog } = useCalendarWrite();
  const [f, setF] = useState({ title: '', platform: 'INSTAGRAM' as Platform, date, time: '', pillar: '', contentType: 'TEXT', caption: '' });
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setF((x) => ({ ...x, title: '', caption: '', time: '', date, platform: platform || x.platform }));
      setError(null);
    }
  }, [open, date, platform]);

  useEffect(() => {
    if (!open || !active || !f.date) return;
    let alive = true;
    api<Recommendation>(`/calendar/recommendations?platform=${f.platform}&date=${f.date}`, { businessId: active.id })
      .then((r) => alive && setRec(r))
      .catch(() => alive && setRec(null));
    return () => {
      alive = false;
    };
  }, [open, active, f.platform, f.date]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await send<Entry>('/entries', 'POST', {
        title: f.title.trim(), platform: f.platform, localDate: f.date, ...(f.time ? { localTime: f.time } : {}), ...(f.pillar ? { pillar: f.pillar } : {}), contentType: f.contentType, ...(f.caption.trim() ? { caption: f.caption.trim() } : {}),
      });
      if (created) {
        onCreated(created);
        onClose();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('calendar.new.title')} description={t('calendar.new.text')} closeLabel={t('common.close')} className="max-w-xl">
        <form onSubmit={submit} className="grid gap-4" data-testid="new-entry-form">
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Field id="ne-title" label={t('calendar.entry.title')}>
            <Input id="ne-title" required maxLength={CALENDAR_LIMITS.titleMax} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ne-platform" label={t('calendar.entry.platform')}>
              <Select id="ne-platform" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value as Platform })}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{t(`calendar.platforms.${p}`)}</option>)}
              </Select>
            </Field>
            <Field id="ne-pillar" label={t('calendar.entry.pillar')} optional optionalLabel={t('common.optional')}>
              <Select id="ne-pillar" value={f.pillar} onChange={(e) => setF({ ...f, pillar: e.target.value })}>
                <option value="">—</option>
                {CONTENT_PILLARS.map((p) => <option key={p} value={p}>{t(`calendar.pillars.${p}`)}</option>)}
              </Select>
            </Field>
            <Field id="ne-date" label={t('calendar.entry.date')}>
              <Input id="ne-date" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value, time: '' })} />
            </Field>
            <Field id="ne-time" label={t('calendar.entry.time')} hint={f.time ? undefined : t('calendar.new.timeHint')}>
              <Input id="ne-time" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
            </Field>
          </div>
          {rec && rec.slots.length > 0 && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm" data-testid="recommendation" data-source={rec.source}>
              <p className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={rec.source === 'ANALYTICS' ? 'success' : 'warning'}>{t(`calendar.timeSource.${rec.source}`)}</Badge>
                <span className="text-xs text-muted-foreground">{rec.note}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {rec.slots.map((s) => (
                  <Button key={s.time} type="button" size="sm" variant={f.time === s.time ? 'default' : 'outline'} title={s.reason} onClick={() => setF({ ...f, time: s.time })}>{s.time}</Button>
                ))}
              </div>
            </div>
          )}
          <Field id="ne-type" label={t('calendar.entry.type')}>
            <Select id="ne-type" value={f.contentType} onChange={(e) => setF({ ...f, contentType: e.target.value })}>
              {['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'].map((x) => <option key={x} value={x}>{t(`calendar.types.${x}`)}</option>)}
            </Select>
          </Field>
          <Field id="ne-caption" label={t('calendar.entry.caption')} optional optionalLabel={t('common.optional')}>
            <Textarea id="ne-caption" rows={3} maxLength={CALENDAR_LIMITS.captionMax} value={f.caption} onChange={(e) => setF({ ...f, caption: e.target.value })} />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy || !f.title.trim() || !f.date} data-testid="ne-submit">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('calendar.new.create')}
            </Button>
          </div>
        </form>
      </Dialog>
      {dialog}
    </>
  );
}
