'use client';
import { useI18n } from '@/components/i18n-provider';
import { LearningView } from '@/components/learning/learning-view';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('learning.title')} description={t('learning.subtitle')} />
      <LearningView />
    </>
  );
}
