'use client';
import { useAuth } from '@/components/auth-provider';
import { AgentsAdminView } from '@/components/agents/agents-admin-view';
import { useI18n } from '@/components/i18n-provider';
import { PageHeader } from '@/components/ui/page-header';

export default function Page() {
  const { t } = useI18n();
  const { user } = useAuth();
  const allowed = user?.platformRole === 'SUPER_ADMIN' || user?.platformRole === 'SUPPORT';
  return (
    <>
      <PageHeader title={t('agents.admin.title')} description={t('agents.admin.subtitle')} />
      {allowed ? <AgentsAdminView canStop={user?.platformRole === 'SUPER_ADMIN'} /> : <p className="text-sm text-muted-foreground">{t('ops.forbidden')}</p>}
    </>
  );
}
