'use client';
import { AgentsView } from '@/components/agents/agents-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('agents.title')} description={t('agents.subtitle')} />
      <AgentsView />
    </>
  );
}
