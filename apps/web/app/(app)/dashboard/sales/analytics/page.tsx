'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { AnalyticsView } from '@/components/sales/analytics-view';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.analytics.title')} description={t('sales.analytics.subtitle')}>
      <Suspense fallback={null}>
        <AnalyticsView />
      </Suspense>
    </SalesSection>
  );
}
