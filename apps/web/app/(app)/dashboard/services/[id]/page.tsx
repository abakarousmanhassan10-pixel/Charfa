'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { ServiceForm } from '@/components/catalog/service-form';
import type { Category, Service } from '@/components/catalog/types';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';

export default function EditServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const router = useRouter();
  const service = useResource<Service>(`/services/${id}`, active?.id);
  const categories = useResource<Category[]>('/service-categories', active?.id);
  const [confirm, setConfirm] = useState(false);
  if (!active) return null;
  const canWrite = can('catalog.write');

  const back = (
    <Button variant="ghost" asChild>
      <Link href="/dashboard/services">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        {t('services.title')}
      </Link>
    </Button>
  );

  if (service.error) {
    return service.error instanceof ApiError && service.error.status === 404 ? (
      <EmptyState title={t('services.notFound')} action={back} />
    ) : (
      <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={service.reload} />
    );
  }
  if (!service.data || (categories.loading && !categories.data)) return <LoadingRows label={t('common.loading')} />;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-2">{back}</div>
      <PageHeader
        title={service.data.name}
        description={canWrite ? t('services.editSubtitle') : t('catalog.readOnly')}
        actions={
          canWrite && (
            <Button variant="outline" onClick={() => setConfirm(true)}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('common.delete')}
            </Button>
          )
        }
      />
      <ServiceForm
        key={service.data.id}
        service={service.data}
        categories={categories.data ?? []}
        currency={active.currency}
        readOnly={!canWrite}
        submitLabel={t('common.save')}
        onSubmit={async (payload) => {
          service.setData(await api<Service>(`/services/${id}`, { method: 'PATCH', json: payload, businessId: active.id }));
        }}
      />
      <ConfirmDialog
        open={confirm}
        title={t('services.deleteTitle')}
        description={t('services.deleteText', { name: service.data.name })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api(`/services/${id}`, { method: 'DELETE', businessId: active.id });
          router.replace('/dashboard/services');
        }}
      />
    </div>
  );
}
