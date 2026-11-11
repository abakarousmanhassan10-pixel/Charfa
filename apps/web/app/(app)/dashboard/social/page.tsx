'use client';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, Plug } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { PLATFORMS, type Platform } from '@/components/calendar/types';
import { AccountStatusBadge, PlatformLabel } from '@/components/social/platform';
import { PublicationList } from '@/components/social/publication-list';
import { SocialSection } from '@/components/social/social-section';
import type { Publication, QueueResponse, SocialAccount } from '@/components/social/types';
import { useAccounts, useSocialStatus } from '@/components/social/use-social';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { useResource, qs, type Paged } from '@/lib/use-resource';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export default function SocialOverviewPage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const status = useSocialStatus();
  const accounts = useAccounts();
  const [platform, setPlatform] = useState<Platform | ''>('');
  const queue = useResource<QueueResponse>('/social/queue', active?.id);
  const recent = useResource<Paged<Publication>>(`/social/publications${qs({ platform, pageSize: 5 })}`, active?.id);
  const items: SocialAccount[] = (accounts.data?.items ?? []).filter((a) => !platform || a.platform === platform);
  const connected = items.filter((a) => a.status === 'CONNECTED').length;
  const attention = items.filter((a) => a.status !== 'CONNECTED' && a.status !== 'DISCONNECTED' || a.tokenState === 'EXPIRING');
  const q = queue.data;
  const failed = recent.data?.items.filter((p) => p.status === 'FAILED').length ?? 0;
  const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));

  return (
    <SocialSection title={t('social.overview.title')} description={t('social.overview.subtitle')}>
      {accounts.loading && !accounts.data ? <LoadingRows rows={4} label={t('common.loading')} /> : accounts.error && !accounts.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void accounts.reload()} /> : (
        <div className="grid gap-6">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('social.overview.filter')} data-testid="platform-filter">
            <Button size="sm" variant={platform === '' ? 'default' : 'outline'} onClick={() => setPlatform('')}>{t('calendar.allPlatforms')}</Button>
            {PLATFORMS.map((p) => <Button key={p} size="sm" variant={platform === p ? 'default' : 'outline'} onClick={() => setPlatform(p)} data-testid={`filter-${p}`}>{t(`calendar.platforms.${p}`)}</Button>)}
          </div>
          {status.data && !status.data.publishing.available && <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground" data-testid="publishing-unavailable">{t('social.publishing.unavailable')}</p>}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="social-stats">
            <Link href="/dashboard/social/accounts" className="rounded-xl border bg-card p-4 shadow-sm transition hover:shadow"><Plug className="h-5 w-5 text-primary" aria-hidden /><p className="mt-2 text-3xl font-bold" data-testid="stat-connected">{connected}</p><p className="text-sm text-muted-foreground">{t('social.overview.connected')}</p></Link>
            <Link href="/dashboard/social/queue" className="rounded-xl border bg-card p-4 shadow-sm transition hover:shadow"><CalendarClock className="h-5 w-5 text-indigo-600" aria-hidden /><p className="mt-2 text-3xl font-bold" data-testid="stat-upcoming">{(q?.upcoming ?? []).filter((u) => !platform || u.platform === platform).length}</p><p className="text-sm text-muted-foreground">{t('social.overview.upcoming')}</p></Link>
            <Link href="/dashboard/social/history?status=PUBLISHED" className="rounded-xl border bg-card p-4 shadow-sm transition hover:shadow"><CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden /><p className="mt-2 text-3xl font-bold" data-testid="stat-published">{q?.byStatus.PUBLISHED ?? 0}</p><p className="text-sm text-muted-foreground">{t('social.overview.published')}</p></Link>
            <Link href="/dashboard/social/history?status=FAILED" className="rounded-xl border bg-card p-4 shadow-sm transition hover:shadow"><AlertTriangle className="h-5 w-5 text-red-600" aria-hidden /><p className="mt-2 text-3xl font-bold" data-testid="stat-failed">{q?.byStatus.FAILED ?? 0}</p><p className="text-sm text-muted-foreground">{t('social.overview.failed')}</p></Link>
          </div>

          {attention.length > 0 && (
            <Card>
              <CardHeader><CardTitle>{t('social.overview.attention')}</CardTitle></CardHeader>
              <CardContent>
                <ul className="grid gap-2" data-testid="attention-list">
                  {attention.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                      <span className="flex flex-wrap items-center gap-2"><PlatformLabel platform={a.platform} /><span className="font-medium">{a.displayName}</span><AccountStatusBadge status={a.status} /></span>
                      <Button size="sm" asChild><Link href="/dashboard/social/accounts">{t('social.accounts.reconnect')}</Link></Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader><CardTitle>{t('social.overview.upcomingTitle')}</CardTitle></CardHeader>
              <CardContent>
                {(q?.upcoming ?? []).filter((u) => !platform || u.platform === platform).length === 0 ? <p className="text-sm text-muted-foreground">{t('social.overview.noUpcoming')}</p> : (
                  <ul className="grid gap-2" data-testid="upcoming-list">
                    {(q?.upcoming ?? []).filter((u) => !platform || u.platform === platform).slice(0, 6).map((u) => (
                      <li key={u.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"><span className="flex min-w-0 items-center gap-2"><PlatformLabel platform={u.platform} /><span className="truncate font-medium">{u.title}</span></span><span className="text-xs text-muted-foreground">{fmt(u.scheduledAt, u.timezone)}</span></li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle className="flex items-center justify-between">{t('social.overview.recent')}<Button size="sm" variant="ghost" asChild><Link href="/dashboard/social/history"><ClipboardList className="h-4 w-4" aria-hidden />{t('social.overview.seeAll')}</Link></Button></CardTitle></CardHeader>
              <CardContent>
                {(recent.data?.items.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('social.history.emptyHint')}</p> : <PublicationList items={recent.data!.items} onChanged={() => { void recent.reload(); void queue.reload(); }} testId="recent-publications" />}
                <p className={cn('mt-2 text-xs text-muted-foreground', failed === 0 && 'hidden')}>{t('social.overview.failedHint')}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </SocialSection>
  );
}
