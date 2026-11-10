'use client';
import { useEffect, useState } from 'react';
import { Building2, LineChart } from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Readiness {
  checks: { database: 'up' | 'down'; redis: 'up' | 'down' };
  integrations: { openai: boolean; storage: boolean };
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const [ready, setReady] = useState<Readiness | null>(null);

  useEffect(() => {
    fetch('/api/v1/health/ready')
      .then((r) => r.json())
      .then((b) => setReady(b.checks ? b : b.message))
      .catch(() => setReady(null));
  }, []);

  if (!user) return null;

  const statusRow = (label: string, ok: boolean | undefined, okText: string, koText: string) => (
    <li className="flex items-center justify-between py-2 text-sm">
      <span>{label}</span>
      {ok === undefined ? (
        <Badge variant="muted">…</Badge>
      ) : (
        <Badge variant={ok ? 'success' : 'warning'}>{ok ? okText : koText}</Badge>
      )}
    </li>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboard.greeting', { name: user.fullName })}</h1>
      <p className="mt-1 text-muted-foreground">{t('dashboard.subtitle')}</p>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.businessesTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            {user.memberships.length === 0 ? (
              <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center">
                <Building2 className="h-8 w-8 text-muted-foreground" aria-hidden />
                <p className="mt-3 font-medium">{t('dashboard.noBusinesses')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.noBusinessesHint')}</p>
              </div>
            ) : (
              <ul className="divide-y">
                {user.memberships.map((m) => (
                  <li key={m.business.id} className="flex items-center justify-between py-3">
                    <span className="font-medium">{m.business.name}</span>
                    <Badge variant="muted">{m.role}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.accountTitle')}</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">{t('dashboard.timezone')}: </span>
              {user.timezone}
            </p>
            <p>
              <span className="text-muted-foreground">{t('dashboard.memberSince')}: </span>
              {new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(user.createdAt))}
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.analyticsTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center">
              <LineChart className="h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="mt-3 max-w-md text-sm text-muted-foreground">{t('dashboard.noAnalytics')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.systemTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y" data-testid="system-status">
              {statusRow(t('dashboard.systemDatabase'), ready ? ready.checks.database === 'up' : undefined, t('dashboard.up'), t('dashboard.down'))}
              {statusRow(t('dashboard.systemRedis'), ready ? ready.checks.redis === 'up' : undefined, t('dashboard.up'), t('dashboard.down'))}
              {statusRow(t('dashboard.systemOpenai'), ready?.integrations.openai, t('common.configured'), t('common.notConfigured'))}
              {statusRow(t('dashboard.systemStorage'), ready?.integrations.storage, t('common.configured'), t('common.notConfigured'))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
