'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { PRODUCT_AVAILABILITY } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { ListToolbar } from '@/components/catalog/list-toolbar';
import { Price, StatusBadge } from '@/components/catalog/status-badge';
import type { Product } from '@/components/catalog/types';
import { useCatalogList } from '@/components/catalog/use-catalog-list';
import { useI18n } from '@/components/i18n-provider';
import { MediaThumb } from '@/components/media/media-thumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api } from '@/lib/api-client';

export default function ProductsPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const { filters, setFilters, setPage, list, categories } = useCatalogList<Product>('products', active?.id);
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const canWrite = can('catalog.write');
  const filtered = Boolean(filters.q || filters.categoryId || filters.status || filters.availability);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t('products.title')}
        description={t('products.subtitle')}
        actions={
          canWrite && (
            <Button asChild>
              <Link href="/dashboard/products/new">
                <Plus className="h-4 w-4" aria-hidden />
                {t('products.new')}
              </Link>
            </Button>
          )
        }
      />
      <Card>
        <CardContent className="pt-6">
          <ListToolbar filters={filters} onChange={setFilters} categories={categories} availability={PRODUCT_AVAILABILITY} searchLabel={t('products.search')} />
          {list.error ? (
            <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={list.reload} />
          ) : list.loading && !list.data ? (
            <LoadingRows label={t('common.loading')} />
          ) : list.data && list.data.items.length === 0 ? (
            <EmptyState
              icon={Package}
              title={filtered ? t('catalog.noResults') : t('products.empty')}
              hint={filtered ? t('catalog.noResultsHint') : t('products.emptyHint')}
              action={
                !filtered && canWrite ? (
                  <Button asChild>
                    <Link href="/dashboard/products/new">{t('products.new')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className={`divide-y ${list.loading ? 'opacity-60' : ''}`} data-testid="product-list" aria-busy={list.loading}>
                {list.data?.items.map((p) => (
                  <li key={p.id} className="flex items-center gap-4 py-3">
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted">
                      {p.media[0] ? <MediaThumb media={p.media[0]} className="h-full w-full" /> : <Package className="m-4 h-6 w-6 text-muted-foreground" aria-hidden />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/dashboard/products/${p.id}`} className="truncate font-medium hover:underline">
                          {p.name}
                        </Link>
                        <StatusBadge status={p.status} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {[p.category?.name ?? t('catalog.uncategorised'), p.sku && `SKU ${p.sku}`, t(`catalog.availability.${p.availability}`), p.stockQuantity !== null && t('catalog.inStock', { count: p.stockQuantity })]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div className="hidden text-end text-sm sm:block">
                      <Price price={p.price} discount={p.discountPrice} currency={p.currency} locale={locale} />
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" asChild>
                        <Link href={`/dashboard/products/${p.id}`} aria-label={t('common.editItem', { name: p.name })}>
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
        title={t('products.deleteTitle')}
        description={t('products.deleteText', { name: toDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await api(`/products/${toDelete!.id}`, { method: 'DELETE', businessId: active!.id });
          await list.reload();
        }}
      />
    </div>
  );
}
