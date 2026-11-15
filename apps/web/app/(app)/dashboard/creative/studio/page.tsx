'use client';
import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, ImagePlus, Loader2, Save, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { CreativeSection } from '@/components/creative/creative-section';
import { DailyQuota, useDailyQuota } from '@/components/creative/daily-quota';
import { CreativeError, CreativeJobProgress } from '@/components/creative/job';
import { StudioMedia } from '@/components/creative/studio-media';
import type { CreativeGeneration } from '@/components/creative/types';
import { useCreativeJob, useCreativeStatus } from '@/components/creative/use-creative';
import { useI18n } from '@/components/i18n-provider';
import { MediaPicker } from '@/components/media/media-picker';
import type { MediaItem } from '@/components/media/media-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { qs, useResource, type Paged } from '@/lib/use-resource';

type Kind = 'IMAGE' | 'VIDEO';
type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE';
const ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const;
const FORMAT_FOR: Record<string, string> = { '1:1': 'SQUARE', '4:5': 'PORTRAIT', '9:16': 'SHORT_VERTICAL', '16:9': 'LANDSCAPE' };
const IMAGE_STYLES = ['PHOTOREALISTIC', 'MINIMAL', 'LUXURY', 'PLAYFUL', 'BOLD', 'NATURAL', 'VINTAGE', 'MODERN'];
const VIDEO_STYLES = ['CINEMATIC', 'UGC', 'MINIMAL', 'ENERGETIC', 'LUXURY', 'DOCUMENTARY'];

interface Project {
  id: string; name: string; status: string; caption: string | null; activeGenerationId: string | null; creations?: number;
  brief: { kind: Kind; description: string; aspectRatio: string; style: string; platform: Platform; language: 'en' | 'fr' };
  script: { simulated: boolean; hook?: string; scenes?: Array<{ order: number; seconds: number; visual: string }>; hashtags?: string[]; disclaimer?: string } | null;
  scheduleSim: { outcome: string; effectiveMode: string; requestedMode: string; reasons: string[]; checks: Array<{ check: string; ok: boolean; detail: string }>; note: string } | null;
  generations?: Array<{ id: string; kind: Kind; status: string; simulated: boolean; createdAt: string; outputs: Array<{ id: string; width: number | null; height: number | null; media: MediaItem }> }>;
}
interface LibraryItem { outputId: string; generationId: string; type: Kind; projectId: string | null; simulated: boolean; createdAt: string; width: number | null; height: number | null; media: MediaItem }

export default function StudioPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const quota = useDailyQuota();
  const status = useCreativeStatus();
  const job = useCreativeJob();
  const free = status.data?.freeTestMode ?? false;

  const [kind, setKind] = useState<Kind>('IMAGE');
  const [description, setDescription] = useState('');
  const [aspect, setAspect] = useState<string>('1:1');
  const [style, setStyle] = useState('MINIMAL');
  const [photo, setPhoto] = useState<MediaItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [rights, setRights] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>('INSTAGRAM');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [libType, setLibType] = useState<'' | Kind>('');
  const [libProject, setLibProject] = useState('');
  const [when, setWhen] = useState('');

  const projects = useResource<Project[]>('/creative/projects', active?.id);
  const library = useResource<Paged<LibraryItem> & { items: LibraryItem[] }>(`/creative/library${qs({ type: libType || undefined, projectId: libProject || undefined, pageSize: 24 })}`, active?.id);
  const [project, setProject] = useState<Project | null>(null);
  const loadProject = useCallback(async (id: string) => { if (active) setProject(await api<Project>(`/creative/projects/${id}`, { businessId: active.id })); }, [active]);
  useEffect(() => { if (projectId) void loadProject(projectId).catch(() => setProject(null)); else setProject(null); }, [projectId, loadProject]);
  useEffect(() => { setProjectId(null); job.setResult(null); }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = job.result as CreativeGeneration | null;
  const exhausted = quota.data ? (kind === 'IMAGE' ? quota.data.images.remaining : quota.data.videos.remaining) <= 0 : false;
  const canGenerate = can('ai.use') && !job.pending && !busy && description.trim().length >= 3 && !exhausted && (!photo || rights);
  const refresh = () => { quota.reload(); projects.reload(); library.reload(); if (projectId) void loadProject(projectId); };
  const brief = () => ({ kind, description: description.trim(), aspectRatio: aspect, style, platform, language: locale === 'fr' ? 'fr' : 'en' });

  async function act<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e))); return null; } finally { setBusy(false); }
  }
  const call = <T,>(path: string, method: string, json?: unknown) => api<T>(path, { method, json, businessId: active!.id });

  async function generate() {
    const common = { ...(projectId ? { projectId } : {}), ...(photo ? { sourceMediaId: photo.id, rightsConfirmed: rights } : {}) };
    const g = kind === 'IMAGE'
      ? await job.run('/creative/images', { type: 'PRODUCT_AD', aspectRatio: aspect, style, platform: 'ANY', count: 1, instructions: description.trim(), ...common })
      : await job.run('/creative/videos', { format: FORMAT_FOR[aspect], seconds: 8, style: style as string, instructions: description.trim(), ...common });
    refresh();
    return g;
  }
  async function saveProject() {
    const p = await act(() => projectId ? call<Project>(`/creative/projects/${projectId}`, 'PATCH', { name: name || undefined, brief: brief() }) : call<Project>('/creative/projects', 'POST', { name: name.trim() || description.trim().slice(0, 60), brief: brief() }));
    if (p) { setProjectId(p.id); refresh(); }
  }
  const post = async (path: string, json?: unknown) => { const r = await act(() => call<Project>(path, 'POST', json)); if (projectId) await loadProject(projectId); refresh(); return r; };
  const openProject = (p: Project) => { setProjectId(p.id); setName(p.name); setKind(p.brief.kind); setDescription(p.brief.description); setAspect(p.brief.aspectRatio); setStyle(p.brief.style); setPlatform(p.brief.platform); job.setResult(null); };
  const removeLib = async (generationId: string) => { await act(() => call<void>(`/creative/generations/${generationId}`, 'DELETE')); refresh(); };

  return (
    <CreativeSection title={t('creative.studio.title')} description={t('creative.studio.subtitle')}>
      {free && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm" role="note" data-testid="free-mode-banner">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div><p className="font-semibold">{t('creative.studio.freeTitle')}</p><p className="text-muted-foreground">{t('creative.studio.freeText')}</p></div>
        </div>
      )}
      <DailyQuota data={quota.data} />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card className="h-fit"><CardContent className="grid gap-4 p-4 sm:p-6">
          <div role="radiogroup" aria-label={t('creative.studio.kind')} className="grid grid-cols-2 gap-2">
            {(['IMAGE', 'VIDEO'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} data-testid={`studio-kind-${k}`} onClick={() => { setKind(k); setStyle(k === 'IMAGE' ? 'MINIMAL' : 'CINEMATIC'); }}
                className={`rounded-lg border p-3 text-sm font-medium ${kind === k ? 'border-primary bg-primary/10' : ''}`}>{t(`creative.studio.kinds.${k}`)}</button>
            ))}
          </div>
          <Field id="st-desc" label={t('creative.studio.description')} hint={t('creative.studio.descriptionHint')}>
            <Textarea id="st-desc" rows={4} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('creative.studio.descriptionPlaceholder')} />
          </Field>
          <div className="grid gap-2">
            <p className="text-sm font-medium">{t('creative.studio.photo')}</p>
            {photo ? (
              <div className="flex items-center gap-2 rounded-lg border p-2 text-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {photo.url && <img src={photo.url} alt="" className="h-12 w-12 rounded object-cover" />}
                <span className="min-w-0 flex-1 truncate">{photo.originalFilename}</span>
                <Button type="button" variant="ghost" size="icon" aria-label={t('creative.studio.removePhoto')} onClick={() => { setPhoto(null); setRights(false); }}><X className="h-4 w-4" /></Button>
              </div>
            ) : <Button type="button" variant="outline" onClick={() => setPicker(true)}><ImagePlus className="h-4 w-4" aria-hidden />{t('creative.studio.choosePhoto')}</Button>}
            {photo && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={rights} onChange={(e) => setRights(e.target.checked)} data-testid="studio-rights" />{t('creative.studio.rights')}</label>}
          </div>
          <Field id="st-aspect" label={t('creative.studio.format')}>
            <Select id="st-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)}>{ASPECTS.map((a) => <option key={a} value={a}>{t(`creative.studio.aspects.${a}`)}</option>)}</Select>
          </Field>
          <Field id="st-style" label={t('creative.studio.style')}>
            <Select id="st-style" value={style} onChange={(e) => setStyle(e.target.value)}>
              {(kind === 'IMAGE' ? IMAGE_STYLES : VIDEO_STYLES).map((v) => <option key={v} value={v}>{t(kind === 'IMAGE' ? `creative.enums.styles.${v}` : `creative.enums.videoStyles.${v}`)}</option>)}
            </Select>
          </Field>
          {kind === 'VIDEO' && <p className="text-xs text-muted-foreground">{t('creative.studio.videoLength')}</p>}
          <Button type="button" size="lg" disabled={!canGenerate} onClick={() => void generate()} data-testid="studio-generate">
            {job.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}{t('creative.studio.generate')}
          </Button>
          {exhausted && <p className="text-sm text-destructive" role="alert">{t('creative.daily.exhausted')}</p>}
        </CardContent></Card>

        <div className="grid content-start gap-4">
          <CreativeJobProgress job={job.job} kind={kind} />
          <CreativeError error={job.error ?? error} />
          {current ? (
            <section className="grid gap-3" aria-label={t('creative.studio.result')} data-testid="studio-result">
              <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{t('creative.studio.result')}</h2>{current.provider === 'mock' && <Badge variant="warning">{t('creative.studio.simulatedBadge')}</Badge>}</div>
              <div className="max-w-sm">{current.outputs[0] && <StudioMedia media={current.outputs[0].media} simulated={current.provider === 'mock'} ratio={aspect} />}</div>
              <div className="flex flex-wrap items-end gap-2">
                <Field id="st-name" label={t('creative.studio.projectName')}><input id="st-name" className="h-10 rounded-md border bg-background px-3 text-sm" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
                <Button type="button" variant="outline" disabled={busy || !can('ai.use') || !(name.trim() || description.trim())} onClick={() => void saveProject()} data-testid="studio-save"><Save className="h-4 w-4" aria-hidden />{projectId ? t('creative.studio.updateProject') : t('creative.studio.saveProject')}</Button>
              </div>
            </section>
          ) : !job.pending && <EmptyState title={t('creative.studio.emptyTitle')} hint={t('creative.studio.emptyText')} />}

          {project && (
            <section className="grid gap-3 rounded-xl border p-4" aria-label={t('creative.studio.workflow')} data-testid="studio-workflow">
              <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('creative.studio.workflow')}: {project.name}</h2><Badge>{t(`creative.studio.projectStatus.${project.status}`)}</Badge></div>
              <ol className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-5">{['brief', 'script', 'visuals', 'caption', 'schedule'].map((s) => <li key={s} className="rounded-md bg-muted px-2 py-1">{t(`creative.studio.steps.${s}`)}</li>)}</ol>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy || !free} onClick={() => void post(`/creative/projects/${project.id}/script`)} data-testid="studio-script">{t('creative.studio.prepareScript')}</Button>
              </div>
              {project.script && (
                <div className="grid gap-1 text-sm" data-testid="studio-script-view">
                  {project.script.hook && <p className="font-medium">{project.script.hook}</p>}
                  <ul className="list-disc pl-5 text-muted-foreground">{project.script.scenes?.map((s) => <li key={s.order}>{s.seconds}s — {s.visual}</li>)}</ul>
                  {project.caption && <p className="rounded-md bg-muted p-2" data-testid="studio-caption">{project.caption}</p>}
                  {project.script.disclaimer && <p className="text-xs text-muted-foreground">{project.script.disclaimer}</p>}
                </div>
              )}
              {project.generations && project.generations.filter((g) => g.status === 'SUCCEEDED').length > 1 && (
                <div className="grid gap-2"><p className="text-xs font-semibold uppercase text-muted-foreground">{t('creative.studio.history')}</p>
                  <ul className="flex flex-wrap gap-2">{project.generations.filter((g) => g.status === 'SUCCEEDED').map((g) => (
                    <li key={g.id} className={`flex items-center gap-2 rounded-md border p-1 text-xs ${project.activeGenerationId === g.id ? 'border-primary' : ''}`}>
                      <span>{new Date(g.createdAt).toLocaleString(locale)}</span>
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void post(`/creative/projects/${project.id}/restore`, { generationId: g.id })}><Undo2 className="h-3.5 w-3.5" aria-hidden />{t('creative.studio.restore')}</Button>
                    </li>))}</ul></div>
              )}
              {can('publication.schedule') && (
                <div className="grid gap-2 border-t pt-3">
                  <p className="text-sm font-medium">{t('creative.studio.scheduleTitle')}</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <Select aria-label={t('creative.studio.platform')} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>{(['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const).map((p) => <option key={p} value={p}>{p}</option>)}</Select>
                    <input type="datetime-local" aria-label={t('creative.studio.when')} className="h-10 rounded-md border bg-background px-3 text-sm" value={when} onChange={(e) => setWhen(e.target.value)} />
                    {(['HYBRID', 'AUTO'] as const).map((m) => <Button key={m} type="button" size="sm" variant="outline" disabled={busy || !when} data-testid={`studio-schedule-${m}`} onClick={() => void post(`/creative/projects/${project.id}/schedule-simulation`, { platform, scheduledAt: new Date(when).toISOString(), mode: m })}>{t(`creative.studio.simulate.${m}`)}</Button>)}
                  </div>
                  {project.scheduleSim && (
                    <div className="rounded-md border border-dashed p-3 text-sm" data-testid="studio-schedule-result">
                      <p className="font-medium">{t(`creative.studio.outcome.${project.scheduleSim.outcome}`)}</p>
                      <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">{project.scheduleSim.checks.map((c) => <li key={c.check}>{c.ok ? '✓' : '•'} {c.detail}</li>)}</ul>
                      <p className="mt-2 text-xs">{project.scheduleSim.note}</p>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      <section className="mt-8 grid gap-4" aria-label={t('creative.studio.library')} data-testid="studio-library">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('creative.studio.library')}</h2>
          <div className="flex flex-wrap gap-2">
            <Select aria-label={t('creative.studio.filterType')} value={libType} onChange={(e) => setLibType(e.target.value as '' | Kind)}>
              <option value="">{t('creative.studio.allTypes')}</option><option value="IMAGE">{t('creative.studio.kinds.IMAGE')}</option><option value="VIDEO">{t('creative.studio.kinds.VIDEO')}</option>
            </Select>
            <Select aria-label={t('creative.studio.filterProject')} value={libProject} onChange={(e) => setLibProject(e.target.value)}>
              <option value="">{t('creative.studio.allProjects')}</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
        </div>
        {(projects.data ?? []).length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label={t('creative.studio.projects')}>{projects.data!.map((p) => (
            <li key={p.id}><button type="button" onClick={() => openProject(p)} className={`rounded-full border px-3 py-1 text-xs ${projectId === p.id ? 'border-primary bg-primary/10' : ''}`} data-testid="studio-project">{p.name} · {p.creations ?? 0}</button></li>))}</ul>
        )}
        {library.data && library.data.items.length === 0 ? <EmptyState title={t('creative.studio.libraryEmpty')} hint={t('creative.studio.libraryEmptyText')} /> : (
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {library.data?.items.map((it) => (
              <li key={it.outputId} className="grid gap-2" data-testid="studio-library-item">
                <StudioMedia media={it.media} simulated={it.simulated} ratio={it.width && it.height ? `${it.width}:${it.height}` : '1:1'} />
                {can('media.write') && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void removeLib(it.generationId)} data-testid="studio-library-delete"><Trash2 className="h-3.5 w-3.5" aria-hidden />{t('creative.studio.delete')}</Button>}
              </li>))}
          </ul>
        )}
      </section>
      {active && <MediaPicker open={picker} onClose={() => setPicker(false)} businessId={active.id} type="IMAGE" multiple={false} initial={photo ? [photo] : []} onSelect={(items) => { setPhoto(items[0] ?? null); setPicker(false); }} />}
    </CreativeSection>
  );
}
