'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PUBLICATION_STATUSES } from '@touma/shared';
import { useBusiness } from '@/components/business-provider';
import { PLATFORMS } from '@/components/calendar/types';
import { useI18n } from '@/components/i18n-provider';
import { PublicationList } from '@/components/social/publication-list';
import { SocialSection } from '@/components/social/social-section';
import type { Publication } from '@/components/social/types';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { qs, useResource, type Paged } from '@/lib/use-resource';

function History() {
  const { t } = useI18n();
  const { active } = useBusiness();
  const params = useSearchParams();
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [platform, status, active?.id]);
  const list = useResource<Paged<Publication>>(`/social/publications${qs({ platform, status, page, pageSize: 15 })}`, active?.id);
  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <div className="flex flex-wrap gap-3">
          <div className="w-44">
            <label htmlFor="hf-platform" className="mb-1 block text-xs font-medium text-muted-foreground">{t('calendar.entry.platform')}</label>
            <Select id="hf-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">{t('calendar.allPlatforms')}</option>{PLATFORMS.map((p) => <option key={p} value={p}>{t(`calendar.platforms.${p}`)}</option>)}</Select>
          </div>
          <div className="w-52">
            <label htmlFor="hf-status" className="mb-1 block text-xs font-medium text-muted-foreground">{t('social.history.status')}</label>
            <Select id="hf-status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('social.history.allStatuses')}</option>{PUBLICATION_STATUSES.map((s) => <option key={s} value={s}>{t(`social.pubStatus.${s}`)}</option>)}</Select>
          </div>
        </div>
        {list.loading && !list.data ? <LoadingRows rows={4} label={t('common.loading')} /> : list.error && !list.data ? <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void list.reload()} /> : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState title={t('social.history.emptyTitle')} hint={t('social.history.emptyHint')} />
        ) : (
          <>
            <PublicationList items={list.data!.items} onChanged={() => void list.reload()} testId="history-list" />
            <Pagination page={list.data!.page} pageCount={list.data!.pageCount} total={list.data!.total} onPage={setPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data!.total }) }} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function HistoryPage() {
  const { t } = useI18n();
  return (
    <SocialSection title={t('social.history.title')} description={t('social.history.subtitle')}>
      <Suspense fallback={null}><History /></Suspense>
    </SocialSection>
  );
}
