'use client';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { LoadingRows } from '@/components/ui/states';
import { qs, useResource, type Paged } from '@/lib/use-resource';
import { cn } from '@/lib/utils';
import { MediaThumb } from './media-thumb';
import type { MediaItem } from './media-types';
import { MediaUploader } from './media-uploader';

/** Pick existing media from the library or upload new files, without leaving the form. */
export function MediaPicker({
  open,
  onClose,
  businessId,
  type,
  multiple,
  initial = [],
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  businessId: string;
  type?: 'IMAGE';
  multiple: boolean;
  initial?: MediaItem[];
  onSelect: (items: MediaItem[]) => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MediaItem[]>(initial);
  const { data, loading, reload } = useResource<Paged<MediaItem>>(open ? `/media${qs({ type, page, pageSize: 12 })}` : null, businessId);

  const toggle = (m: MediaItem) =>
    setSelected((s) => (s.some((x) => x.id === m.id) ? s.filter((x) => x.id !== m.id) : multiple ? [...s, m] : [m]));

  return (
    <Dialog open={open} onClose={onClose} title={t('media.pickTitle')} className="max-w-3xl" closeLabel={t('common.close')}>
      <MediaUploader
        businessId={businessId}
        accept={type === 'IMAGE' ? 'image' : 'all'}
        multiple={multiple}
        onUploaded={(m) => {
          setSelected((s) => (multiple ? [...s, m] : [m]));
          void reload();
        }}
      />
      <div className="mt-4 max-h-[50vh] overflow-y-auto">
        {loading && !data ? (
          <LoadingRows rows={2} label={t('common.loading')} />
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {data?.items.map((m) => {
              const on = selected.some((x) => x.id === m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m)}
                    aria-pressed={on}
                    aria-label={m.altText ?? m.originalFilename}
                    className={cn('relative block aspect-square w-full overflow-hidden rounded-md border-2', on ? 'border-primary' : 'border-transparent')}
                  >
                    <MediaThumb media={m} className="h-full w-full" />
                    {on && (
                      <span className="absolute end-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-4 w-4" aria-hidden />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {data && (
          <Pagination
            page={data.page}
            pageCount={data.pageCount}
            total={data.total}
            onPage={setPage}
            labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: data.total }) }}
          />
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          onClick={() => {
            onSelect(selected);
            onClose();
          }}
        >
          {t('media.useSelected', { count: selected.length })}
        </Button>
      </div>
    </Dialog>
  );
}
