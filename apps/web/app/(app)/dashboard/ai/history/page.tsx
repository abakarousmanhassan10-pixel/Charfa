'use client';
import { useEffect, useState } from 'react';
import { AI_TASKS } from '@touma/shared';
import { AiSection, UsageLine } from '@/components/ai/ai-section';
import { ContentEditor } from '@/components/ai/content-editor';
import type { ContentOutput, Generation } from '@/components/ai/types';
import { BusinessAnalysisView, ProductAnalysisView, StrategyView } from '@/components/ai/views';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { FORMAT_RULES, type AiFormat } from '@touma/shared';
import { qs, useResource, type Paged } from '@/lib/use-resource';

export default function HistoryPage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const [task, setTask] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [task, status, active?.id]);
  const list = useResource<Paged<Generation>>(`/ai/generations${qs({ task, status, page, pageSize: 15 })}`, active?.id);
  const [open, setOpen] = useState<Generation | null>(null);
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <AiSection title={t('ai.tabs.history')} description={t('ai.history.subtitle')}>
      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 grid gap-3 sm:flex">
            <Select aria-label={t('ai.history.task')} value={task} onChange={(e) => setTask(e.target.value)} className="sm:w-56">
              <option value="">{t('ai.history.allTasks')}</option>
              {AI_TASKS.map((x) => <option key={x} value={x}>{t(`ai.tasks.${x}`)}</option>)}
            </Select>
            <Select aria-label={t('ai.history.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-44">
              <option value="">{t('ai.history.allStatuses')}</option>
              {['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'].map((x) => <option key={x} value={x}>{t(`ai.statuses.${x}`)}</option>)}
            </Select>
          </div>
          {list.error ? (
            <ErrorState message={t('common.loadError')} retryLabel={t('common.retry')} onRetry={list.reload} />
          ) : list.loading && !list.data ? (
            <LoadingRows label={t('common.loading')} />
          ) : !list.data?.items.length ? (
            <EmptyState title={t('ai.history.empty')} />
          ) : (
            <>
              <ul className="divide-y" data-testid="history-list">
                {list.data.items.map((g) => (
                  <li key={g.id}>
                    <button type="button" onClick={() => setOpen(g)} className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-start hover:bg-accent/50">
                      <span className="min-w-0">
                        <span className="block font-medium">{g.format ? t(`ai.formats.${g.format}`) : t(`ai.tasks.${g.task}`)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`ai.tasks.${g.task}`)} · {g.language.toUpperCase()} · {fmt.format(new Date(g.createdAt))}
                          {g.parentId && ` · ${t('ai.history.regenerated')}`}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        {g.content && <Badge>{t(`ai.review.status.${g.content.status}`)}</Badge>}
                        {g.injectionFlags.length > 0 && <Badge variant="warning">{t('ai.history.flagged')}</Badge>}
                        <Badge variant={g.status === 'SUCCEEDED' ? 'success' : g.status === 'QUEUED' || g.status === 'RUNNING' ? 'muted' : 'warning'}>{t(`ai.statuses.${g.status}`)}</Badge>
                        <span className="tabular-nums text-muted-foreground">{g.usage.inputTokens + g.usage.outputTokens} tok</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} labels={{ previous: t('common.previous'), next: t('common.next'), summary: t('common.resultCount', { count: list.data.total }) }} />
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} title={open ? (open.format ? t(`ai.formats.${open.format}`) : t(`ai.tasks.${open.task}`)) : ''} className="max-w-4xl" closeLabel={t('common.close')}>
        {open && (
          <div className="grid max-h-[70vh] gap-3 overflow-y-auto">
            <UsageLine usage={open.usage} model={open.model} />
            {(open.status === 'QUEUED' || open.status === 'RUNNING') && <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">{t('ai.job.leaveHint')}</p>}
            {(open.status === 'FAILED' || open.status === 'BLOCKED') && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{open.errorCode}: {open.errorMessage}</p>}
            {open.output && open.task === 'BUSINESS_ANALYSIS' && <BusinessAnalysisView data={open.output} />}
            {open.output && open.task === 'PRODUCT_ANALYSIS' && <ProductAnalysisView data={open.output} />}
            {open.output && open.task === 'MARKETING_STRATEGY' && <StrategyView data={open.output} />}
            {open.output && open.task === 'CONTENT' && (
              <ContentEditor initial={open.output as ContentOutput} rule={FORMAT_RULES[open.format as AiFormat]} saving={false} regenerating={false} savedVersion={null} onSave={() => undefined} onRegenerate={() => undefined} readOnly />
            )}
          </div>
        )}
      </Dialog>
    </AiSection>
  );
}
