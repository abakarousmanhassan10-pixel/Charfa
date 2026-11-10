'use client';
import { useRouter } from 'next/navigation';
import { useBusiness } from '@/components/business-provider';
import { ProductForm } from '@/components/catalog/product-form';
import type { Category, Product } from '@/components/catalog/types';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingRows } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

export default function NewProductPage() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const router = useRouter();
  const categories = useResource<Category[]>('/product-categories', active?.id);
  if (!active) return null;
  if (!can('catalog.write')) return <EmptyState title={t('common.noPermission')} />;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t('products.new')} description={active.name} />
      {categories.loading && !categories.data ? (
        <LoadingRows label={t('common.loading')} />
      ) : (
        <ProductForm
          businessId={active.id}
          categories={categories.data ?? []}
          currency={active.currency}
          submitLabel={t('products.create')}
          onSubmit={async (payload, media) => {
            const created = await api<Product>('/products', { method: 'POST', json: payload, businessId: active.id });
            if (media.length) {
              await api(`/products/${created.id}/media`, { method: 'PUT', json: { mediaIds: media.map((m) => m.id) }, businessId: active.id });
            }
            router.replace(`/dashboard/products/${created.id}`);
          }}
        />
      )}
    </div>
  );
}
