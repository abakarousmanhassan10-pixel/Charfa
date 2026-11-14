'use client';
import { useI18n } from '@/components/i18n-provider';
import { IntelligenceView } from '@/components/intelligence/intelligence-view';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('intelligence.title')} description={t('intelligence.subtitle')} />
      <IntelligenceView />
    </>
  );
}
