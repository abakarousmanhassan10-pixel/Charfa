'use client';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { todayIn } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { addDays, formatDate, monthEnd, monthGrid, monthStart, shiftDate, weekStart, weekdayNames } from './date-utils';
import { EntryChip, MOVABLE } from './entry-chip';
import { EntryDialog } from './entry-dialog';
import { NewEntryDialog } from './new-entry-dialog';
import { Legend } from './status';
import { PLATFORMS, type Entry, type Platform } from './types';
import { useCalendarWrite, useErrorText, useOverview, useRange } from './use-calendar';

type View = 'month' | 'week' | 'day';

/**
 * The month, week and day calendars: one data flow (range of entries in the business timezone), one set of dialogs,
 * drag and drop to reschedule (keeping the local time, or setting the hour in the day view), platform filter and
 * status colors. On phones the grids become agendas: tap an entry to open it and use "Move" in its dialog.
 */
export function CalendarBoard({ view }: { view: View }) {
  const { t, locale } = useI18n();
  const { can } = useBusiness();
  const errorText = useErrorText();
  const params = useSearchParams();
  const overview = useOverview();
  const tz = overview.data?.timezone ?? 'UTC';
  const today = overview.data?.today ?? todayIn(tz);
  const initial = params.get('date');
  const [anchor, setAnchor] = useState<string | null>(initial && /^\d{4}-\d{2}-\d{2}$/.test(initial) ? initial : null);
  const date = anchor ?? today;
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [open, setOpen] = useState<Entry | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<Entry | null>(null);
  const { send, dialog } = useCalendarWrite();

  const [from, to] = useMemo(() => {
    if (view === 'month') return [weekStart(monthStart(date)), addDays(weekStart(monthEnd(date)), 6)] as const;
    if (view === 'week') return [weekStart(date), addDays(weekStart(date), 6)] as const;
    return [date, date] as const;
  }, [view, date]);
  const range = useRange(from, to, platform);
  const items = useMemo(() => range.data?.items ?? [], [range.data]);
  const conflictIds = useMemo(() => new Set((range.data?.conflicts ?? []).map((c) => c.entryId)), [range.data]);
  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of items) m.set(e.local.date, [...(m.get(e.local.date) ?? []), e]);
    return m;
  }, [items]);
  const conflictsOf = (e: Entry) => (range.data?.conflicts ?? []).filter((c) => c.entryId === e.id);
  const movable = (e: Entry) => MOVABLE.includes(e.status) && can('content.write') && (e.status !== 'SCHEDULED' || can('publication.schedule'));
  const reload = useCallback(() => {
    void range.reload();
    void overview.reload();
  }, [range, overview]);

  async function move(entry: Entry, localDate: string, localTime = entry.local.time) {
    if (entry.local.date === localDate && entry.local.time === localTime) return;
    setNotice(null);
    try {
      const res = await send<Entry>(`/entries/${entry.id}/reschedule`, 'POST', { localDate, localTime });
      if (res) setNotice(t('calendar.moved', { title: res.title, date: formatDate(res.local.date, locale, { dateStyle: 'medium' }), time: res.local.time }));
    } catch (err) {
      setNotice(errorText(err));
    } finally {
      reload();
    }
  }
  const dropOn = (localDate: string, localTime?: string) => (ev: React.DragEvent) => {
    ev.preventDefault();
    const e = drag.current;
    drag.current = null;
    if (e && movable(e)) void move(e, localDate, localTime);
  };
  const dragOver = (ev: React.DragEvent) => {
    if (drag.current) ev.preventDefault();
  };
  const chip = (e: Entry, showDate = false) => (
    <EntryChip key={e.id} entry={e} onOpen={setOpen} draggable={movable(e)} onDragStart={(x) => (drag.current = x)} conflict={conflictIds.has(e.id)} showDate={showDate} />
  );

  const title =
    view === 'month' ? formatDate(date, locale, { month: 'long', year: 'numeric' }) : view === 'week' ? `${formatDate(from, locale, { day: 'numeric', month: 'short' })} – ${formatDate(to, locale, { day: 'numeric', month: 'short', year: 'numeric' })}` : formatDate(date, locale, { dateStyle: 'full' });
  const names = weekdayNames(locale);

  return (
    <div data-testid={`calendar-${view}`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => setAnchor(shiftDate(date, view, -1))} aria-label={t('calendar.nav.previous')}><ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden /></Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(null)}>{t('calendar.nav.today')}</Button>
          <Button variant="outline" size="icon" onClick={() => setAnchor(shiftDate(date, view, 1))} aria-label={t('calendar.nav.next')}><ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden /></Button>
        </div>
        <h2 className="min-w-0 flex-1 text-lg font-semibold capitalize" aria-live="polite" data-testid="calendar-title">{title}</h2>
        <div className="w-40">
          <label htmlFor="cal-platform" className="sr-only">{t('calendar.entry.platform')}</label>
          <Select id="cal-platform" value={platform} onChange={(e) => setPlatform(e.target.value as Platform | '')} className="h-9">
            <option value="">{t('calendar.allPlatforms')}</option>
            {PLATFORMS.map((p) => <option key={p} value={p}>{t(`calendar.platforms.${p}`)}</option>)}
          </Select>
        </div>
        {can('content.write') && <Button size="sm" onClick={() => setCreating(date)} data-testid="new-entry"><Plus className="h-4 w-4" aria-hidden />{t('calendar.new.button')}</Button>}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('calendar.timezoneNote', { tz })}</p>
      <div className="mb-3 min-h-5 text-sm" role="status" aria-live="polite" data-testid="calendar-notice">{notice}</div>

      {range.loading && !range.data ? <LoadingRows rows={6} label={t('common.loading')} /> : range.error && !range.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void range.reload()} /> : (
        <>
          {view === 'month' && (
            <div>
              <div className="hidden grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border sm:grid" role="grid" aria-label={title}>
                {names.map((n) => <div key={n} className="bg-muted px-2 py-1.5 text-center text-xs font-medium text-muted-foreground" role="columnheader">{n}</div>)}
                {monthGrid(date).map((d) => {
                  const list = byDay.get(d) ?? [];
                  return (
                    <div key={d} role="gridcell" data-date={d} data-testid="day-cell" onDragOver={dragOver} onDrop={dropOn(d)} className={cn('min-h-28 bg-card p-1.5', d.slice(0, 7) !== date.slice(0, 7) && 'bg-muted/40 text-muted-foreground', d === today && 'ring-2 ring-inset ring-primary')}>
                      <div className="mb-1 flex items-center justify-between">
                        <button type="button" className={cn('rounded px-1 text-xs font-medium hover:bg-accent', d === today && 'bg-primary text-primary-foreground hover:bg-primary')} onClick={() => { setAnchor(d); }} aria-label={formatDate(d, locale, { dateStyle: 'full' })}>{Number(d.slice(8))}</button>
                        {can('content.write') && <button type="button" className="rounded px-1 text-xs text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100" onClick={() => setCreating(d)} aria-label={t('calendar.new.on', { date: formatDate(d, locale, { dateStyle: 'medium' }) })}>+</button>}
                      </div>
                      <div className="grid gap-1">
                        {list.slice(0, 3).map((e) => chip(e))}
                        {list.length > 3 && <button type="button" className="text-start text-xs text-muted-foreground hover:underline" onClick={() => setSelected(d)}>{t('calendar.more', { count: list.length - 3 })}</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Phones: a compact month with dots, then the agenda of the chosen day. */}
              <div className="sm:hidden" data-testid="month-compact">
                <div className="grid grid-cols-7 gap-px rounded-lg border bg-border text-center text-xs">
                  {names.map((n) => <div key={n} className="bg-muted py-1 text-muted-foreground">{n.slice(0, 2)}</div>)}
                  {monthGrid(date).map((d) => {
                    const list = byDay.get(d) ?? [];
                    return (
                      <button key={d} type="button" onClick={() => setSelected(d)} aria-label={`${formatDate(d, locale, { dateStyle: 'full' })}, ${t('calendar.count', { count: list.length })}`} aria-pressed={selected === d} className={cn('flex h-11 flex-col items-center justify-center gap-0.5 bg-card', d.slice(0, 7) !== date.slice(0, 7) && 'text-muted-foreground/60', d === today && 'font-bold text-primary', selected === d && 'bg-accent')}>
                        {Number(d.slice(8))}
                        <span className="flex h-1.5 gap-0.5">{list.slice(0, 3).map((e) => <span key={e.id} className="h-1.5 w-1.5 rounded-full bg-primary/70" />)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {selected && (
                <div className="mt-4 rounded-lg border p-3" data-testid="day-agenda">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{formatDate(selected, locale, { dateStyle: 'full' })}</h3>
                    <div className="flex gap-2">
                      {can('content.write') && <Button size="sm" variant="outline" onClick={() => setCreating(selected)}>{t('calendar.new.button')}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>{t('common.close')}</Button>
                    </div>
                  </div>
                  <div className="grid gap-1.5">{(byDay.get(selected) ?? []).length ? (byDay.get(selected) ?? []).map((e) => chip(e)) : <p className="text-sm text-muted-foreground">{t('calendar.emptyDay')}</p>}</div>
                </div>
              )}
            </div>
          )}

          {view === 'week' && (
            <div className="grid gap-2 sm:grid-cols-7" data-testid="week-grid">
              {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d, i) => {
                const list = byDay.get(d) ?? [];
                return (
                  <section key={d} data-date={d} data-testid="day-cell" aria-label={formatDate(d, locale, { dateStyle: 'full' })} onDragOver={dragOver} onDrop={dropOn(d)} className={cn('min-h-24 min-w-0 rounded-lg border bg-card p-2 sm:min-h-72', d === today && 'ring-2 ring-primary')}>
                    <div className="mb-2 flex items-center justify-between">
                      <button type="button" className="text-start text-sm font-semibold hover:underline" onClick={() => setAnchor(d)}>
                        <span className="text-muted-foreground">{names[i]}</span> {Number(d.slice(8))}
                      </button>
                      {can('content.write') && <button type="button" className="rounded px-1.5 text-sm text-muted-foreground hover:bg-accent" onClick={() => setCreating(d)} aria-label={t('calendar.new.on', { date: formatDate(d, locale, { dateStyle: 'medium' }) })}>+</button>}
                    </div>
                    <div className="grid gap-1">{list.length ? list.map((e) => chip(e)) : <p className="text-xs text-muted-foreground sm:hidden">{t('calendar.emptyDay')}</p>}</div>
                  </section>
                );
              })}
            </div>
          )}

          {view === 'day' && (
            <div className="rounded-lg border bg-card" data-testid="day-timeline">
              {Array.from({ length: 24 }, (_, h) => h)
                .filter((h) => (h >= 6 && h <= 22) || (byDay.get(date) ?? []).some((e) => Number(e.local.time.slice(0, 2)) === h))
                .map((h) => {
                  const hh = String(h).padStart(2, '0');
                  const list = (byDay.get(date) ?? []).filter((e) => Number(e.local.time.slice(0, 2)) === h);
                  return (
                    <div key={h} data-hour={hh} data-testid="hour-row" onDragOver={dragOver} onDrop={dropOn(date, `${hh}:00`)} className="grid grid-cols-[3.5rem_1fr] border-b last:border-b-0">
                      <div className="border-e px-2 py-2 text-xs tabular-nums text-muted-foreground">{hh}:00</div>
                      <div className="grid min-h-12 content-start gap-1 p-1.5">{list.map((e) => chip(e))}</div>
                    </div>
                  );
                })}
            </div>
          )}
        </>
      )}

      <div className="mt-4"><Legend /></div>
      {!overview.data?.publishing.available && <p className="mt-2 text-xs text-muted-foreground" data-testid="publishing-note">{t('calendar.publishingNote')}</p>}
      {view !== 'day' && <p className="mt-1 hidden text-xs text-muted-foreground sm:block">{t('calendar.dragHint')}</p>}

      <EntryDialog
        entry={open}
        conflicts={open ? conflictsOf(open) : []}
        publishingAvailable={Boolean(overview.data?.publishing.available)}
        onClose={() => setOpen(null)}
        onChanged={() => reload()}
      />
      <NewEntryDialog open={creating !== null} date={creating ?? date} platform={platform} onClose={() => setCreating(null)} onCreated={() => reload()} />
      {dialog}
    </div>
  );
}
