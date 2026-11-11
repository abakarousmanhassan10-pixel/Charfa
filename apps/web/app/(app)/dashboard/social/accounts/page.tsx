'use client';
import { Suspense } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { AccountsView } from '@/components/social/accounts-view';
import { SocialSection } from '@/components/social/social-section';

export default function AccountsPage() {
  const { t } = useI18n();
  return (
    <SocialSection title={t('social.accounts.title')} description={t('social.accounts.subtitle')}>
      <Suspense fallback={null}>
        <AccountsView />
      </Suspense>
    </SocialSection>
  );
}
