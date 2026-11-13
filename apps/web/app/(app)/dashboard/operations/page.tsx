'use client';
import { useAuth } from '@/components/auth-provider';
import { useI18n } from '@/components/i18n-provider';
import { OpsView } from '@/components/ops/ops-view';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  const { user } = useAuth();
  const allowed = user?.platformRole === 'SUPER_ADMIN' || user?.platformRole === 'SUPPORT';
  return (
    <>
      <PageHeader title={t('ops.title')} description={t('ops.subtitle')} />
      {allowed ? <OpsView canManage={user?.platformRole === 'SUPER_ADMIN'} /> : <p className="text-sm text-muted-foreground" data-testid="ops-forbidden">{t('ops.forbidden')}</p>}
    </>
  );
}
