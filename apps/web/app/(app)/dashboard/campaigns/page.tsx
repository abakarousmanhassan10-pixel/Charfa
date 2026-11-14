'use client';
import { CampaignsView } from '@/components/campaigns/campaigns-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('campaigns.title')} description={t('campaigns.subtitle')} />
      <CampaignsView />
    </>
  );
}
