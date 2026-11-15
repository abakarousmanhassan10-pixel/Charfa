'use client';
import { useCallback, useEffect, useState } from 'react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { api } from '@/lib/api-client';

export interface DailyQuotaData {
  timezone: string; dayKey: string; resetsAt: string;
  images: { used: number; limit: number; remaining: number }; videos: { used: number; limit: number; remaining: number };
  timezoneChange: { applied: boolean; businessTimezone: string };
}

/** The server decides and enforces the quota; this only shows it (and keeps the buttons honest). Refreshes every few seconds so a finished generation is reflected. */
export function useDailyQuota() {
  const { active } = useBusiness();
  const [data, setData] = useState<DailyQuotaData | null>(null);
  const load = useCallback(() => { if (active) void api<DailyQuotaData>('/creative/quota', { businessId: active.id }).then(setData).catch(() => undefined); }, [active]);
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]);
  return { data, reload: load };
}

function Bar({ label, used, limit, remaining, testid }: { label: string; used: number; limit: number; remaining: number; testid: string }) {
  const { t } = useI18n();
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div data-testid={testid}>
      <div className="flex justify-between text-sm"><span>{label}</span><span data-testid={`${testid}-count`}>{used}/{limit} {t('creative.daily.used')}</span></div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={label}><div className={`h-full ${remaining === 0 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${pct}%` }} /></div>
      <p className="mt-1 text-xs text-muted-foreground">{remaining} {t('creative.daily.remaining')}</p>
    </div>
  );
}

export function DailyQuota({ data }: { data: DailyQuotaData | null }) {
  const { t, locale } = useI18n();
  if (!data) return null;
  const reset = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone: data.timezone }).format(new Date(data.resetsAt));
  const exhausted = data.images.remaining === 0 || data.videos.remaining === 0;
  return (
    <section className="grid gap-3 rounded-lg border p-4" aria-label={t('creative.daily.title')} data-testid="daily-quota">
      <h2 className="text-sm font-semibold">{t('creative.daily.title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Bar label={t('creative.daily.videos')} used={data.videos.used} limit={data.videos.limit} remaining={data.videos.remaining} testid="quota-videos" />
        <Bar label={t('creative.daily.images')} used={data.images.used} limit={data.images.limit} remaining={data.images.remaining} testid="quota-images" />
      </div>
      <p className="text-xs text-muted-foreground" data-testid="quota-reset">{t('creative.daily.resets')}: {reset} ({data.timezone})</p>
      {!data.timezoneChange.applied && <p className="text-xs text-muted-foreground">{t('creative.daily.tzPending')}</p>}
      {exhausted && <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm" role="status" data-testid="quota-exhausted">{t('creative.daily.exhausted')}</p>}
    </section>
  );
}
