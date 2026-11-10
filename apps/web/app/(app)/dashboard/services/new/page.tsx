'use client';
import { useRouter } from 'next/navigation';
import { useBusiness } from '@/components/business-provider';
import { ServiceForm } from '@/components/catalog/service-form';
import type { Category, Service } from '@/components/catalog/types';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingRows } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

export default function NewServicePage() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const router = useRouter();
  const categories = useResource<Category[]>('/service-categories', active?.id);
  if (!active) return null;
  if (!can('catalog.write')) return <EmptyState title={t('common.noPermission')} />;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={t('services.new')} description={active.name} />
      {categories.loading && !categories.data ? (
        <LoadingRows label={t('common.loading')} />
      ) : (
        <ServiceForm
          categories={categories.data ?? []}
          currency={active.currency}
          submitLabel={t('services.create')}
          onSubmit={async (payload) => {
            const created = await api<Service>('/services', { method: 'POST', json: payload, businessId: active.id });
            router.replace(`/dashboard/services/${created.id}`);
          }}
        />
      )}
    </div>
  );
}
