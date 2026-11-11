import { Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from './media-types';

/** Signed URLs are same-origin API paths; nothing is loaded from the storage provider directly. */
export function MediaThumb({ media, className }: { media: MediaItem; className?: string }) {
  if (!media.url) return <div className={cn('bg-muted', className)} />;
  if (media.type === 'VIDEO') {
    return (
      <div className={cn('relative overflow-hidden bg-black', className)}>
        <video src={`${media.url}#t=0.1`} preload="metadata" muted playsInline className="h-full w-full object-cover" aria-label={media.altText ?? media.originalFilename} />
        <Film aria-hidden className="absolute bottom-2 start-2 h-4 w-4 text-white drop-shadow" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={media.thumbnailUrl ?? media.url} alt={media.altText ?? ''} loading="lazy" className={cn('object-cover', className)} />;
}
