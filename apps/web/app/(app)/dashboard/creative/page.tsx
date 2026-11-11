'use client';
import Link from 'next/link';
import { Clapperboard, ImageIcon, ListVideo, Palette } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { CreativeSection } from '@/components/creative/creative-section';
import { UsageMeter } from '@/components/creative/results';
import { useCreativeStatus } from '@/components/creative/use-creative';
import type { CreativeGeneration } from '@/components/creative/types';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingRows } from '@/components/ui/states';
import { formatBytes, qs, useResource, type Paged } from '@/lib/use-resource';

const QUICK = [
  ['images', '/dashboard/creative/images', ImageIcon],
  ['videos', '/dashboard/creative/videos', Clapperboard],
  ['storyboards', '/dashboard/creative/storyboards', ListVideo],
  ['brandKit', '/dashboard/creative/brand-kit', Palette],
] as const;

export default function CreativeOverviewPage() {
  const { t } = useI18n();
  const { active } = useBusiness();
  const status = useCreativeStatus();
  const recent = useResource<Paged<CreativeGeneration>>(`/creative/generations${qs({ status: 'SUCCEEDED', pageSize: 8 })}`, active?.id);
  const s = status.data;
  const chip = (ok: boolean | undefined, label: string) => (
    <li className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <Badge variant={ok ? 'success' : 'warning'}>{ok ? t('common.configured') : t('common.notConfigured')}</Badge>
    </li>
  );
  return (
    <CreativeSection title={t('creative.overview.title')} description={t('creative.overview.subtitle')}>
      <div className="mb-6 overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-background p-6 sm:p-8">
        <p className="max-w-2xl text-lg font-semibold tracking-tight sm:text-xl">{t('creative.overview.hero')}</p>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t('creative.overview.heroText')}</p>
      </div>

      <ul className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK.map(([key, href, Icon]) => (
          <li key={key}>
            <Link href={href} className="group flex h-full flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary/50 hover:shadow-md">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="h-5 w-5" aria-hidden /></span>
              <span className="font-semibold">{t(`creative.overview.quick.${key}.title`)}</span>
              <span className="text-sm text-muted-foreground">{t(`creative.overview.quick.${key}.text`)}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card data-testid="creative-providers">
          <CardHeader><CardTitle className="text-base">{t('creative.overview.providers')}</CardTitle><CardDescription>{t('creative.overview.providersHint')}</CardDescription></CardHeader>
          <CardContent>
            {!s ? <LoadingRows rows={3} label={t('common.loading')} /> : (
              <ul className="grid gap-3 text-sm">
                {chip(s.image.configured, `${t('creative.overview.image')} (${s.image.provider})`)}
                {chip(s.video.configured, `${t('creative.overview.video')} (${s.video.provider})`)}
                {chip(s.storyboard.configured, t('creative.overview.storyboard'))}
                {chip(s.storage.configured, t('creative.overview.storage'))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card data-testid="creative-usage-card">
          <CardHeader><CardTitle className="text-base">{t('creative.overview.usage')}</CardTitle><CardDescription>{s ? t(s.usage.limitSource === 'plan' ? 'creative.overview.limitPlan' : 'creative.overview.limitDefault') : ''}</CardDescription></CardHeader>
          <CardContent className="grid gap-4">
            {!s ? <LoadingRows rows={3} label={t('common.loading')} /> : (
              <>
                <UsageMeter label={t('creative.overview.imagesUsed')} used={s.usage.images.completed} reserved={s.usage.images.reserved} limit={s.usage.images.limit} />
                <UsageMeter label={t('creative.overview.videoSeconds')} used={s.usage.videoSeconds.completed} reserved={s.usage.videoSeconds.reserved} limit={s.usage.videoSeconds.limit} />
                <UsageMeter label={t('creative.overview.storageUsed')} used={s.storage.usedBytes} limit={s.storage.quotaBytes} format={(b) => formatBytes(b)} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <section aria-label={t('creative.overview.recent')}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('creative.overview.recent')}</h2>
          <Link href="/dashboard/creative/history" className="text-sm text-primary hover:underline">{t('creative.overview.seeAll')}</Link>
        </div>
        {recent.data && recent.data.items.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="creative-recent">
            {recent.data.items.map((g) => (
              <li key={g.id}>
                <Link href="/dashboard/creative/history" className="block overflow-hidden rounded-xl border bg-muted">
                  <div className="grid aspect-square place-items-center">
                    {g.outputs[0]?.media.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={g.outputs[0].media.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <Clapperboard className="h-8 w-8 text-muted-foreground" aria-hidden />
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('creative.overview.noRecent')}</p>
        )}
      </section>
    </CreativeSection>
  );
}
