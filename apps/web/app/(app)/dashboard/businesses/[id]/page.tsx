'use client';
import { use, useEffect } from 'react';
import Link from 'next/link';
import { BusinessSettings } from '@/components/business/business-settings';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { EmptyState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';

/** The page edits the business named in the URL; it becomes the active tenant (membership checked by the API). */
export default function BusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const { businesses, active, setActive } = useBusiness();
  const exists = businesses.some((b) => b.id === id);

  useEffect(() => {
    if (exists && active?.id !== id) setActive(id);
  }, [exists, active?.id, id, setActive]);

  if (!exists) {
    return (
      <EmptyState
        title={t('businesses.notFound')}
        action={
          <Button asChild variant="outline">
            <Link href="/dashboard/businesses">{t('businesses.title')}</Link>
          </Button>
        }
      />
    );
  }
  if (active?.id !== id) return null;
  return <BusinessSettings />;
}
