'use client';
import Link from 'next/link';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AiStatus } from '@/components/ai/types';
import { useResource } from '@/lib/use-resource';

/** Customer overview strip: the AI agents' mode and monthly consumption, and the billing state. Each card hides itself when its module is off or not readable by this role. */
export function DashboardAccountCards() {
  const { t } = useI18n();
  const { active, can } = useBusiness();
  const ai = useResource<AiStatus>(can('content.read') ? '/ai/status' : null, active?.id);
  const billing = useResource<{ entitlement: { state: string; hasAccess: boolean } }>(can('billing.read') ? '/billing/status' : null, active?.id);
  const a = ai.data;
  const b = billing.data;
  if (!a && !b) return null;
  return (
    <div className="mt-8 grid gap-4 sm:grid-cols-2" data-testid="account-cards">
      {a && (
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.account.aiTitle')}</CardTitle>
            <CardDescription data-testid="account-ai-mode">{t(`dashboard.account.mode.${a.mode ?? (a.configured ? 'real' : 'disabled')}`)}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <p data-testid="account-ai-usage">{t('dashboard.account.aiUsage', { used: a.usage.generations, limit: a.usage.generationLimit })}</p>
            <Link href="/dashboard/ai" className="mt-2 inline-block text-primary underline-offset-4 hover:underline">{t('dashboard.account.aiLink')}</Link>
          </CardContent>
        </Card>
      )}
      {b && (
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.account.billingTitle')}</CardTitle>
            <CardDescription data-testid="account-billing-state">{t(`billing.states.${b.entitlement.state}`)}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <Link href="/dashboard/billing" className="inline-block text-primary underline-offset-4 hover:underline">{t('dashboard.account.billingLink')}</Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
