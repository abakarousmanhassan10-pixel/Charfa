'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, Sparkles, Trash2 } from 'lucide-react';
import { CALENDAR_LIMITS, CONTENT_PILLARS, todayIn } from '@touma/shared';
import { AiError } from '@/components/ai/ai-error';
import { JobProgress } from '@/components/ai/review';
import { LanguageSelect, ToneSelect } from '@/components/ai/selectors';
import type { Generation } from '@/components/ai/types';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { useResource, type Paged } from '@/lib/use-resource';
import { cn } from '@/lib/utils';
import { addDays, formatDate, weekdayNames } from './date-utils';
import { PlatformDot } from './status';
import { PLATFORMS, type Platform, type PlanPreview, type Recurrence } from './types';
import { useCalendarWrite, useErrorText, useOverview } from './use-calendar';

const PILLAR_COLOR: Record<string, string> = {
  PROMOTIONAL: 'bg-rose-500', EDUCATIONAL: 'bg-sky-500', PRODUCT_SHOWCASE: 'bg-violet-500', ENGAGEMENT: 'bg-amber-500', BRAND_AWARENESS: 'bg-emerald-500', SEASONAL: 'bg-fuchsia-500',
};

/** The 30-day planner: describe what you want, review the AI plan day by day, then put it on the calendar as drafts. */
export function PlannerView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const ai = useAiStatus();
  const overview = useOverview();
  const gen = useGenerate();
  const errorText = useErrorText();
  const { send, dialog } = useCalendarWrite();
  const tz = overview.data?.timezone ?? 'UTC';
  const today = overview.data?.today ?? todayIn(tz);
  const [form, setForm] = useState({ startDate: '', days: 30, postsPerWeek: 5, language: active?.defaultLocale ?? locale, tone: '', goal: '', instructions: '' });
  const [platforms, setPlatforms] = useState<Platform[]>(['INSTAGRAM', 'FACEBOOK']);
  const [occasions, setOccasions] = useState<Array<{ date: string; name: string }>>([]);
  const [occ, setOcc] = useState({ date: '', name: '' });
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{ planId: string; created: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const plans = useResource<Paged<Generation>>('/calendar/plans?status=SUCCEEDED&pageSize=5', active?.id);
  const start = form.startDate || addDays(today, 1);

  useEffect(() => gen.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(id: string) {
    if (!active) return;
    setMessage(null);
    setApplied(null);
    setSkip(new Set());
    try {
      setPreview(await api<PlanPreview>(`/calendar/plans/${id}`, { businessId: active.id }));
    } catch (e) {
      setPreview(null);
      setMessage(errorText(e));
    }
  }
  useEffect(() => {
    if (gen.result?.id) {
      void load(gen.result.id);
      void plans.reload();
    }
  }, [gen.result?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generate(ev: React.FormEvent) {
    ev.preventDefault();
    setPreview(null);
    setApplied(null);
    await gen.run('/calendar/plans', {
      startDate: start, days: form.days, postsPerWeek: form.postsPerWeek, platforms, language: form.language, ...(form.tone ? { tone: form.tone } : {}), ...(form.goal.trim() ? { goal: form.goal.trim() } : {}), occasions, ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
    });
  }

  async function apply() {
    if (!preview) return;
    setApplying(true);
    setMessage(null);
    try {
      const res = await send<{ planId: string; created: number }>(`/plans/${preview.generationId}/apply`, 'POST', { skip: [...skip] });
      if (res) {
        setApplied(res);
        void load(preview.generationId).then(() => setApplied(res));
        void overview.reload();
      }
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setApplying(false);
    }
  }

  const byDay = useMemo(() => {
    const m = new Map<number, PlanPreview['items']>();
    for (const it of preview?.items ?? []) m.set(it.day, [...(m.get(it.day) ?? []), it]);
    return m;
  }, [preview]);
  const names = weekdayNames(locale);
  const canGenerate = can('ai.use') && (ai.data?.configured ?? false) && !gen.pending && platforms.length > 0;
  const total = preview ? Object.values(preview.balance).reduce((a, b) => a + b, 0) : 0;
  const startDow = preview ? (new Date(`${preview.plan.startDate}T12:00:00Z`).getUTCDay() + 6) % 7 : 0;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader><CardTitle>{t('calendar.planner.title')}</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">{t('calendar.planner.intro')}</p>
          {ai.data && !ai.data.configured && <p className="mb-4 rounded-md bg-amber-500/10 px-3 py-2 text-sm" data-testid="planner-not-configured">{t('calendar.planner.notConfigured')}</p>}
          <form onSubmit={generate} className="grid gap-4" data-testid="planner-form">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field id="pl-start" label={t('calendar.planner.start')}><Input id="pl-start" type="date" min={today} value={start} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field id="pl-days" label={t('calendar.planner.days')}><Input id="pl-days" type="number" min={CALENDAR_LIMITS.planMinDays} max={CALENDAR_LIMITS.planMaxDays} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} /></Field>
              <Field id="pl-ppw" label={t('calendar.planner.perWeek')}><Input id="pl-ppw" type="number" min={CALENDAR_LIMITS.postsPerWeekMin} max={CALENDAR_LIMITS.postsPerWeekMax} value={form.postsPerWeek} onChange={(e) => setForm({ ...form, postsPerWeek: Number(e.target.value) })} /></Field>
              <LanguageSelect value={form.language} onChange={(v) => setForm({ ...form, language: v })} />
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{t('calendar.planner.platforms')}</legend>
              <div className="flex flex-wrap gap-3">
                {PLATFORMS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} />
                    <PlatformDot platform={p} />
                    {t(`calendar.platforms.${p}`)}
                    {overview.data?.connectedPlatforms.includes(p) && <Badge variant="success">{t('calendar.planner.connected')}</Badge>}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <ToneSelect value={form.tone || 'FRIENDLY'} onChange={(v) => setForm({ ...form, tone: v })} />
              <Field id="pl-goal" label={t('calendar.planner.goal')} optional optionalLabel={t('common.optional')}><Input id="pl-goal" maxLength={300} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} /></Field>
            </div>
            <fieldset className="grid gap-2 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">{t('calendar.planner.occasions')}</legend>
              <p className="text-xs text-muted-foreground">{t('calendar.planner.occasionsHint')}</p>
              <ul className="grid gap-1" data-testid="occasion-list">
                {occasions.map((o, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5 text-sm">
                    <span>{formatDate(o.date, locale, { dateStyle: 'medium' })} · {o.name}</span>
                    <button type="button" className="text-muted-foreground hover:text-destructive" aria-label={t('calendar.planner.removeOccasion', { name: o.name })} onClick={() => setOccasions((x) => x.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></button>
                  </li>
                ))}
              </ul>
              <div className="grid items-end gap-2 sm:grid-cols-[10rem_1fr_auto]">
                <Field id="oc-date" label={t('calendar.entry.date')}><Input id="oc-date" type="date" min={start} max={addDays(start, form.days - 1)} value={occ.date} onChange={(e) => setOcc({ ...occ, date: e.target.value })} /></Field>
                <Field id="oc-name" label={t('calendar.planner.occasionName')}><Input id="oc-name" maxLength={80} value={occ.name} onChange={(e) => setOcc({ ...occ, name: e.target.value })} /></Field>
                <Button type="button" variant="outline" disabled={!occ.date || occ.name.trim().length < 2 || occasions.length >= CALENDAR_LIMITS.occasionsMax} onClick={() => { setOccasions((x) => [...x, { date: occ.date, name: occ.name.trim() }]); setOcc({ date: '', name: '' }); }}>{t('calendar.planner.addOccasion')}</Button>
              </div>
            </fieldset>
            <Field id="pl-instr" label={t('calendar.planner.instructions')} optional optionalLabel={t('common.optional')}><Textarea id="pl-instr" rows={2} maxLength={500} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
            <div><Button type="submit" disabled={!canGenerate} data-testid="planner-generate">{gen.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}{gen.pending ? t('calendar.planner.generating') : t('calendar.planner.generate')}</Button></div>
          </form>
          <div className="mt-4 grid gap-3">
            <JobProgress job={gen.job} />
            <AiError error={gen.error} />
          </div>
        </CardContent>
      </Card>

      {message && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="planner-error">{message}</p>}

      {preview && (
        <Card data-testid="plan-preview">
          <CardHeader><CardTitle>{t('calendar.planner.previewTitle', { start: formatDate(preview.plan.startDate, locale, { dateStyle: 'medium' }), days: preview.plan.days })}</CardTitle></CardHeader>
          <CardContent className="grid gap-5">
            <p className="text-sm">{preview.plan.summary}</p>
            {preview.plan.missingInformation.length > 0 && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm">{t('calendar.planner.missing')}: {preview.plan.missingInformation.join('; ')}</p>}
            <div aria-label={t('calendar.planner.balance')} data-testid="plan-balance">
              <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                {CONTENT_PILLARS.filter((p) => preview.balance[p]).map((p) => <div key={p} className={PILLAR_COLOR[p]} style={{ width: `${(preview.balance[p]! / total) * 100}%` }} title={`${t(`calendar.pillars.${p}`)}: ${preview.balance[p]}`} />)}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {CONTENT_PILLARS.filter((p) => preview.balance[p]).map((p) => <li key={p} className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', PILLAR_COLOR[p])} aria-hidden />{t(`calendar.pillars.${p}`)} · {preview.balance[p]}</li>)}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="plan-time-note">{t('calendar.planner.timeNote', { tz: preview.timezone })}</p>
            <div className="hidden grid-cols-7 gap-1 text-center text-xs text-muted-foreground sm:grid">{names.map((n) => <span key={n}>{n}</span>)}</div>
            <div className="grid gap-2 sm:grid-cols-7" data-testid="plan-grid">
              {Array.from({ length: startDow }, (_, i) => <div key={`pad${i}`} className="hidden sm:block" />)}
              {Array.from({ length: preview.plan.days }, (_, i) => i + 1).map((day) => {
                const date = addDays(preview.plan.startDate, day - 1);
                const list = byDay.get(day) ?? [];
                return (
                  <section key={day} aria-label={formatDate(date, locale, { dateStyle: 'full' })} className="min-h-16 min-w-0 rounded-lg border p-1.5 text-xs" data-testid="plan-day">
                    <p className="mb-1 font-semibold text-muted-foreground">{formatDate(date, locale, { day: 'numeric', month: 'short' })}</p>
                    <div className="grid gap-1">
                      {list.map((it) => (
                        <label key={it.index} className={cn('flex cursor-pointer items-start gap-1.5 rounded-md border p-1', skip.has(it.index) && 'opacity-40')} data-testid="plan-item" data-pillar={it.pillar} title={it.brief}>
                          <input type="checkbox" className="mt-0.5" disabled={Boolean(preview.appliedPlanId)} checked={!skip.has(it.index)} onChange={(e) => setSkip((s) => { const n = new Set(s); if (e.target.checked) n.delete(it.index); else n.add(it.index); return n; })} aria-label={t('calendar.planner.include', { title: it.title })} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1"><span className={cn('h-2 w-2 shrink-0 rounded-full', PILLAR_COLOR[it.pillar])} aria-hidden /><PlatformDot platform={it.platform} /><span className="truncate font-medium">{it.title}</span></span>
                            <span className="block text-[11px] text-muted-foreground">{it.proposed?.scheduledAt ? `${new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: preview.timezone }).format(new Date(it.proposed.scheduledAt))} · ${t(`calendar.timeSource.${it.proposed.source}`)}` : t('calendar.planner.noTime')}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {preview.appliedPlanId || applied ? (
                <p className="text-sm" data-testid="plan-applied">
                  {t('calendar.planner.applied', { count: applied?.created ?? 0 })}{' '}
                  <Link href={`/dashboard/calendar/month?date=${preview.plan.startDate}`} className="font-medium text-primary underline">{t('calendar.planner.openCalendar')}</Link>
                </p>
              ) : (
                <>
                  <Button onClick={apply} disabled={applying || !can('content.write')} data-testid="plan-apply">{applying && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('calendar.planner.apply', { count: preview.items.length - skip.size })}</Button>
                  <p className="text-xs text-muted-foreground">{t('calendar.planner.applyHint')}</p>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {(plans.data?.items.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('calendar.planner.previous')}</CardTitle></CardHeader>
          <CardContent>
            <ul className="grid gap-2" data-testid="plan-history">
              {plans.data!.items.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(g.createdAt))}</span>
                  <Button size="sm" variant="outline" onClick={() => void load(g.id)}>{t('calendar.planner.open')}</Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <RecurrencePanel send={send} />
      {dialog}
    </div>
  );
}

function RecurrencePanel({ send }: { send: ReturnType<typeof useCalendarWrite>['send'] }) {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const errorText = useErrorText();
  const overview = useOverview();
  const list = useResource<{ items: Recurrence[] }>('/calendar/recurrences', active?.id);
  const today = overview.data?.today ?? todayIn('UTC');
  const [f, setF] = useState({ title: '', platform: 'INSTAGRAM' as Platform, frequency: 'WEEKLY', weekdays: [1] as number[], localTime: '09:00', startDate: '', endDate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remove, setRemove] = useState<Recurrence | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const names = weekdayNames(locale);
  const start = f.startDate || addDays(today, 1);
  const end = f.endDate || addDays(start, 27);

  async function create(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await send<{ created: number }>('/recurrences', 'POST', { title: f.title.trim(), platform: f.platform, frequency: f.frequency, ...(f.frequency === 'WEEKLY' ? { weekdays: f.weekdays } : {}), localTime: f.localTime, startDate: start, endDate: end });
      if (res) {
        setDone(t('calendar.recurrence.created', { count: res.created }));
        setF((x) => ({ ...x, title: '' }));
        void list.reload();
        void overview.reload();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="recurrence-panel">
      <CardHeader><CardTitle>{t('calendar.recurrence.title')}</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('calendar.recurrence.intro')}</p>
        {(list.data?.items.length ?? 0) > 0 && (
          <ul className="grid gap-2" data-testid="recurrence-list">
            {list.data!.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span><span className="font-medium">{r.title}</span> · {t(`calendar.platforms.${r.platform}`)} · {r.frequency === 'DAILY' ? t('calendar.recurrence.daily') : r.weekdays.map((d) => names[(d + 6) % 7]).join(', ')} · {r.localTime} · {t('calendar.recurrence.entries', { count: r.entries })}</span>
                {can('content.write') && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemove(r)}>{t('calendar.recurrence.stop')}</Button>}
              </li>
            ))}
          </ul>
        )}
        {can('content.write') && (
          <form onSubmit={create} className="grid gap-3" data-testid="recurrence-form">
            {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {done && <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm" data-testid="recurrence-done">{done}</p>}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id="rc-title" label={t('calendar.entry.title')}><Input id="rc-title" required maxLength={CALENDAR_LIMITS.titleMax} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
              <Field id="rc-platform" label={t('calendar.entry.platform')}><Select id="rc-platform" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value as Platform })}>{PLATFORMS.map((p) => <option key={p} value={p}>{t(`calendar.platforms.${p}`)}</option>)}</Select></Field>
              <Field id="rc-freq" label={t('calendar.recurrence.frequency')}><Select id="rc-freq" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="WEEKLY">{t('calendar.recurrence.weekly')}</option><option value="DAILY">{t('calendar.recurrence.daily')}</option></Select></Field>
              <Field id="rc-time" label={t('calendar.entry.time')}><Input id="rc-time" type="time" value={f.localTime} onChange={(e) => setF({ ...f, localTime: e.target.value })} /></Field>
              <Field id="rc-start" label={t('calendar.recurrence.from')}><Input id="rc-start" type="date" min={today} value={start} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
              <Field id="rc-end" label={t('calendar.recurrence.until')}><Input id="rc-end" type="date" min={start} max={addDays(start, CALENDAR_LIMITS.recurrenceMaxDays)} value={end} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
            </div>
            {f.frequency === 'WEEKLY' && (
              <fieldset className="flex flex-wrap gap-2"><legend className="sr-only">{t('calendar.recurrence.weekdays')}</legend>
                {names.map((n, i) => {
                  const wd = (i + 1) % 7;
                  return <label key={n} className={cn('cursor-pointer rounded-md border px-3 py-1.5 text-sm', f.weekdays.includes(wd) && 'border-primary bg-primary/10')}><input type="checkbox" className="sr-only" checked={f.weekdays.includes(wd)} onChange={(e) => setF((x) => ({ ...x, weekdays: e.target.checked ? [...x.weekdays, wd] : x.weekdays.filter((d) => d !== wd) }))} />{n}</label>;
                })}
              </fieldset>
            )}
            <div><Button type="submit" disabled={busy || !f.title.trim() || (f.frequency === 'WEEKLY' && f.weekdays.length === 0)} data-testid="recurrence-create">{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('calendar.recurrence.create')}</Button></div>
          </form>
        )}
      </CardContent>
      <ConfirmDialog
        open={remove !== null}
        title={t('calendar.recurrence.stopTitle')}
        description={t('calendar.recurrence.stopText')}
        confirmLabel={t('calendar.recurrence.stop')}
        cancelLabel={t('common.cancel')}
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          if (!remove || !active) return;
          await api(`/calendar/recurrences/${remove.id}`, { method: 'DELETE', businessId: active.id });
          setRemove(null);
          void list.reload();
          void overview.reload();
        }}
      />
    </Card>
  );
}
