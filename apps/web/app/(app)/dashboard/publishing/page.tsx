'use client';
import { useI18n } from '@/components/i18n-provider';
import { PublishingView } from '@/components/publishing/publishing-view';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('publishing.title')} description={t('publishing.subtitle')} />
      <PublishingView />
    </>
  );
}
