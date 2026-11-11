'use client';
import Link from 'next/link';
import { AlertTriangle, CalendarCheck, CalendarClock, ClipboardCheck, Sparkles } from 'lucide-react';
import { CONTENT_PILLARS } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { CalendarSection } from '@/components/calendar/calendar-section';
import { PlatformDot, StatusBadge, Legend } from '@/components/calendar/status';
import { useOverview } from '@/components/calendar/use-calendar';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import type { EntryStatus } from '@touma/shared';

const STATUSES: EntryStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED'];

export default function CalendarOverviewPage() {
  const { t, locale } = useI18n();
  const { can } = useBusiness();
  const o = useOverview();
  const d = o.data;
  const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
  const pillarTotal = d ? Object.values(d.counts.byPillar).reduce((a, b) => a + b, 0) : 0;
  return (
    <CalendarSection
      title={t('calendar.overview.title')}
      description={t('calendar.overview.subtitle')}
      actions={can('ai.use') ? <Button asChild><Link href="/dashboard/calendar/planner"><Sparkles className="h-4 w-4" aria-hidden />{t('calendar.overview.plan')}</Link></Button> : undefined}
    >
      {o.loading && !d ? <LoadingRows rows={4} label={t('common.loading')} /> : !d ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void o.reload()} /> : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="calendar-stats">
            <Link href="/dashboard/calendar/approvals" className="rounded-xl border bg-card p-4 shadow-sm transition hover:shadow">
              <ClipboardCheck className="h-5 w-5 text-amber-600" aria-hidden />
              <p className="mt-2 text-3xl font-bold" data-testid="stat-pending">{d.pendingApprovals}</p>
              <p className="text-sm text-muted-foreground">{t('calendar.overview.pending')}</p>
            </Link>
            <div className="rounded-xl border bg-card p-4 shadow-sm"><CalendarCheck className="h-5 w-5 text-indigo-600" aria-hidden /><p className="mt-2 text-3xl font-bold" data-testid="stat-scheduled">{d.counts.byStatus.SCHEDULED ?? 0}</p><p className="text-sm text-muted-foreground">{t('calendar.overview.scheduled')}</p></div>
            <div className="rounded-xl border bg-card p-4 shadow-sm"><CalendarClock className="h-5 w-5 text-primary" aria-hidden /><p className="mt-2 text-3xl font-bold">{d.counts.total}</p><p className="text-sm text-muted-foreground">{t('calendar.overview.next30')}</p></div>
            <div className="rounded-xl border bg-card p-4 shadow-sm"><AlertTriangle className="h-5 w-5 text-red-600" aria-hidden /><p className="mt-2 text-3xl font-bold" data-testid="stat-problems">{d.failed + d.conflicts}</p><p className="text-sm text-muted-foreground">{t('calendar.overview.problems', { failed: d.failed, conflicts: d.conflicts })}</p></div>
          </div>

          {!d.publishing.available && (
            <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground" data-testid="publishing-unavailable">{t('calendar.publishingNote')}</p>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader><CardTitle>{t('calendar.overview.upcoming')}</CardTitle></CardHeader>
              <CardContent>
                {d.upcoming.length === 0 ? <p className="text-sm text-muted-foreground">{t('calendar.overview.noUpcoming')}</p> : (
                  <ul className="grid gap-2" data-testid="upcoming-list">
                    {d.upcoming.map((e) => (
                      <li key={e.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                        <span className="flex min-w-0 max-w-full items-center gap-2"><PlatformDot platform={e.platform} /><span className="truncate font-medium">{e.title}</span></span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">{fmt(e.scheduledAt, d.timezone)}<StatusBadge status={e.status} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle>{t('calendar.overview.balance')}</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                {pillarTotal === 0 ? <p className="text-sm text-muted-foreground">{t('calendar.overview.noBalance')}</p> : (
                  <ul className="grid gap-2" data-testid="pillar-balance">
                    {CONTENT_PILLARS.filter((p) => d.counts.byPillar[p]).map((p) => (
                      <li key={p} className="grid gap-1 text-sm">
                        <span className="flex justify-between"><span>{t(`calendar.pillars.${p}`)}</span><span className="text-muted-foreground">{d.counts.byPillar[p]}</span></span>
                        <span className="h-2 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-primary/70" style={{ width: `${(d.counts.byPillar[p]! / pillarTotal) * 100}%` }} /></span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2" data-testid="status-counts">
                  {STATUSES.filter((s) => d.counts.byStatus[s]).map((s) => <span key={s} className="inline-flex items-center gap-1.5 text-xs"><StatusBadge status={s} /> {d.counts.byStatus[s]}</span>)}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>{t('calendar.overview.settings')}</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>{t('calendar.overview.timezone')}: <span className="font-medium" data-testid="calendar-timezone">{d.timezone}</span></p>
              <p className="flex flex-wrap items-center gap-2">{t('calendar.overview.connected')}: {d.connectedPlatforms.length ? d.connectedPlatforms.map((p) => <Badge key={p} variant="success">{t(`calendar.platforms.${p}`)}</Badge>) : <span className="text-muted-foreground">{t('calendar.overview.noneConnected')}</span>}</p>
              <Legend />
            </CardContent>
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline"><Link href="/dashboard/calendar/month">{t('calendar.tabs.month')}</Link></Button>
            <Button asChild variant="outline"><Link href="/dashboard/calendar/week">{t('calendar.tabs.week')}</Link></Button>
            <Button asChild variant="outline"><Link href="/dashboard/calendar/day">{t('calendar.tabs.day')}</Link></Button>
          </div>
        </div>
      )}
    </CalendarSection>
  );
}
