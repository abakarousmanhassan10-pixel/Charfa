'use client';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';

interface Issue { path: string; code: string; message: string; severity: 'error' | 'warning' }
interface Config { name: string; category: string; mission: string; instructions: string; provider: string; model: string; language: string; tone: string; tools: string[]; mode: 'AUTO' | 'HYBRID'; safety: { maxOutputTokens: number; maxCallsPerRun: number; maxRunsPerDay: number; acknowledgeAuto: boolean }; schedule: { timezone: string; hours: Array<{ days: number[]; from: string; to: string }> }; budget: { monthlyMicros: number; perRunMicros: number } }
interface AgentRow { id: string; name: string; status: string; revision: number; valid: boolean; config: Config; issues: Issue[] }
interface Options { categories: string[]; tones: string[]; languages: string[]; models: string[]; providers: Array<{ id: string; available: boolean; note: string }>; tools: Array<{ id: string; label: string; kind: string; enabled: boolean; risk: string; note: string }> }
interface TestResult { status: string; simulated: boolean; output: { reply: string; proposedActions: Array<{ tool: string; outcome: string; reason: string }>; modeEffect: string } | null; trace: Array<{ step: string; status: string; detail: string }>; issues?: Issue[] }
const EMPTY: Config = { name: '', category: 'CUSTOM', mission: '', instructions: '', provider: 'mock', model: 'mock-model', language: 'en', tone: 'friendly', tools: ['knowledge.lookup'], mode: 'HYBRID', safety: { maxOutputTokens: 600, maxCallsPerRun: 3, maxRunsPerDay: 20, acknowledgeAuto: false }, schedule: { timezone: 'UTC', hours: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }] }, budget: { monthlyMicros: 1_000_000, perRunMicros: 50_000 } };

/** Responsive no-code form: describe the agent, pick tools and limits, save a draft, duplicate it and test it in the simulator. Rules are enforced by the server; issues come back from it. */
export function AgentBuilderView() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const biz = active?.id;
  const [opts, setOpts] = useState<Options | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Config>(EMPTY);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [input, setInput] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!biz) return;
    try { const [o, a] = await Promise.all([api<Options>('/agent-builder/options', { businessId: biz }), api<AgentRow[]>('/agent-builder/agents', { businessId: biz })]); setOpts(o); setAgents(a); }
    catch (e) { if (e instanceof ApiError && e.status === 404) setNotEnabled(true); else setError(e instanceof ApiError ? e.message : 'error'); }
  }, [biz]);
  useEffect(() => { void load(); }, [load]);
  const call = <T,>(path: string, method: 'POST' | 'PUT' | 'DELETE' | 'GET', json?: unknown) => api<T>(`/agent-builder/${path}`, { method, businessId: biz, ...(json !== undefined ? { json } : {}) });
  async function run(fn: () => Promise<void>) { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : 'error'); } finally { setBusy(false); } }
  const open = (a: AgentRow) => { setCur(a.id); setCfg(a.config); setIssues(a.issues); setResult(null); };
  const fresh = () => { setCur(null); setCfg(EMPTY); setIssues([]); setResult(null); };
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const save = () => run(async () => { const a = cur ? await call<AgentRow>(`agents/${cur}`, 'PUT', cfg) : await call<AgentRow>('agents', 'POST', cfg); setCur(a.id); setCfg(a.config); setIssues(a.issues); await load(); });
  if (notEnabled) return <p className="rounded-md border p-4 text-sm" role="alert" data-testid="builder-disabled">{t('agentBuilder.notEnabled')}</p>;
  if (!opts) return <p className="text-sm text-muted-foreground" aria-busy="true"><Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</p>;
  const manage = can('agents.manage'), runTests = can('agents.run');
  const field = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
  const errs = issues.filter((i) => i.severity === 'error'), warns = issues.filter((i) => i.severity === 'warning');
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]" data-testid="agent-builder">
      <Card><CardHeader><CardTitle>{t('agentBuilder.myAgents')}</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm">
        {manage && <Button size="sm" data-testid="builder-new" onClick={fresh}>{t('agentBuilder.new')}</Button>}
        {agents.length === 0 && <p className="text-muted-foreground">{t('agentBuilder.none')}</p>}
        {agents.map((a) => <button key={a.id} className={`rounded-md border p-2 text-start ${a.id === cur ? 'border-primary' : ''}`} data-testid="builder-agent" onClick={() => open(a)}>{a.name}<span className="block text-xs text-muted-foreground">{a.status} · r{a.revision} · {a.valid ? t('agentBuilder.ready') : t('agentBuilder.incomplete')}</span></button>)}
      </CardContent></Card>
      <div className="grid gap-4">
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="builder-note">{t('agentBuilder.note')}</p>
        {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert" data-testid="builder-error">{error}</p>}
        <Card><CardHeader><CardTitle>{cur ? t('agentBuilder.edit') : t('agentBuilder.create')}</CardTitle><CardDescription>{t('agentBuilder.draftHelp')}</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <label className="grid gap-1">{t('agentBuilder.name')}<input className={field} value={cfg.name} maxLength={60} onChange={(e) => set('name', e.target.value)} data-testid="f-name" /></label>
          <label className="grid gap-1">{t('agentBuilder.category')}<select className={field} value={cfg.category} onChange={(e) => set('category', e.target.value)} data-testid="f-category">{opts.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="grid gap-1 sm:col-span-2">{t('agentBuilder.mission')}<textarea className={`${field} h-20 py-1`} value={cfg.mission} maxLength={500} onChange={(e) => set('mission', e.target.value)} data-testid="f-mission" /></label>
          <label className="grid gap-1 sm:col-span-2">{t('agentBuilder.instructions')}<textarea className={`${field} h-28 py-1`} value={cfg.instructions} maxLength={4000} onChange={(e) => set('instructions', e.target.value)} data-testid="f-instructions" /></label>
          <label className="grid gap-1">{t('agentBuilder.provider')}<select className={field} value={cfg.provider} onChange={(e) => set('provider', e.target.value)}>{opts.providers.map((p) => <option key={p.id} value={p.id}>{p.id}{p.available ? '' : ` (${t('agentBuilder.unavailable')})`}</option>)}</select></label>
          <label className="grid gap-1">{t('agentBuilder.model')}<select className={field} value={cfg.model} onChange={(e) => set('model', e.target.value)}>{opts.models.map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="grid gap-1">{t('agentBuilder.language')}<select className={field} value={cfg.language} onChange={(e) => set('language', e.target.value)}>{opts.languages.map((l) => <option key={l}>{l}</option>)}</select></label>
          <label className="grid gap-1">{t('agentBuilder.tone')}<select className={field} value={cfg.tone} onChange={(e) => set('tone', e.target.value)}>{opts.tones.map((l) => <option key={l}>{l}</option>)}</select></label>
          <fieldset className="grid gap-1 sm:col-span-2"><legend className="mb-1">{t('agentBuilder.tools')}</legend>
            {opts.tools.map((tool) => <label key={tool.id} className={`flex items-start gap-2 ${tool.enabled ? '' : 'opacity-60'}`}><input type="checkbox" disabled={!tool.enabled} checked={cfg.tools.includes(tool.id)} onChange={(e) => set('tools', e.target.checked ? [...cfg.tools, tool.id] : cfg.tools.filter((x) => x !== tool.id))} data-testid={`tool-${tool.id}`} /><span>{tool.label} <em className="text-xs text-muted-foreground">({tool.kind}, {tool.risk}{tool.enabled ? '' : `, ${t('agentBuilder.disabled')}`})</em></span></label>)}</fieldset>
          <fieldset className="grid gap-1 sm:col-span-2"><legend className="mb-1">{t('agentBuilder.mode')}</legend>
            <label className="flex gap-2"><input type="radio" checked={cfg.mode === 'HYBRID'} onChange={() => set('mode', 'HYBRID')} data-testid="mode-hybrid" />HYBRID — {t('agentBuilder.hybridHelp')}</label>
            <label className="flex gap-2"><input type="radio" checked={cfg.mode === 'AUTO'} onChange={() => set('mode', 'AUTO')} data-testid="mode-auto" />AUTO — {t('agentBuilder.autoHelp')}</label>
            {cfg.mode === 'AUTO' && <label className="flex gap-2"><input type="checkbox" checked={cfg.safety.acknowledgeAuto} onChange={(e) => set('safety', { ...cfg.safety, acknowledgeAuto: e.target.checked })} data-testid="ack-auto" />{t('agentBuilder.ackAuto')}</label>}</fieldset>
          <label className="grid gap-1">{t('agentBuilder.maxRuns')}<input type="number" min={1} max={200} className={field} value={cfg.safety.maxRunsPerDay} onChange={(e) => set('safety', { ...cfg.safety, maxRunsPerDay: Number(e.target.value) })} /></label>
          <label className="grid gap-1">{t('agentBuilder.budget')} (µUSD)<input type="number" min={0} className={field} value={cfg.budget.monthlyMicros} onChange={(e) => set('budget', { ...cfg.budget, monthlyMicros: Number(e.target.value) })} /></label>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('agentBuilder.hours')}: {cfg.schedule.hours.map((h) => `${h.from}–${h.to}`).join(', ')} ({cfg.schedule.timezone})</p>
          {(errs.length > 0 || warns.length > 0) && <ul className="sm:col-span-2 list-disc ps-5 text-xs" data-testid="builder-issues">{errs.map((i) => <li key={i.code + i.path} className="text-destructive">{i.message}</li>)}{warns.map((i) => <li key={i.code + i.path} className="text-amber-600">{i.message}</li>)}</ul>}
          {manage && <div className="flex flex-wrap gap-2 sm:col-span-2"><Button size="sm" disabled={busy} data-testid="builder-save" onClick={save}>{t('agentBuilder.save')}</Button>
            {cur && <Button size="sm" variant="outline" disabled={busy} data-testid="builder-duplicate" onClick={() => run(async () => { const a = await call<AgentRow>(`agents/${cur}/duplicate`, 'POST'); open(a); await load(); })}>{t('agentBuilder.duplicate')}</Button>}
            {cur && <Button size="sm" variant="outline" disabled={busy} data-testid="builder-archive" onClick={() => run(async () => { await call(`agents/${cur}`, 'DELETE'); fresh(); await load(); })}>{t('agentBuilder.archive')}</Button>}</div>}
        </CardContent></Card>
        {cur && runTests && <Card><CardHeader><CardTitle>{t('agentBuilder.test')}</CardTitle><CardDescription>{t('agentBuilder.testHelp')}</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm">
          <textarea className={`${field} h-20 py-1`} value={input} maxLength={1000} onChange={(e) => setInput(e.target.value)} placeholder={t('agentBuilder.testInput')} data-testid="test-input" />
          <div><Button size="sm" disabled={busy || !input.trim()} data-testid="test-run" onClick={() => run(async () => setResult(await call<TestResult>(`agents/${cur}/test`, 'POST', { input })))}>{t('agentBuilder.runTest')}</Button></div>
          {result && <div data-testid="test-result"><p className="font-medium">{result.status} · {t('agentBuilder.simulatedTag')}</p>
            {result.output && <p className="my-1">{result.output.reply}</p>}
            {result.output?.proposedActions.map((a) => <p key={a.tool} className="text-xs" data-testid="test-action">{a.tool}: <strong>{a.outcome}</strong> — {a.reason}</p>)}
            {result.issues?.map((i) => <p key={i.code} className="text-xs text-destructive">{i.message}</p>)}
            <ol className="mt-2 list-decimal ps-5 text-xs text-muted-foreground">{result.trace.map((s, i) => <li key={i}>{s.step} · {s.status} · {s.detail}</li>)}</ol></div>}
        </CardContent></Card>}
      </div>
    </div>
  );
}
