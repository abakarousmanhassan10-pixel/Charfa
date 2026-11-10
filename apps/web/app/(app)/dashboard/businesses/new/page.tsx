'use client';
import { useRouter } from 'next/navigation';
import { BusinessForm, initialValues } from '@/components/business-form';
import { useBusiness, type Business } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api-client';

export default function NewBusinessPage() {
  const { t, locale } = useI18n();
  const { upsert, setActive } = useBusiness();
  const router = useRouter();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t('businesses.new')} description={t('onboarding.subtitle')} />
      <Card>
        <CardContent className="pt-6">
          <BusinessForm
            initial={initialValues(null, locale)}
            submitLabel={t('businesses.create')}
            onSubmit={async (values) => {
              const created = await api<Business>('/businesses', { method: 'POST', json: values });
              upsert(created);
              setActive(created.id);
              router.replace(`/dashboard/businesses/${created.id}`);
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
