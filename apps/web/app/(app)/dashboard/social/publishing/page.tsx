'use client';
import { useI18n } from '@/components/i18n-provider';
import { PublishingView } from '@/components/social/publishing-view';
import { SocialSection } from '@/components/social/social-section';

export default function PublishingPage() {
  const { t } = useI18n();
  return (
    <SocialSection title={t('social.publishing.title')} description={t('social.publishing.subtitle')}>
      <PublishingView />
    </SocialSection>
  );
}
