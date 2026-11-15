'use client';
import { useI18n } from '@/components/i18n-provider';
import { MarketplaceView } from '@/components/marketplace/marketplace-view';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('marketplace.title')} description={t('marketplace.subtitle')} />
      <MarketplaceView />
    </>
  );
}
