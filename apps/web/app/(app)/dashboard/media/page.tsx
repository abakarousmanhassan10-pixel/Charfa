'use client';
import { useEffect, useState } from 'react';
import { Folder, ImageIcon, Trash2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { MediaThumb } from '@/components/media/media-thumb';
import type { MediaItem } from '@/components/media/media-types';
import { MediaUploader } from '@/components/media/media-uploader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';
import { formatBytes, qs, useDebounced, useResource, type Paged } from '@/lib/use-resource';

type Detail = MediaItem & { usage: { products: Array<{ id: string; name: string }>; businessLogo: boolean } };

export default function MediaPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, type, folder, active?.id]);
  const params = new URLSearchParams(qs({ q: dq, type, page, pageSize: 24 }).slice(1));
  if (folder !== undefined) params.set('folder', folder); // "" = root folder, so it must be kept
  const list = useResource<Paged<MediaItem>>(`/media?${params.toString()}`, active?.id);
  const folders = useResource<Array<{ folder: string; count: number }>>('/media/folders', active?.id);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [meta, setMeta] = useState({ altText: '', folder: '', tags: '' });
  const [metaError, setMetaError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (!active) return null;
  const canWrite = can('media.write');

  async function open(m: MediaItem) {
    const d = await api<Detail>(`/media/${m.id}`, { businessId: active!.id });
    setSelected(d);
    setMeta({ altText: d.altText ?? '', folder: d.folder, tags: d.tags.join(', ') });
    setMetaError(null);
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t('media.title')} description={t('media.subtitle')} />
      {canWrite && (
        <Card className="mb-6">
          <CardContent className="pt-6">
            <MediaUploader
              businessId={active.id}
              folder={folder}
              onUploaded={() => {
                void list.reload();
                void folders.reload();
              }}
            />
          </CardContent>
        </Card>
      )}
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <nav aria-label={t('media.folders')} className="flex gap-2 overflow-x-auto lg:flex-col">
          <Button variant={folder === undefined ? 'secondary' : 'ghost'} className="justify-start" onClick={() => setFolder(undefined)} aria-pressed={folder === undefined}>
            <ImageIcon className="h-4 w-4" aria-hidden />
            {t('media.allMedia')}
          </Button>
          {folders.data?.map((f) => (
            <Button key={f.folder || 'root'} variant={folder === f.folder ? 'secondary' : 'ghost'} className="justify-start" onClick={() => setFolder(f.folder)} aria-pressed={folder === f.folder}>
              <Folder className="h-4 w-4" aria-hidden />
              <span className="truncate">{f.folder || t('media.rootFolder')}</span>
              <span className="ms-auto text-xs text-muted-foreground">{f.count}</span>
            </Button>
          ))}
        </nav>
        <Card>
          <CardContent className="pt-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row">
              <SearchInput value={q} onChange={setQ} label={t('media.search')} />
              <Select aria-label={t('media.type')} value={type} onChange={(e) => setType(e.target.value)} className="sm:w-40">
                <option value="">{t('media.allTypes')}</option>
                <option value="IMAGE">{t('media.images')}</option>
                <option value="VIDEO">{t('media.videos')}</option>
              </Select>
            </div>
            {list.error ? (
              <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={list.reload} />
            ) : list.loading && !list.data ? (
              <LoadingRows rows={3} label={t('common.loading')} />
            ) : list.data?.items.length === 0 ? (
              <EmptyState icon={ImageIcon} title={t('media.empty')} hint={canWrite ? t('media.emptyHint') : undefined} />
            ) : (
              <>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" data-testid="media-grid">
                  {list.data?.items.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => open(m)} className="group block w-full text-start" aria-label={t('media.openItem', { name: m.originalFilename })}>
                        <MediaThumb media={m} className="aspect-square w-full rounded-md border transition group-hover:opacity-90" />
                        <p className="mt-1 truncate text-xs font-medium">{m.originalFilename}</p>
                        <p className="text-xs text-muted-foreground">
                          {m.width && m.height ? `${m.width}×${m.height} · ` : ''}
                          {formatBytes(m.sizeBytes)}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
                {list.data && (
                  <Pagination
                    page={list.data.page}
                    pageCount={list.data.pageCount}
                    total={list.data.total}
                    onPage={setPage}
                    labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data.total }) }}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.originalFilename ?? ''} className="max-w-2xl" closeLabel={t('common.close')}>
        {selected && (
          <div className="grid gap-4">
            {selected.type === 'VIDEO' ? (
              <video src={selected.url ?? undefined} controls className="max-h-[50vh] w-full rounded-md bg-black" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selected.url ?? undefined} alt={selected.altText ?? ''} className="max-h-[50vh] w-full rounded-md object-contain" />
            )}
            <p className="text-xs text-muted-foreground">
              {selected.mimeType} · {formatBytes(selected.sizeBytes)}
              {selected.width ? ` · ${selected.width}×${selected.height}` : ''} · {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(selected.createdAt))}
            </p>
            {(selected.usage.products.length > 0 || selected.usage.businessLogo) && (
              <p className="text-sm">
                {t('media.usedBy')}: {[selected.usage.businessLogo && t('business.logo'), ...selected.usage.products.map((p) => p.name)].filter(Boolean).join(', ')}
              </p>
            )}
            <form
              className="grid gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setMetaError(null);
                try {
                  await api(`/media/${selected.id}`, {
                    method: 'PATCH',
                    businessId: active.id,
                    json: { altText: meta.altText, folder: meta.folder, tags: meta.tags.split(',').map((s) => s.trim()).filter(Boolean) },
                  });
                  setSelected(null);
                  await Promise.all([list.reload(), folders.reload()]);
                } catch (err) {
                  setMetaError(err instanceof ApiError ? err.message : t('auth.errors.UNKNOWN'));
                }
              }}
            >
              <Field id="media-alt" label={t('media.altText')} hint={t('media.altHint')}>
                <Input id="media-alt" value={meta.altText} onChange={(e) => setMeta({ ...meta, altText: e.target.value })} maxLength={300} disabled={!canWrite} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="media-folder" label={t('media.folder')} hint={t('media.folderHint')}>
                  <Input id="media-folder" value={meta.folder} onChange={(e) => setMeta({ ...meta, folder: e.target.value })} maxLength={124} disabled={!canWrite} />
                </Field>
                <Field id="media-tags" label={t('media.tags')} hint={t('media.tagsHint')}>
                  <Input id="media-tags" value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} disabled={!canWrite} />
                </Field>
              </div>
              {metaError && <p role="alert" className="text-sm text-destructive">{metaError}</p>}
              {canWrite && (
                <div className="flex flex-wrap justify-between gap-2">
                  <Button type="button" variant="outline" onClick={() => setConfirm(true)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {t('common.delete')}
                  </Button>
                  <Button type="submit">{t('common.save')}</Button>
                </div>
              )}
            </form>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title={t('media.deleteTitle')}
        description={t('media.deleteText')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api(`/media/${selected!.id}`, { method: 'DELETE', businessId: active.id });
          setSelected(null);
          await Promise.all([list.reload(), folders.reload()]);
        }}
      />
    </div>
  );
}
