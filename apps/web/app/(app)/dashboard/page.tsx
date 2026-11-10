'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, FileText, Pencil, Plus, Settings, UserRound } from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';

interface DashboardSummary {
  socialAccounts: Array<{ id: string; platform: string; status: string; displayName: string | null; username: string | null }>;
  content: { total: number; byStatus: Record<string, number> };
  upcomingPublications: Array<{
    id: string;
    platform: string;
    status: string;
    scheduledAt: string;
    timezone: string;
    content: { id: string; title: string | null; type: string };
  }>;
  members: number;
}

const PLATFORMS = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE'] as const;
const PLATFORM_LABEL: Record<string, string> = { INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' };
const STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED'] as const;

function EmptyState({ icon: Icon, text }: { icon: typeof FileText; text: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-8 text-center">
      <Icon className="h-7 w-7 text-muted-foreground" aria-hidden />
      <p className="mt-3 max-w-sm text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { active, can } = useBusiness();
  const { t, locale } = useI18n();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!active) return;
    setError(false);
    setSummary(null);
    try {
      setSummary(await api<DashboardSummary>(`/businesses/${active.id}/dashboard`));
    } catch {
      setError(true);
    }
  }, [active]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user || !active) return null;
  const firstName = user.fullName.split(' ')[0] ?? user.fullName;
  const notSet = <span className="text-muted-foreground">{t('dashboard.notSet')}</span>;
  const info: Array<[string, React.ReactNode]> = [
    [t('business.fields.type'), t(`business.types.${active.type}`)],
    [t('business.fields.industry'), active.industry ?? notSet],
    [t('business.fields.country'), active.country ?? notSet],
    [t('business.fields.timezone'), active.timezone],
    [t('business.fields.currency'), active.currency],
    [t('business.fields.defaultLocale'), active.defaultLocale.toUpperCase()],
    [t('dashboard.yourRole'), <Badge key="role" variant="muted">{t(`business.roles.${active.role}`)}</Badge>],
  ];
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: active.timezone });

  return (
    <div className="mx-auto max-w-6xl">
      {/* Welcome */}
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboard.welcome', { name: firstName })}</h1>
          <p className="mt-1 text-muted-foreground">{t('dashboard.welcomeHint', { business: active.name })}</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/onboarding">
            <Plus className="h-4 w-4" aria-hidden />
            {t('onboarding.addAnother')}
          </Link>
        </Button>
      </section>

      {error && (
        <div role="alert" className="mt-6 flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          {t('common.loadError')}
          <Button size="sm" variant="outline" onClick={load}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        {/* Business information */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle>{t('dashboard.businessInfo')}</CardTitle>
              <CardDescription className="mt-1.5">{active.name}</CardDescription>
            </div>
            {can('business.update') && (
              <Button variant="ghost" size="sm" asChild>
                <Link href="/settings/business">
                  <Pencil className="h-4 w-4" aria-hidden />
                  {t('dashboard.editBusiness')}
                </Link>
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {active.description && <p className="mb-4 text-sm text-muted-foreground">{active.description}</p>}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="business-info">
              {info.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 border-b pb-2 sm:block sm:border-0 sm:pb-0">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-medium sm:mt-0.5">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        {/* Connected accounts summary */}
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.connectedAccounts')}</CardTitle>
            <CardDescription>
              {summary ? t('dashboard.connectedCount', { count: summary.socialAccounts.filter((a) => a.status === 'CONNECTED').length }) : t('common.loading')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y" data-testid="connected-accounts">
              {PLATFORMS.map((p) => {
                const accounts = summary?.socialAccounts.filter((a) => a.platform === p) ?? [];
                return (
                  <li key={p} className="flex items-center justify-between py-2 text-sm">
                    <span>{PLATFORM_LABEL[p]}</span>
                    {accounts.length === 0 ? (
                      <Badge variant="muted">{t('dashboard.notConnected')}</Badge>
                    ) : (
                      <Badge variant={accounts.every((a) => a.status === 'CONNECTED') ? 'success' : 'warning'}>
                        {accounts.map((a) => a.username ?? a.displayName ?? a.status).join(', ')}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
            {summary && summary.socialAccounts.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">{t('dashboard.connectionsLater')}</p>
            )}
          </CardContent>
        </Card>

        {/* Content overview */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.contentOverview')}</CardTitle>
          </CardHeader>
          <CardContent data-testid="content-overview">
            {summary && summary.content.total === 0 ? (
              <EmptyState icon={FileText} text={t('dashboard.noContent')} />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {STATUSES.map((s) => (
                  <div key={s} className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">{t(`dashboard.status.${s}`)}</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">{summary ? (summary.content.byStatus[s] ?? 0) : '–'}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* User settings */}
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.userSettings')}</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Button variant="outline" className="justify-start" asChild>
              <Link href="/settings/profile">
                <UserRound className="h-4 w-4" aria-hidden />
                {t('dashboard.manageProfile')}
              </Link>
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <Link href="/settings/business">
                <Settings className="h-4 w-4" aria-hidden />
                {t('dashboard.businessSettings')}
              </Link>
            </Button>
            {summary && (
              <p className="pt-2 text-xs text-muted-foreground">
                {t('dashboard.members')}: {summary.members}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Upcoming publications */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>{t('dashboard.upcoming')}</CardTitle>
          </CardHeader>
          <CardContent data-testid="upcoming-publications">
            {summary && summary.upcomingPublications.length === 0 ? (
              <EmptyState icon={CalendarClock} text={t('dashboard.noUpcoming')} />
            ) : (
              <ul className="divide-y">
                {summary?.upcomingPublications.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <span className="font-medium">{p.content.title ?? p.content.type}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Badge variant="muted">{PLATFORM_LABEL[p.platform] ?? p.platform}</Badge>
                      <time dateTime={p.scheduledAt}>{fmt.format(new Date(p.scheduledAt))}</time>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
