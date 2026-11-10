'use client';
import { useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, X } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { MediaPicker } from '@/components/media/media-picker';
import { MediaThumb } from '@/components/media/media-thumb';
import type { MediaItem } from '@/components/media/media-types';
import { Button } from '@/components/ui/button';

/** Ordered product images/videos: pick or upload, reorder, remove. The first item is the cover. */
export function MediaGalleryField({ businessId, value, onChange, disabled }: { businessId: string; value: MediaItem[]; onChange: (v: MediaItem[]) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5" data-testid="product-media">
        {value.map((m, i) => (
          <li key={m.id} className="group relative">
            <MediaThumb media={m} className="aspect-square w-full rounded-md border" />
            {i === 0 && <span className="absolute start-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">{t('catalog.cover')}</span>}
            {!disabled && (
              <div className="mt-1 flex justify-between">
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('catalog.moveEarlier')}>
                  <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => onChange(value.filter((x) => x.id !== m.id))} aria-label={t('catalog.removeMedia', { name: m.originalFilename })}>
                  <X className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => move(i, 1)} disabled={i === value.length - 1} aria-label={t('catalog.moveLater')}>
                  <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                </Button>
              </div>
            )}
          </li>
        ))}
        {!disabled && value.length < 20 && (
          <li>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="grid aspect-square w-full place-items-center rounded-md border-2 border-dashed text-muted-foreground hover:bg-accent"
            >
              <span className="flex flex-col items-center gap-1 text-xs">
                <ImagePlus className="h-5 w-5" aria-hidden />
                {t('catalog.addMedia')}
              </span>
            </button>
          </li>
        )}
      </ul>
      {open && (
        <MediaPicker
          open
          onClose={() => setOpen(false)}
          businessId={businessId}
          multiple
          initial={value}
          onSelect={(items) => onChange(items.slice(0, 20))}
        />
      )}
    </div>
  );
}
