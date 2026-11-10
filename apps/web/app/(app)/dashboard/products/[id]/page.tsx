'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { ProductForm } from '@/components/catalog/product-form';
import type { Category, Product } from '@/components/catalog/types';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

export default function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const router = useRouter();
  const product = useResource<Product>(`/products/${id}`, active?.id);
  const categories = useResource<Category[]>('/product-categories', active?.id);
  const [confirm, setConfirm] = useState(false);
  if (!active) return null;
  const canWrite = can('catalog.write');

  const back = (
    <Button variant="ghost" asChild>
      <Link href="/dashboard/products">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        {t('products.title')}
      </Link>
    </Button>
  );

  if (product.error) {
    return product.error instanceof ApiError && product.error.status === 404 ? (
      <EmptyState title={t('products.notFound')} action={back} />
    ) : (
      <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={product.reload} />
    );
  }
  if (!product.data || (categories.loading && !categories.data)) return <LoadingRows label={t('common.loading')} />;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-2">{back}</div>
      <PageHeader
        title={product.data.name}
        description={canWrite ? t('products.editSubtitle') : t('catalog.readOnly')}
        actions={
          canWrite && (
            <Button variant="outline" onClick={() => setConfirm(true)}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('common.delete')}
            </Button>
          )
        }
      />
      <ProductForm
        key={product.data.id}
        product={product.data}
        businessId={active.id}
        categories={categories.data ?? []}
        currency={active.currency}
        readOnly={!canWrite}
        submitLabel={t('common.save')}
        onSubmit={async (payload, media) => {
          await api<Product>(`/products/${id}`, { method: 'PATCH', json: payload, businessId: active.id });
          const updated = await api<Product>(`/products/${id}/media`, { method: 'PUT', json: { mediaIds: media.map((m) => m.id) }, businessId: active.id });
          product.setData(updated);
        }}
      />
      <ConfirmDialog
        open={confirm}
        title={t('products.deleteTitle')}
        description={t('products.deleteText', { name: product.data.name })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api(`/products/${id}`, { method: 'DELETE', businessId: active.id });
          router.replace('/dashboard/products');
        }}
      />
    </div>
  );
}
