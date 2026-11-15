'use client';
import Link from 'next/link';
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
      {allowed && <p className="mb-4 text-sm"><Link href="/dashboard/operations/billing" className="text-primary underline-offset-4 hover:underline" data-testid="ops-billing-link">{t('billing.admin.link')}</Link></p>}
      {allowed ? <OpsView canManage={user?.platformRole === 'SUPER_ADMIN'} /> : <p className="text-sm text-muted-foreground" data-testid="ops-forbidden">{t('ops.forbidden')}</p>}
    </>
  );
}
