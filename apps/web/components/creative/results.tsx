'use client';
import { useState } from 'react';
import { Download, GitCompare, Maximize2, Star } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { CreativeGeneration, CreativeOutput } from './types';

export const downloadUrl = (url: string | null) => (url ? `${url}${url.includes('?') ? '&' : '?'}download=1` : '#');

/** How the original product appearance was handled: the honest label of each result. */
export function PreservationBadge({ value }: { value: CreativeOutput['preservation'] }) {
  const { t } = useI18n();
  if (!value) return null;
  return <Badge variant={value === 'EXACT' ? 'success' : value === 'GUIDED' ? 'warning' : 'muted'}>{t(`creative.images.preserved.${value}`)}</Badge>;
}

/** The variations of an image generation: open, pick a favourite, download, and select up to two (or one plus the original) to compare. */
export function ResultsGrid({
  generation,
  original,
  onChange,
}: {
  generation: CreativeGeneration;
  original?: { url: string; name: string } | null;
  onChange: (g: CreativeGeneration) => void;
}) {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const [view, setView] = useState<CreativeOutput | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const outputs = generation.outputs;

  async function favourite(o: CreativeOutput) {
    if (!active) return;
    onChange(await api<CreativeGeneration>(`/creative/outputs/${o.id}`, { method: 'PATCH', businessId: active.id, json: { selected: !o.selected } }));
  }
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1]!, id] : [...p, id]));
  const compared = outputs.filter((o) => picked.includes(o.id));

  if (!outputs.length) return null;
  const ratio = (o: CreativeOutput) => (o.width && o.height ? o.width / o.height : 1);
  return (
    <section aria-label={t('creative.images.results')} data-testid="creative-results">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('creative.images.results')} <span className="font-normal text-muted-foreground">({outputs.length})</span></h2>
        <Button size="sm" variant="outline" onClick={() => setComparing(true)} disabled={compared.length < 1 || (compared.length < 2 && !original)} data-testid="compare-open">
          <GitCompare className="h-4 w-4" aria-hidden />
          {t('creative.images.compare')}
        </Button>
      </div>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {outputs.map((o) => (
          <li key={o.id} className={cn('group overflow-hidden rounded-xl border bg-card shadow-sm', o.selected && 'ring-2 ring-primary')} data-testid="creative-output" data-selected={o.selected ? 'true' : 'false'}>
            <div className="relative bg-muted" style={{ aspectRatio: String(ratio(o)) }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={o.media.thumbnailUrl ?? o.media.url ?? undefined} alt={o.media.altText ?? t('creative.images.resultAlt', { n: o.index + 1 })} loading="lazy" className="h-full w-full object-cover" />
              <button type="button" onClick={() => setView(o)} aria-label={t('creative.images.open', { n: o.index + 1 })} className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/30 via-transparent p-2 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100">
                <Maximize2 className="h-4 w-4 text-white" aria-hidden />
              </button>
              <label className="absolute start-2 top-2 flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-1 text-xs shadow">
                <input type="checkbox" checked={picked.includes(o.id)} onChange={() => togglePick(o.id)} aria-label={t('creative.images.pick', { n: o.index + 1 })} />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 p-2">
              <PreservationBadge value={o.preservation} />
              <div className="flex items-center gap-1">
                {can('content.write') && (
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => favourite(o)} aria-pressed={o.selected} aria-label={t('creative.images.favorite')}>
                    <Star className={cn('h-4 w-4', o.selected && 'fill-primary text-primary')} aria-hidden />
                  </Button>
                )}
                <Button size="icon" variant="ghost" className="h-8 w-8" asChild>
                  <a href={downloadUrl(o.media.url)} aria-label={t('creative.images.download')}>
                    <Download className="h-4 w-4" aria-hidden />
                  </a>
                </Button>
              </div>
            </div>
            {o.upscaled && <p className="px-2 pb-2 text-[11px] text-muted-foreground">{t('creative.images.upscaled')}</p>}
          </li>
        ))}
      </ul>

      <Dialog open={Boolean(view)} onClose={() => setView(null)} title={view ? t('creative.images.resultAlt', { n: view.index + 1 }) : ''} className="max-w-4xl" closeLabel={t('common.close')}>
        {view && (
          <div className="grid gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={view.media.url ?? undefined} alt={view.media.altText ?? ''} className="mx-auto max-h-[70vh] w-auto rounded-lg object-contain" />
            <div className="flex flex-wrap items-center gap-2">
              <PreservationBadge value={view.preservation} />
              <span className="text-xs text-muted-foreground">{view.width} × {view.height}</span>
              <Button size="sm" className="ms-auto" asChild>
                <a href={downloadUrl(view.media.url)}><Download className="h-4 w-4" aria-hidden />{t('creative.images.download')}</a>
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={comparing} onClose={() => setComparing(false)} title={t('creative.images.compare')} className="max-w-5xl" closeLabel={t('common.close')}>
        <div className="grid gap-4 sm:grid-cols-2" data-testid="compare-view">
          {compared.length < 2 && original && (
            <figure className="grid gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={original.url} alt={t('creative.images.original')} className="w-full rounded-lg border object-contain" />
              <figcaption className="text-center text-sm font-medium">{t('creative.images.original')}</figcaption>
            </figure>
          )}
          {compared.map((o) => (
            <figure key={o.id} className="grid gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={o.media.url ?? undefined} alt={t('creative.images.resultAlt', { n: o.index + 1 })} className="w-full rounded-lg border object-contain" />
              <figcaption className="flex items-center justify-center gap-2 text-sm font-medium">
                {t('creative.images.resultAlt', { n: o.index + 1 })}
                <PreservationBadge value={o.preservation} />
              </figcaption>
            </figure>
          ))}
        </div>
        {compared.some((o) => o.preservation === 'GUIDED') && <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-sm">{t('creative.images.guidedWarning')}</p>}
      </Dialog>
    </section>
  );
}

/** Plays a generated video with its poster frame. The signed URL supports range requests, so seeking works. */
export function VideoPlayer({ generation, className }: { generation: CreativeGeneration; className?: string }) {
  const out = generation.outputs[0];
  if (!out) return null;
  return (
    <video
      controls
      preload="metadata"
      playsInline
      poster={out.media.thumbnailUrl ?? undefined}
      src={out.media.url ?? undefined}
      className={cn('w-full rounded-xl bg-black', className)}
      style={{ aspectRatio: out.width && out.height ? String(out.width / out.height) : '9 / 16', maxHeight: '70vh' }}
      data-testid="video-player"
    />
  );
}

export function UsageMeter({ label, used, reserved = 0, limit, format }: { label: string; used: number; reserved?: number; limit: number; format?: (n: number) => string }) {
  const f = format ?? ((n: number) => String(n));
  const pct = Math.min(100, ((used + reserved) / Math.max(1, limit)) * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{f(used)}{reserved > 0 && <span className="text-muted-foreground"> (+{f(reserved)})</span>} / {f(limit)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className={cn('h-full rounded-full', pct > 90 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
