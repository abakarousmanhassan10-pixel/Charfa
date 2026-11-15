'use client';
import { AgentBuilderView } from '@/components/agent-builder/agent-builder-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('agentBuilder.title')} description={t('agentBuilder.subtitle')} />
      <AgentBuilderView />
    </>
  );
}
