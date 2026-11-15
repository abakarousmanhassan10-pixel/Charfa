'use client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';

interface Profile { consentValid: boolean; enabled: boolean; autoPlan: boolean; currentConsentVersion: string; simulated: boolean; analyticsProvider: string; maxRunsPerDay: number; lastRunAt: string | null }
interface PlatformReport { platform: string; posts: number; measured: number; pendingMaturity: number; evidence: string; engagementRate: { n: number; mean: number | null }; metrics: Record<string, { n: number; mean: number | null }> }
interface Post { publicationId: string; platform: string; kind: string; title: string | null; publishedAt: string; engagementRate: number | null; origin: string; matured: boolean; measurement: { freshness: string; unavailableReason: string | null } | null }
interface Series { week: string; engagementRate: number | null; engagementN: number; origin: string }
interface Rec { id: string; kind: string; title: string; status: string; confidence: string; evidence: { justification: string; limitations: string[]; expectedEffects: Array<{ statement: string }>; dataUsed: { n: number; origin: string } } }
interface PrefRow { key: string; origin: string; value: unknown; status: string }
interface Prefs { declared: PrefRow[]; inferred: PrefRow[]; hypotheses: PrefRow[] }
interface Experiment { id: string; hypothesis: string; status: string; design: string; biasFlags: Array<{ code: string }> | null; result: { conclusion?: { text: string } } | null }
interface Run { id: string; trigger: string; status: string; startedAt: string; blockedReason: string | null; costEstimate: { aiCostMicros: number } | null; steps: Array<{ step: string; status: string; detail: string }> }
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

/** Adaptive learning dashboard: real vs simulated numbers, performance by network and post, evolution, proposals with their limits, remembered preferences, comparison tests, loop history. */
export function LearningView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const biz = active?.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [report, setReport] = useState<PlatformReport[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [exps, setExps] = useState<Experiment[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [tone, setTone] = useState('friendly');
  const load = useCallback(async () => {
    if (!biz) return;
    const g = <T,>(p: string) => api<T>(`/learning/${p}`, { businessId: biz });
    try {
      const [pr, rp, ps, se, rc, pf, ex, rn] = await Promise.all([g<Profile>('profile'), g<PlatformReport[]>('performance'), g<Post[]>('performance/posts'), g<Series[]>('performance/series'), g<Rec[]>('recommendations'), g<Prefs>('preferences'), g<Experiment[]>('experiments'), g<Run[]>('runs')]);
      setProfile(pr); setReport(rp); setPosts(ps); setSeries(se); setRecs(rc); setPrefs(pf); setExps(ex); setRuns(rn);
    } catch (e) { if (e instanceof ApiError && e.status === 404) setNotEnabled(true); else setError(e instanceof ApiError ? e.message : 'error'); }
  }, [biz]);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : 'error'); } finally { setBusy(false); } }
  const post = (path: string, json: unknown = {}, method: 'POST' | 'PUT' | 'DELETE' = 'POST') => api(`/learning/${path}`, { method, businessId: biz, json });
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  if (notEnabled) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="learning-disabled">{t('learning.notEnabled')}</p>;
  if (!profile || !prefs) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const manage = can('learning.manage');
  const anySim = report.some((r) => r.evidence !== 'REAL') || profile.simulated;
  const cost = runs.reduce((a, r) => a + (r.costEstimate?.aiCostMicros ?? 0), 0);
  const slots = recs.filter((r) => r.kind === 'POSTING_SLOT' && r.status === 'PROPOSED');
  return (
    <div className="grid gap-4" data-testid="learning-view">
      <p className={`rounded-md border p-3 text-sm ${anySim ? 'border-amber-500/30 bg-amber-500/10' : ''}`} data-testid="learning-origin">{anySim ? t('learning.simulatedNote') : t('learning.realNote')}</p>
      {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert" data-testid="learning-error">{error}</p>}

      <Card><CardHeader><CardTitle>{t('learning.consentTitle')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm">
        {!profile.consentValid ? (manage && <>
          <label className="flex items-start gap-2"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="learning-consent-check" /><span>{t('learning.consentText')} <em>({profile.currentConsentVersion})</em></span></label>
          <div><Button size="sm" disabled={busy || !agreed} data-testid="learning-consent" onClick={() => run(() => post('consent', { accept: true, consentVersion: profile.currentConsentVersion }))}>{t('learning.accept')}</Button></div></>)
          : <div className="flex flex-wrap items-center gap-2"><span data-testid="learning-on">{t('learning.active')}</span>
            {manage && <><Button size="sm" disabled={busy} data-testid="learning-run" onClick={() => run(() => post('runs'))}>{t('learning.runNow')}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => post('settings', { autoPlan: !profile.autoPlan }, 'PUT'))}>{profile.autoPlan ? t('learning.autoPlanOff') : t('learning.autoPlanOn')}</Button>
              <Button size="sm" variant="outline" disabled={busy} data-testid="learning-revoke" onClick={() => run(() => post('consent/revoke'))}>{t('learning.revoke')}</Button></>}</div>}
        <p className="text-xs text-muted-foreground" data-testid="learning-cost">{t('learning.cost')}: ${(cost / 1_000_000).toFixed(4)} ({t('learning.estimated')})</p>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>{t('learning.performance')}</CardTitle><CardDescription>{t('learning.performanceHelp')}</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm">
        {report.length === 0 && <p className="text-muted-foreground">{t('learning.noData')}</p>}
        {report.map((r) => (
          <div key={r.platform} className="rounded-md border p-3" data-testid="perf-platform">
            <p className="font-medium">{r.platform} <span className="rounded bg-muted px-1.5 py-0.5 text-xs" data-testid="perf-evidence">{r.evidence === 'REAL' ? t('learning.real') : r.evidence === 'SIMULATED' ? t('learning.simulated') : t('learning.mixed')}</span></p>
            <p className="text-muted-foreground">{r.posts} {t('learning.posts')} · {r.measured} {t('learning.measured')} · {r.pendingMaturity} {t('learning.pending')} · {t('learning.engagement')}: {pct(r.engagementRate.mean)} (n={r.engagementRate.n})</p>
            <p className="text-xs text-muted-foreground">{Object.entries(r.metrics).map(([k, v]) => `${k}: ${v.mean === null ? '—' : v.mean} (n=${v.n})`).join(' · ')}</p>
          </div>
        ))}
        {series.length > 0 && <div data-testid="perf-series"><p className="mb-1 font-medium">{t('learning.evolution')}</p><div className="flex items-end gap-1">{series.map((s) => <div key={s.week} title={`${s.week}: ${pct(s.engagementRate)} (n=${s.engagementN})`} className={`w-4 rounded-t ${s.origin === 'REAL' ? 'bg-primary' : 'bg-amber-500'}`} style={{ height: `${Math.max(4, Math.round((s.engagementRate ?? 0) * 800))}px` }} />)}</div></div>}
        {posts.slice(-8).reverse().map((p) => <p key={p.publicationId} className="text-xs" data-testid="perf-post">{fmt(p.publishedAt)} · {p.kind} · {p.title ?? '—'} · {pct(p.engagementRate)} · {p.origin === 'REAL' ? t('learning.real') : t('learning.simulated')}{p.measurement ? ` · ${p.measurement.freshness}` : ` · ${t('learning.notMeasured')}`}{p.measurement?.unavailableReason ? ` · ${p.measurement.unavailableReason}` : ''}</p>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>{t('learning.recommendations')}</CardTitle><CardDescription>{t('learning.recommendationsHelp')}</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm">
        {slots.length > 0 && <p data-testid="learning-slots">{t('learning.slots')}: {slots.map((s) => s.title).join(' · ')}</p>}
        {recs.length === 0 && <p className="text-muted-foreground" data-testid="recs-empty">{t('learning.noRecs')}</p>}
        {recs.map((r) => (
          <div key={r.id} className="rounded-md border p-3" data-testid="rec-row">
            <p className="font-medium">{r.title} <span className="text-xs text-muted-foreground">{r.confidence} · {r.status} · n={r.evidence.dataUsed.n} · {r.evidence.dataUsed.origin === 'REAL' ? t('learning.real') : t('learning.simulated')}</span></p>
            <p>{r.evidence.justification}</p>
            <ul className="my-1 list-disc ps-5 text-xs text-muted-foreground">{r.evidence.limitations.map((l) => <li key={l}>{l}</li>)}{r.evidence.expectedEffects.map((e) => <li key={e.statement}>{t('learning.toVerify')}: {e.statement}</li>)}</ul>
            {manage && r.status === 'PROPOSED' && <div className="flex gap-2"><Button size="sm" disabled={busy} data-testid="rec-accept" onClick={() => run(() => post(`recommendations/${r.id}/decision`, { decision: 'ACCEPT' }))}>{t('learning.accept')}</Button><Button size="sm" variant="outline" disabled={busy} data-testid="rec-reject" onClick={() => run(() => post(`recommendations/${r.id}/decision`, { decision: 'REJECT' }))}>{t('learning.reject')}</Button></div>}
          </div>
        ))}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>{t('learning.preferences')}</CardTitle><CardDescription>{t('learning.preferencesHelp')}</CardDescription></CardHeader><CardContent className="grid gap-2 text-sm">
        {([['declared', prefs.declared], ['inferred', prefs.inferred], ['hypotheses', prefs.hypotheses]] as const).map(([k, rows]) => (
          <div key={k} data-testid={`prefs-${k}`}><p className="font-medium">{t(`learning.${k}`)} ({rows.length})</p>{rows.map((r) => <p key={r.key + r.origin} className="text-xs text-muted-foreground">{r.key}: {JSON.stringify(r.value)}{r.status !== 'ACTIVE' ? ` (${r.status})` : ''}{manage && k === 'hypotheses' && r.status === 'ACTIVE' ? <> <button className="underline" onClick={() => run(() => post(`preferences/${encodeURIComponent(r.key)}/confirm`))}>{t('learning.confirm')}</button> <button className="underline" onClick={() => run(() => post(`preferences/${encodeURIComponent(r.key)}/reject`, { origin: 'HYPOTHESIS' }))}>{t('learning.reject')}</button></> : null}</p>)}</div>
        ))}
        {manage && <div className="flex flex-wrap items-center gap-2"><select className="h-8 rounded-md border bg-background px-2" value={tone} onChange={(e) => setTone(e.target.value)} aria-label={t('learning.tone')}>{['friendly', 'professional', 'playful', 'formal', 'inspiring'].map((x) => <option key={x}>{x}</option>)}</select>
          <Button size="sm" variant="outline" disabled={busy} data-testid="pref-tone" onClick={() => run(() => post('preferences/tone', { value: tone }, 'PUT'))}>{t('learning.saveTone')}</Button>
          <a className="text-xs underline" data-testid="prefs-export" href="#" onClick={async (e) => { e.preventDefault(); const d = await api<unknown>('/learning/preferences/export', { businessId: biz }); const u = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = 'touma-preferences.json'; a.click(); URL.revokeObjectURL(u); }}>{t('learning.export')}</a>
          <Button size="sm" variant="outline" disabled={busy} data-testid="prefs-erase" onClick={() => run(() => post('preferences', {}, 'DELETE'))}>{t('learning.erase')}</Button></div>}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>{t('learning.experiments')}</CardTitle><CardDescription>{t('learning.experimentsHelp')}</CardDescription></CardHeader><CardContent className="grid gap-2 text-sm">
        {exps.length === 0 && <p className="text-muted-foreground">{t('learning.noExperiments')}</p>}
        {exps.map((x) => <div key={x.id} data-testid="experiment-row"><p className="font-medium">{x.hypothesis} <span className="text-xs text-muted-foreground">{x.status} · {x.design}</span></p><p className="text-xs text-muted-foreground">{(x.biasFlags ?? []).map((b) => b.code).join(', ')}</p>{x.result?.conclusion && <p className="text-xs">{x.result.conclusion.text}</p>}</div>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>{t('learning.history')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm">
        {runs.length === 0 && <p className="text-muted-foreground">{t('learning.noRuns')}</p>}
        {runs.map((r) => <div key={r.id} data-testid="run-row"><p>{fmt(r.startedAt)} · {r.trigger} · <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.status}</span>{r.blockedReason ? ` · ${r.blockedReason}` : ''}{manage && r.status === 'COMPLETED' ? <> · <button className="underline" data-testid="run-rollback" onClick={() => run(() => post(`runs/${r.id}/rollback`))}>{t('learning.rollback')}</button></> : null}</p><p className="text-xs text-muted-foreground">{r.steps.map((s) => `${s.step}:${s.status}`).join(' → ')}</p></div>)}
      </CardContent></Card>
    </div>
  );
}
