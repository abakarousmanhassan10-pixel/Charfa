'use client';
import { useEffect, useState } from 'react';
import { Clapperboard, ImageIcon, Trash2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { CreativeSection } from '@/components/creative/creative-section';
import { downloadUrl, PreservationBadge, VideoPlayer } from '@/components/creative/results';
import type { CreativeGeneration } from '@/components/creative/types';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { qs, useResource, type Paged } from '@/lib/use-resource';

export default function CreativeHistoryPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<CreativeGeneration | null>(null);
  const [deleting, setDeleting] = useState<CreativeGeneration | null>(null);
  useEffect(() => setPage(1), [kind, status, active?.id]);
  const list = useResource<Paged<CreativeGeneration>>(`/creative/generations${qs({ kind, status, page, pageSize: 12 })}`, active?.id);
  const variant = (s: string) => (s === 'SUCCEEDED' ? 'success' : s === 'FAILED' ? 'warning' : 'muted');
  const err = (c: string | null) => (c ? (t(`creative.errors.${c}`).startsWith('creative.errors.') ? t(`ai.errors.${c}`) : t(`creative.errors.${c}`)) : '');

  return (
    <CreativeSection title={t('creative.history.title')} description={t('creative.history.subtitle')}>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <Select aria-label={t('creative.history.kind')} value={kind} onChange={(e) => setKind(e.target.value)} className="sm:w-48">
          <option value="">{t('creative.history.allKinds')}</option>
          <option value="IMAGE">{t('creative.history.images')}</option>
          <option value="VIDEO">{t('creative.history.videos')}</option>
        </Select>
        <Select aria-label={t('ai.history.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48">
          <option value="">{t('ai.history.allStatuses')}</option>
          {['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'].map((s) => <option key={s} value={s}>{t(`ai.statuses.${s}`)}</option>)}
        </Select>
      </div>
      {list.loading && !list.data ? (
        <LoadingRows rows={4} label={t('common.loading')} />
      ) : list.error ? (
        <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} />
      ) : !list.data || list.data.items.length === 0 ? (
        <EmptyState title={t('creative.history.empty')} hint={t('creative.history.emptyHint')} />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="creative-history">
            {list.data.items.map((g) => {
              const first = g.outputs[0];
              return (
                <li key={g.id}>
                  <button type="button" onClick={() => setOpen(g)} className="group w-full overflow-hidden rounded-xl border bg-card text-start shadow-sm transition hover:shadow-md" aria-label={t('creative.history.openItem', { kind: t(`creative.history.${g.kind === 'IMAGE' ? 'image' : 'video'}`), date: new Date(g.createdAt).toLocaleDateString(locale) })}>
                    <div className="relative grid aspect-square place-items-center bg-muted">
                      {first?.media.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={first.media.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : g.kind === 'IMAGE' ? (
                        <ImageIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
                      ) : (
                        <Clapperboard className="h-8 w-8 text-muted-foreground" aria-hidden />
                      )}
                      {g.kind === 'IMAGE' && g.outputs.length > 1 && <span className="absolute bottom-2 end-2 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white">×{g.outputs.length}</span>}
                    </div>
                    <div className="flex items-center justify-between gap-2 p-2">
                      <Badge variant={variant(g.status)}>{t(`ai.statuses.${g.status}`)}</Badge>
                      <span className="text-xs text-muted-foreground">{new Date(g.createdAt).toLocaleDateString(locale)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data.total }) }} />
        </>
      )}

      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} title={open ? t(`creative.history.${open.kind === 'IMAGE' ? 'image' : 'video'}`) : ''} className="max-w-3xl" closeLabel={t('common.close')}>
        {open && (
          <div className="grid gap-4" data-testid="creative-detail">
            {open.kind === 'VIDEO' ? (
              <div className="mx-auto w-full max-w-xs"><VideoPlayer generation={open} /></div>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {open.outputs.map((o) => (
                  <li key={o.id} className="grid gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={o.media.thumbnailUrl ?? o.media.url ?? undefined} alt="" className="w-full rounded-lg border object-cover" />
                    <div className="flex items-center justify-between"><PreservationBadge value={o.preservation} /><a href={downloadUrl(o.media.url)} className="text-xs text-primary hover:underline">{t('creative.images.download')}</a></div>
                  </li>
                ))}
              </ul>
            )}
            {open.status === 'FAILED' && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err(open.errorCode)}</p>}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                [t('creative.history.provider'), `${open.provider} · ${open.model}`],
                [t('creative.history.units'), open.usage.unitKind === 'IMAGE' ? t('creative.history.imagesCount', { n: open.usage.producedUnits }) : `${open.usage.producedUnits}s`],
                [t('creative.history.time'), `${(open.usage.processingMs / 1000).toFixed(1)}s`],
                [t('creative.history.cost'), open.usage.costKnown ? `$${open.usage.costUsd.toFixed(3)}` : t('ai.usage.costNotConfigured')],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border p-2"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-0.5 break-words font-medium">{v}</dd></div>
              ))}
            </dl>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">{t('creative.history.prompt')}</summary>
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">{open.prompt}</p>
            </details>
            {can('media.write') && open.status !== 'QUEUED' && open.status !== 'RUNNING' && (
              <div><Button variant="outline" onClick={() => { setDeleting(open); setOpen(null); }}><Trash2 className="h-4 w-4" aria-hidden />{t('creative.history.delete')}</Button></div>
            )}
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        title={t('creative.history.deleteTitle')}
        description={t('creative.history.deleteText')}
        confirmLabel={t('creative.history.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting || !active) return;
          await api(`/creative/generations/${deleting.id}`, { method: 'DELETE', businessId: active.id });
          setDeleting(null);
          await list.reload();
        }}
      />
    </CreativeSection>
  );
}
