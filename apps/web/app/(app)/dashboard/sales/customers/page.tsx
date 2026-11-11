'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { CustomersView } from '@/components/sales/customers-view';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.customers.title')} description={t('sales.customers.subtitle')}>
      <Suspense fallback={null}>
        <CustomersView />
      </Suspense>
    </SalesSection>
  );
}
