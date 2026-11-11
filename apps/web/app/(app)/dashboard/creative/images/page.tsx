'use client';
import { useEffect, useState } from 'react';
import { ImagePlus, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { ItemSelect, parseItem } from '@/components/ai/selectors';
import { useBusiness } from '@/components/business-provider';
import { CreativeError, CreativeJobProgress } from '@/components/creative/job';
import { CreativeSection } from '@/components/creative/creative-section';
import { NotConfigured } from '@/components/creative/not-configured';
import { ResultsGrid } from '@/components/creative/results';
import type { CreativeGeneration } from '@/components/creative/types';
import { useCreativeJob, useCreativeStatus } from '@/components/creative/use-creative';
import { useI18n } from '@/components/i18n-provider';
import { MediaPicker } from '@/components/media/media-picker';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/ui/states';

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-4 border-t pt-4 first:border-0 first:pt-0">
      <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      {children}
    </fieldset>
  );
}

export default function ImagesPage() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const status = useCreativeStatus();
  const job = useCreativeJob();
  const o = status.data?.options;
  const configured = status.data?.image.configured ?? false;

  const [item, setItem] = useState('');
  const [photo, setPhoto] = useState<MediaItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [preservation, setPreservation] = useState<'EXACT' | 'GUIDED'>('EXACT');
  const [type, setType] = useState('PRODUCT_AD');
  const [style, setStyle] = useState('');
  const [background, setBackground] = useState('WHITE_STUDIO');
  const [backgroundNote, setBackgroundNote] = useState('');
  const [theme, setTheme] = useState('NONE');
  const [themeNote, setThemeNote] = useState('');
  const [platform, setPlatform] = useState('ANY');
  const [aspect, setAspect] = useState('1:1');
  const [resolution, setResolution] = useState('STANDARD');
  const [count, setCount] = useState(2);
  const [overlayText, setOverlayText] = useState('');
  const [overlayPosition, setOverlayPosition] = useState('BOTTOM');
  const [logoPlacement, setLogoPlacement] = useState('NONE');
  const [useBrandKit, setUseBrandKit] = useState(true);
  const [instructions, setInstructions] = useState('');

  useEffect(() => job.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const allowed = o?.platformAspects[platform];
    if (allowed && !allowed.includes(aspect)) setAspect(allowed[0]!);
  }, [platform, aspect, o]);

  const current = job.result as CreativeGeneration | null;
  const body = () => ({
    type, ...(style ? { style } : {}), aspectRatio: aspect, resolution, background, ...(background === 'CUSTOM' && backgroundNote ? { backgroundNote } : {}),
    theme, ...(theme === 'CUSTOM' && themeNote ? { themeNote } : {}), platform, ...parseItem(item), ...(photo ? { sourceMediaId: photo.id, preservation } : {}),
    count, useBrandKit, overlayPosition, logoPlacement, ...(overlayText.trim() ? { overlayText: overlayText.trim() } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
  });
  const maxCount = Math.min(o?.limits.maxImagesPerRequest ?? 4, status.data?.image.capabilities?.maxImagesPerRequest ?? 4);
  const canGenerate = can('ai.use') && configured && !job.pending;
  const sel = (label: string, id: string, value: string, set: (v: string) => void, options: string[], text: (v: string) => string) => (
    <Field id={id} label={label}>
      <Select id={id} value={value} onChange={(e) => set(e.target.value)}>
        {options.map((v) => <option key={v} value={v}>{text(v)}</option>)}
      </Select>
    </Field>
  );

  return (
    <CreativeSection title={t('creative.images.title')} description={t('creative.images.subtitle')}>
      {status.data && !configured && <NotConfigured kind="image" />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardContent className="grid gap-5 pt-6">
            <Group title={t('creative.images.sections.subject')}>
              <ItemSelect value={item} onChange={setItem} />
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t('creative.images.photo')}</span>
                {photo ? (
                  <div className="flex items-center gap-3 rounded-lg border p-2" data-testid="source-photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.thumbnailUrl ?? photo.url ?? undefined} alt={photo.altText ?? photo.originalFilename} className="h-16 w-16 rounded-md object-cover" />
                    <span className="min-w-0 flex-1 truncate text-sm">{photo.originalFilename}</span>
                    <Button size="icon" variant="ghost" onClick={() => setPhoto(null)} aria-label={t('creative.images.removePhoto')}><X className="h-4 w-4" aria-hidden /></Button>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => setPicker(true)} disabled={!active}>
                    <ImagePlus className="h-4 w-4" aria-hidden />
                    {t('creative.images.choosePhoto')}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">{photo ? t('creative.images.photoHint') : t('creative.images.illustration')}</p>
              </div>
              {photo && (
                <div role="radiogroup" aria-label={t('creative.images.preservation')} className="grid gap-2">
                  {(['EXACT', 'GUIDED'] as const).map((m) => (
                    <label key={m} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${preservation === m ? 'border-primary bg-primary/5' : ''}`}>
                      <input type="radio" name="preservation" value={m} checked={preservation === m} onChange={() => setPreservation(m)} className="mt-1" />
                      <span>
                        <span className="block font-medium">{t(`creative.images.mode.${m}`)}</span>
                        <span className="block text-xs text-muted-foreground">{t(`creative.images.mode.${m}Hint`)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </Group>

            <Group title={t('creative.images.sections.look')}>
              {sel(t('creative.images.type'), 'cr-type', type, setType, o?.imageTypes ?? [type], (v) => t(`creative.enums.types.${v}`))}
              <Field id="cr-style" label={t('creative.images.style')} hint={t('creative.images.styleHint')}>
                <Select id="cr-style" value={style} onChange={(e) => setStyle(e.target.value)}>
                  <option value="">{t('creative.images.styleDefault')}</option>
                  {(o?.styles ?? []).map((v) => <option key={v} value={v}>{t(`creative.enums.styles.${v}`)}</option>)}
                </Select>
              </Field>
              {sel(t('creative.images.background'), 'cr-bg', background, setBackground, o?.backgrounds ?? [background], (v) => t(`creative.enums.backgrounds.${v}`))}
              {background === 'CUSTOM' && (
                <Field id="cr-bgnote" label={t('creative.images.backgroundNote')}>
                  <Input id="cr-bgnote" value={backgroundNote} maxLength={200} onChange={(e) => setBackgroundNote(e.target.value)} />
                </Field>
              )}
              {sel(t('creative.images.theme'), 'cr-theme', theme, setTheme, o?.themes ?? [theme], (v) => t(`creative.enums.themes.${v}`))}
              {theme === 'CUSTOM' && (
                <Field id="cr-themenote" label={t('creative.images.themeNote')}>
                  <Input id="cr-themenote" value={themeNote} maxLength={120} onChange={(e) => setThemeNote(e.target.value)} />
                </Field>
              )}
            </Group>

            <Group title={t('creative.images.sections.format')}>
              {sel(t('creative.images.platform'), 'cr-platform', platform, setPlatform, o?.platforms ?? [platform], (v) => t(`ai.platforms.${v}`))}
              <div className="grid grid-cols-2 gap-3">
                {sel(t('creative.images.aspect'), 'cr-aspect', aspect, setAspect, o?.platformAspects[platform] ?? [aspect], (v) => v)}
                {sel(t('creative.images.resolution'), 'cr-res', resolution, setResolution, Object.keys(o?.resolutions ?? { STANDARD: 1080 }), (v) => t(`creative.enums.resolutions.${v}`))}
              </div>
              <Field id="cr-count" label={t('creative.images.count')} hint={t('creative.images.countHint')}>
                <Select id="cr-count" value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
                  {Array.from({ length: maxCount }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </Field>
            </Group>

            <Group title={t('creative.images.sections.text')}>
              <Field id="cr-overlay" label={t('creative.images.overlay')} hint={t('creative.images.overlayHint')} optional optionalLabel={t('common.optional')}>
                <Input id="cr-overlay" value={overlayText} maxLength={o?.limits.maxOverlayChars ?? 120} onChange={(e) => setOverlayText(e.target.value)} aria-describedby="cr-overlay-hint" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                {sel(t('creative.images.overlayPosition'), 'cr-opos', overlayPosition, setOverlayPosition, o?.overlayPositions ?? [overlayPosition], (v) => t(`creative.enums.positions.${v}`))}
                {sel(t('creative.images.logo'), 'cr-logo', logoPlacement, setLogoPlacement, o?.logoPlacements ?? [logoPlacement], (v) => t(`creative.enums.logoPlacements.${v}`))}
              </div>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={useBrandKit} onChange={(e) => setUseBrandKit(e.target.checked)} className="mt-1" />
                <span>
                  <span className="block font-medium">{t('creative.images.useBrandKit')}</span>
                  <span className="block text-xs text-muted-foreground">{t('creative.images.useBrandKitHint')}</span>
                </span>
              </label>
              <Field id="cr-instructions" label={t('ai.fields.instructions')} optional optionalLabel={t('common.optional')}>
                <Textarea id="cr-instructions" rows={2} maxLength={o?.limits.maxInstructionChars ?? 500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </Field>
            </Group>

            {!can('ai.use') && <p className="text-sm text-muted-foreground">{t('ai.noPermission')}</p>}
            <Button onClick={() => void job.run('/creative/images', body())} disabled={!canGenerate} className="w-full">
              {job.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              {job.pending ? t('creative.images.generating') : t('creative.images.generate')}
            </Button>
          </CardContent>
        </Card>

        <div className="grid min-w-0 content-start gap-4">
          <CreativeJobProgress job={job.job} kind="IMAGE" />
          <CreativeError error={job.error} />
          {current ? (
            <>
              <ResultsGrid generation={current} original={photo?.url ? { url: photo.url, name: photo.originalFilename } : null} onChange={(g) => job.setResult(g)} />
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="creative-usage">
                <span>
                  {t('creative.images.usageLine', { n: current.usage.producedUnits, seconds: (current.usage.processingMs / 1000).toFixed(1), model: current.model })}
                  {current.usage.costKnown && ` · ≈ $${current.usage.costUsd.toFixed(3)}`}
                </span>
                {can('ai.use') && (
                  <Button size="sm" variant="outline" disabled={job.pending || !configured} onClick={() => void job.run(`/creative/generations/${current.id}/variations`, { count: Math.min(2, maxCount) })}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    {t('creative.images.moreVariations')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            !job.pending && <EmptyState title={t('creative.images.empty')} hint={t('creative.images.emptyHint')} />
          )}
        </div>
      </div>
      {active && <MediaPicker open={picker} onClose={() => setPicker(false)} businessId={active.id} type="IMAGE" multiple={false} initial={photo ? [photo] : []} onSelect={(items) => { setPhoto(items[0] ?? null); setPicker(false); }} />}
    </CreativeSection>
  );
}
