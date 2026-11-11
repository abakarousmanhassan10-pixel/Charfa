'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { FaqView } from '@/components/sales/pipeline-views';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.faq.title')} description={t('sales.faq.subtitle')}>
      <Suspense fallback={null}>
        <FaqView />
      </Suspense>
    </SalesSection>
  );
}
