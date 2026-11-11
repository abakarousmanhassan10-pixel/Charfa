'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { ConversationsView } from '@/components/sales/conversations-view';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.conversations.title')} description={t('sales.conversations.subtitle')}>
      <Suspense fallback={null}>
        <ConversationsView />
      </Suspense>
    </SalesSection>
  );
}
