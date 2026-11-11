'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { LeadsView } from '@/components/sales/pipeline-views';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.leads.title')} description={t('sales.leads.subtitle')}>
      <Suspense fallback={null}>
        <LeadsView />
      </Suspense>
    </SalesSection>
  );
}
