'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { AgentView } from '@/components/sales/agent-view';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.agent.title')} description={t('sales.agent.subtitle')}>
      <Suspense fallback={null}>
        <AgentView />
      </Suspense>
    </SalesSection>
  );
}
