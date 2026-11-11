'use client';
import { useI18n } from '@/components/i18n-provider';
import { MonitoringView } from '@/components/sales/monitoring-view';
import { SalesSection } from '@/components/sales/sales-section';

export default function Page() {
  const { t } = useI18n();
  return (
    <SalesSection title={t('sales.monitoring.title')} description={t('sales.monitoring.subtitle')}>
      <MonitoringView />
    </SalesSection>
  );
}
