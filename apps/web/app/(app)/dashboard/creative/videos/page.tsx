'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ImagePlus, Loader2, Sparkles, X } from 'lucide-react';
import { ItemSelect, parseItem } from '@/components/ai/selectors';
import type { Generation } from '@/components/ai/types';
import { useBusiness } from '@/components/business-provider';
import { CreativeSection } from '@/components/creative/creative-section';
import { CreativeError, CreativeJobProgress } from '@/components/creative/job';
import { NotConfigured } from '@/components/creative/not-configured';
import { downloadUrl, VideoPlayer } from '@/components/creative/results';
import type { CreativeGeneration, Storyboard } from '@/components/creative/types';
import { useCreativeJob, useCreativeStatus } from '@/components/creative/use-creative';
import { useI18n } from '@/components/i18n-provider';
import { MediaPicker } from '@/components/media/media-picker';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/states';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { qs, useResource, type Paged } from '@/lib/use-resource';

function VideosView() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const params = useSearchParams();
  const status = useCreativeStatus();
  const job = useCreativeJob();
  const videos = useResource<Paged<CreativeGeneration>>(`/creative/generations${qs({ kind: 'VIDEO', status: 'SUCCEEDED', pageSize: 12 })}`, active?.id);
  const boards = useResource<Paged<Generation<Storyboard>>>(`/creative/storyboards${qs({ status: 'SUCCEEDED', pageSize: 30 })}`, active?.id);
  const caps = status.data?.video.capabilities;
  const configured = status.data?.video.configured ?? false;
  const formats = status.data?.options.videoFormats ?? {};

  const [format, setFormat] = useState('SHORT_VERTICAL');
  const [seconds, setSeconds] = useState(8);
  const [style, setStyle] = useState('CINEMATIC');
  const [item, setItem] = useState('');
  const [storyboardId, setStoryboardId] = useState(params.get('storyboard') ?? '');
  const [scene, setScene] = useState('');
  const [photo, setPhoto] = useState<MediaItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [open, setOpen] = useState<CreativeGeneration | null>(null);

  const board = boards.data?.items.find((b) => b.id === storyboardId)?.output ?? null;
  const rule = formats[format];
  const lengths = (caps?.seconds ?? [4, 8, 12]).filter((s) => !rule || (s >= rule.minSeconds && s <= rule.maxSeconds + 12));
  useEffect(() => job.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (board && formats[board.format]) {
      setFormat(board.format);
      setSeconds(lengths.find((s) => s >= Math.min(board.totalSeconds, lengths[lengths.length - 1] ?? 12)) ?? lengths[lengths.length - 1] ?? 8);
    }
  }, [board?.format]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (job.result) void videos.reload();
  }, [job.result?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = job.result as CreativeGeneration | null;
  const canGenerate = can('ai.use') && configured && !job.pending;
  const aspects = caps?.aspectRatios ?? [];
  const availableFormats = Object.keys(formats).filter((k) => !caps || aspects.includes(formats[k]!.aspect));

  return (
    <CreativeSection title={t('creative.videos.title')} description={t('creative.videos.subtitle')}>
      {status.data && !configured && <NotConfigured kind="video" />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardContent className="grid gap-4 pt-6">
            <Field id="vd-storyboard" label={t('creative.videos.storyboard')} hint={t('creative.videos.storyboardHint')}>
              <Select id="vd-storyboard" value={storyboardId} onChange={(e) => { setStoryboardId(e.target.value); setScene(''); }} aria-describedby="vd-storyboard-hint">
                <option value="">{t('creative.videos.noStoryboard')}</option>
                {boards.data?.items.map((b) => <option key={b.id} value={b.id}>{b.output?.title ?? b.id}</option>)}
              </Select>
            </Field>
            {board && (
              <Field id="vd-scene" label={t('creative.videos.scene')}>
                <Select id="vd-scene" value={scene} onChange={(e) => setScene(e.target.value)}>
                  <option value="">{t('creative.videos.allScenes')}</option>
                  {board.scenes.map((s) => <option key={s.order} value={s.order}>{t('creative.storyboards.scene', { n: s.order })} ({s.durationSeconds}s)</option>)}
                </Select>
              </Field>
            )}
            <ItemSelect value={item} onChange={setItem} />
            <div className="grid grid-cols-2 gap-3">
              <Field id="vd-format" label={t('creative.videos.format')}>
                <Select id="vd-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                  {(availableFormats.length ? availableFormats : Object.keys(formats)).map((k) => <option key={k} value={k}>{t(`creative.enums.videoFormats.${k}`)}</option>)}
                </Select>
              </Field>
              <Field id="vd-seconds" label={t('creative.videos.seconds')} hint={t('creative.videos.secondsHint')}>
                <Select id="vd-seconds" value={String(seconds)} onChange={(e) => setSeconds(Number(e.target.value))} aria-describedby="vd-seconds-hint">
                  {lengths.map((s) => <option key={s} value={s}>{s}s</option>)}
                </Select>
              </Field>
            </div>
            <Field id="vd-style" label={t('creative.videos.style')}>
              <Select id="vd-style" value={style} onChange={(e) => setStyle(e.target.value)}>
                {(status.data?.options.videoStyles ?? [style]).map((s) => <option key={s} value={s}>{t(`creative.enums.videoStyles.${s}`)}</option>)}
              </Select>
            </Field>
            {caps?.imageToVideo && (
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t('creative.videos.photo')}</span>
                {photo ? (
                  <div className="flex items-center gap-3 rounded-lg border p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.thumbnailUrl ?? photo.url ?? undefined} alt="" className="h-12 w-12 rounded-md object-cover" />
                    <span className="min-w-0 flex-1 truncate text-sm">{photo.originalFilename}</span>
                    <Button size="icon" variant="ghost" onClick={() => setPhoto(null)} aria-label={t('creative.images.removePhoto')}><X className="h-4 w-4" aria-hidden /></Button>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => setPicker(true)}><ImagePlus className="h-4 w-4" aria-hidden />{t('creative.images.choosePhoto')}</Button>
                )}
              </div>
            )}
            <Field id="vd-instructions" label={t('ai.fields.instructions')} optional optionalLabel={t('common.optional')}>
              <Textarea id="vd-instructions" rows={2} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </Field>
            {!can('ai.use') && <p className="text-sm text-muted-foreground">{t('ai.noPermission')}</p>}
            <Button disabled={!canGenerate} className="w-full" onClick={() => void job.run('/creative/videos', { format, seconds, style, ...parseItem(item), ...(storyboardId ? { storyboardId } : {}), ...(scene ? { sceneOrder: Number(scene) } : {}), ...(photo ? { sourceMediaId: photo.id } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) })}>
              {job.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              {job.pending ? t('creative.videos.generating') : t('creative.videos.generate')}
            </Button>
          </CardContent>
        </Card>

        <div className="grid min-w-0 content-start gap-4">
          <CreativeJobProgress job={job.job} kind="VIDEO" />
          <CreativeError error={job.error} />
          {current ? (
            <div className="mx-auto grid w-full max-w-sm gap-2" data-testid="video-result">
              <VideoPlayer generation={current} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{t('creative.videos.usageLine', { s: current.usage.producedUnits, model: current.model })}{current.usage.costKnown && ` · ≈ $${current.usage.costUsd.toFixed(3)}`}</span>
                <Button size="sm" variant="outline" asChild><a href={downloadUrl(current.outputs[0]?.media.url ?? null)}>{t('creative.images.download')}</a></Button>
              </div>
            </div>
          ) : (
            !job.pending && <EmptyState title={t('creative.videos.empty')} hint={configured ? t('creative.videos.emptyHint') : t('creative.videos.emptyUnconfigured')} />
          )}
          {videos.data && videos.data.items.length > 0 && (
            <section aria-label={t('creative.videos.yours')}>
              <h2 className="mb-2 text-sm font-semibold">{t('creative.videos.yours')}</h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="video-list">
                {videos.data.items.map((v) => (
                  <li key={v.id}>
                    <button type="button" onClick={() => setOpen(v)} className="group w-full overflow-hidden rounded-xl border text-start" aria-label={t('creative.videos.open', { date: new Date(v.createdAt).toLocaleDateString(locale) })}>
                      <div className="relative aspect-[9/16] bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {v.outputs[0]?.media.thumbnailUrl && <img src={v.outputs[0].media.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
                      </div>
                      <p className="p-2 text-xs text-muted-foreground">{v.usage.producedUnits}s · {new Date(v.createdAt).toLocaleDateString(locale)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} title={t('creative.videos.title')} className="max-w-md" closeLabel={t('common.close')}>
        {open && <VideoPlayer generation={open} />}
      </Dialog>
      {active && <MediaPicker open={picker} onClose={() => setPicker(false)} businessId={active.id} type="IMAGE" multiple={false} initial={photo ? [photo] : []} onSelect={(items) => { setPhoto(items[0] ?? null); setPicker(false); }} />}
    </CreativeSection>
  );
}

export default function VideosPage() {
  return (
    <Suspense>
      <VideosView />
    </Suspense>
  );
}
