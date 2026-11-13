'use client';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';
import { WorkflowsView } from '@/components/workflows/workflows-view';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('workflows.title')} description={t('workflows.subtitle')} />
      <WorkflowsView />
    </>
  );
}
