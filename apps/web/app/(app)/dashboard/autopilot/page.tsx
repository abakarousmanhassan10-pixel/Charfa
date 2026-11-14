'use client';
import { AutopilotView } from '@/components/autopilot/autopilot-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('autopilot.title')} description={t('autopilot.subtitle')} />
      <AutopilotView />
    </>
  );
}
