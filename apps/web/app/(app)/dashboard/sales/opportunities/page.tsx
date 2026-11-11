'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { OpportunitiesView } from '@/components/sales/pipeline-views';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.opportunities.title')} description={t('sales.opportunities.subtitle')}>
      <Suspense fallback={null}>
        <OpportunitiesView />
      </Suspense>
    </SalesSection>
  );
}
