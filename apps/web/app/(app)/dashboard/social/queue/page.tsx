'use client';
import { useEffect } from 'react';
import { useBusiness } from '@/components/business-provider';
import { PlatformLabel } from '@/components/social/platform';
import { PublicationList } from '@/components/social/publication-list';
import { SocialSection } from '@/components/social/social-section';
import type { QueueResponse } from '@/components/social/types';
import { useSocialStatus } from '@/components/social/use-social';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { useResource } from '@/lib/use-resource';

export default function QueuePage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const q = useResource<QueueResponse>('/social/queue', active?.id);
  const status = useSocialStatus();
  useEffect(() => {
    const timer = setInterval(() => void q.reload(), 10_000);
    return () => clearInterval(timer);
  }, [q]);
  const d = q.data;
  const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
  const counters: Array<[string, number | undefined]> = [['waiting', d?.queue?.waiting], ['active', d?.queue?.active], ['delayed', d?.queue?.delayed], ['failed', d?.queue?.failed]];
  return (
    <SocialSection title={t('social.queue.title')} description={t('social.queue.subtitle')}>
      {q.loading && !d ? <LoadingRows rows={4} label={t('common.loading')} /> : !d ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void q.reload()} /> : (
        <div className="grid gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="queue-counters">
            {counters.map(([k, v]) => <div key={k} className="rounded-xl border bg-card p-4" data-counter={k}><p className="text-2xl font-bold">{v ?? '—'}</p><p className="text-xs text-muted-foreground">{t(`social.queue.counters.${k}`)}</p></div>)}
          </div>
          {!status.data?.publishing.available && status.data && <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">{t('social.publishing.unavailable')}</p>}
          <Card>
            <CardHeader><CardTitle>{t('social.queue.inFlight')}</CardTitle></CardHeader>
            <CardContent>{d.items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="queue-empty">{t('social.queue.empty')}</p> : <PublicationList items={d.items} onChanged={() => void q.reload()} testId="queue-items" />}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t('social.queue.scheduled')}</CardTitle></CardHeader>
            <CardContent>
              {d.upcoming.length === 0 ? <p className="text-sm text-muted-foreground">{t('social.overview.noUpcoming')}</p> : (
                <ul className="grid gap-2" data-testid="scheduled-list">
                  {d.upcoming.map((u) => <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"><span className="flex min-w-0 items-center gap-2"><PlatformLabel platform={u.platform} /><span className="truncate font-medium">{u.title}</span></span><span className="text-xs text-muted-foreground">{fmt(u.scheduledAt, u.timezone)}</span></li>)}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </SocialSection>
  );
}
