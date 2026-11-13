'use client';
import { useI18n } from '@/components/i18n-provider';
import { MarketView } from '@/components/market/market-view';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('market.title')} description={t('market.subtitle')} />
      <MarketView />
    </>
  );
}
