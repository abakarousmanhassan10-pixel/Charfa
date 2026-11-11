'use client';
import Link from 'next/link';
import { BarChart3, FileText, Megaphone, PackageSearch, Sparkles } from 'lucide-react';
import { AiSection } from '@/components/ai/ai-section';
import type { Generation } from '@/components/ai/types';
import { UsageReport } from '@/components/ai/usage-report';
import { useAiStatus } from '@/components/ai/use-ai';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useResource, type Paged } from '@/lib/use-resource';

const ACTIONS = [
  ['businessAnalysis', '/dashboard/ai/business-analysis', BarChart3],
  ['productAnalysis', '/dashboard/ai/product-analysis', PackageSearch],
  ['strategy', '/dashboard/ai/marketing-strategy', Megaphone],
  ['content', '/dashboard/ai/content-generator', FileText],
] as const;

export default function AiOverviewPage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const status = useAiStatus();
  const recent = useResource<Paged<Generation>>('/ai/generations?pageSize=5', active?.id);
  return (
    <AiSection title={t('ai.overview.title')} description={t('ai.overview.subtitle')}>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>{t('ai.overview.engine')}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm" data-testid="ai-engine-status">
            <p className="flex items-center justify-between">{t('ai.overview.status')} <Badge variant={status.data?.configured ? 'success' : 'warning'}>{status.data?.configured ? t('common.configured') : t('common.notConfigured')}</Badge></p>
            <p className="flex items-center justify-between">{t('ai.overview.provider')} <span className="font-medium">{status.data?.provider}</span></p>
            <p className="flex items-center justify-between">{t('ai.overview.model')} <span className="font-mono text-xs">{status.data?.model}</span></p>
            {status.data && (
              <p className="flex items-center justify-between">{t('ai.overview.thisMonth')} <span className="tabular-nums" data-testid="ai-month-usage">{status.data.usage.generations} / {status.data.usage.generationLimit}{status.data.usage.reservedGenerations > 0 && ` (+${status.data.usage.reservedGenerations} ${t('ai.overview.inProgress')})`}</span></p>
            )}
          </CardContent>
        </Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
          {ACTIONS.map(([key, href, Icon]) => (
            <Link key={key} href={href} className="rounded-xl border bg-card p-5 transition hover:border-primary hover:shadow-sm">
              <Icon className="h-5 w-5 text-primary" aria-hidden />
              <p className="mt-3 font-semibold">{t(`ai.tabs.${key}`)}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t(`ai.overview.${key}`)}</p>
            </Link>
          ))}
        </div>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <UsageReport />
        <Card>
          <CardHeader><CardTitle>{t('ai.overview.recent')}</CardTitle></CardHeader>
          <CardContent>
            {recent.data?.items.length ? (
              <ul className="divide-y text-sm" data-testid="recent-generations">
                {recent.data.items.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />{g.format ? t(`ai.formats.${g.format}`) : t(`ai.tasks.${g.task}`)}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={g.status === 'SUCCEEDED' ? 'success' : g.status === 'QUEUED' || g.status === 'RUNNING' ? 'muted' : 'warning'}>{t(`ai.statuses.${g.status}`)}</Badge>
                      {new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(g.createdAt))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('ai.overview.noHistory')}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </AiSection>
  );
}
