'use client';
import { useAuth } from '@/components/auth-provider';
import { BillingAdminView } from '@/components/billing/billing-admin-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  const { user } = useAuth();
  const allowed = user?.platformRole === 'SUPER_ADMIN' || user?.platformRole === 'SUPPORT';
  return (
    <>
      <PageHeader title={t('billing.admin.title')} description={t('billing.admin.subtitle')} />
      {allowed ? <BillingAdminView /> : <p className="text-sm text-muted-foreground" data-testid="billing-admin-forbidden">{t('ops.forbidden')}</p>}
    </>
  );
}
