'use client';
import { useState } from 'react';
import Link from 'next/link';
import { BriefcaseBusiness, Pencil, Plus, Trash2 } from 'lucide-react';
import { SERVICE_AVAILABILITY } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { ListToolbar } from '@/components/catalog/list-toolbar';
import { Price, StatusBadge } from '@/components/catalog/status-badge';
import type { Service } from '@/components/catalog/types';
import { useCatalogList } from '@/components/catalog/use-catalog-list';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api } from '@/lib/api-client';

export default function ServicesPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const { filters, setFilters, setPage, list, categories } = useCatalogList<Service>('services', active?.id);
  const [toDelete, setToDelete] = useState<Service | null>(null);
  const canWrite = can('catalog.write');
  const filtered = Boolean(filters.q || filters.categoryId || filters.status || filters.availability);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t('services.title')}
        description={t('services.subtitle')}
        actions={
          canWrite && (
            <Button asChild>
              <Link href="/dashboard/services/new">
                <Plus className="h-4 w-4" aria-hidden />
                {t('services.new')}
              </Link>
            </Button>
          )
        }
      />
      <Card>
        <CardContent className="pt-6">
          <ListToolbar filters={filters} onChange={setFilters} categories={categories} availability={SERVICE_AVAILABILITY} searchLabel={t('services.search')} />
          {list.error ? (
            <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={list.reload} />
          ) : list.loading && !list.data ? (
            <LoadingRows label={t('common.loading')} />
          ) : list.data && list.data.items.length === 0 ? (
            <EmptyState
              icon={BriefcaseBusiness}
              title={filtered ? t('catalog.noResults') : t('services.empty')}
              hint={filtered ? t('catalog.noResultsHint') : t('services.emptyHint')}
              action={
                !filtered && canWrite ? (
                  <Button asChild>
                    <Link href="/dashboard/services/new">{t('services.new')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className={`divide-y ${list.loading ? 'opacity-60' : ''}`} data-testid="service-list" aria-busy={list.loading}>
                {list.data?.items.map((p) => (
                  <li key={p.id} className="flex items-center gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/dashboard/services/${p.id}`} className="truncate font-medium hover:underline">
                          {p.name}
                        </Link>
                        <StatusBadge status={p.status} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {[p.category?.name ?? t('catalog.uncategorised'), p.durationMinutes && t('catalog.minutes', { count: p.durationMinutes }), t(`catalog.availability.${p.availability}`)]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div className="hidden text-end text-sm sm:block">
                      <Price price={p.price} currency={p.currency} locale={locale} />
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" asChild>
                        <Link href={`/dashboard/services/${p.id}`} aria-label={t('common.editItem', { name: p.name })}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                      {canWrite && (
                        <Button variant="ghost" size="icon" onClick={() => setToDelete(p)} aria-label={t('common.deleteItem', { name: p.name })}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
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
      <ConfirmDialog
        open={Boolean(toDelete)}
        title={t('services.deleteTitle')}
        description={t('services.deleteText', { name: toDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await api(`/services/${toDelete!.id}`, { method: 'DELETE', businessId: active!.id });
          await list.reload();
        }}
      />
    </div>
  );
}
