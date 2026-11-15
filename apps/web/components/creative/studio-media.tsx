'use client';
import { Download } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import type { MediaItem } from '@/components/media/media-types';
import { Badge } from '@/components/ui/badge';

/** One image or video, with a permanent "simulated" mark when it comes from the free test mode, and a download link. */
export function StudioMedia({ media, simulated, ratio, testid = 'studio-media' }: { media: MediaItem; simulated: boolean; ratio?: string | null; testid?: string }) {
  const { t } = useI18n();
  const src = media.url ?? '';
  const [w, h] = (ratio ?? '1:1').split(':').map(Number);
  return (
    <figure className="grid gap-2" data-testid={testid} data-simulated={simulated ? 'true' : 'false'}>
      <div className="relative overflow-hidden rounded-xl border bg-muted" style={{ aspectRatio: `${w || 1} / ${h || 1}` }}>
        {media.type === 'VIDEO'
          ? <video src={src} poster={media.thumbnailUrl ?? undefined} controls playsInline preload="metadata" className="h-full w-full object-cover" />
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={src} alt={media.altText ?? media.originalFilename} className="h-full w-full object-cover" />}
        {simulated && <Badge variant="warning" className="absolute left-2 top-2">{t('creative.studio.simulatedBadge')}</Badge>}
      </div>
      <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{media.originalFilename}</span>
        <a href={src} download={media.originalFilename} className="inline-flex items-center gap-1 text-primary hover:underline" data-testid="studio-download">
          <Download className="h-3.5 w-3.5" aria-hidden />{t('creative.studio.download')}
        </a>
      </figcaption>
    </figure>
  );
}
