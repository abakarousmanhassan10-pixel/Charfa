'use client';
import { BillingView } from '@/components/billing/billing-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('billing.title')} description={t('billing.subtitle')} />
      <BillingView />
    </>
  );
}
