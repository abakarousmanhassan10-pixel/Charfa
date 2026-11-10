'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useAiStatus } from './use-ai';

const TABS = [
  ['overview', '/dashboard/ai'],
  ['businessAnalysis', '/dashboard/ai/business-analysis'],
  ['productAnalysis', '/dashboard/ai/product-analysis'],
  ['strategy', '/dashboard/ai/marketing-strategy'],
  ['content', '/dashboard/ai/content-generator'],
  ['history', '/dashboard/ai/history'],
] as const;

/** Shared header for TOUMA AI pages: business selector, sub-navigation, configuration banner. */
export function AiSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { businesses, active, setActive } = useBusiness();
  const status = useAiStatus();
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            TOUMA AI
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-muted-foreground">{description}</p>}
        </div>
        <div className="sm:w-64">
          <label htmlFor="ai-business" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('ai.fields.business')}
          </label>
          <Select id="ai-business" value={active?.id ?? ''} onChange={(e) => setActive(e.target.value)}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </div>
      </div>
      <nav aria-label="TOUMA AI" className="mb-6 flex gap-1 overflow-x-auto border-b">
        {TABS.map(([key, href]) => (
          <Link
            key={key}
            href={href}
            aria-current={pathname === href ? 'page' : undefined}
            className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', pathname === href ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t(`ai.tabs.${key}`)}
          </Link>
        ))}
      </nav>
      {status.data && !status.data.configured && (
        <div role="status" data-testid="ai-not-configured" className="mb-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <p className="font-medium">{t('ai.notConfiguredTitle')}</p>
          <p className="mt-1 text-muted-foreground">{t('ai.notConfiguredText')}</p>
        </div>
      )}
      {children}
    </div>
  );
}

export function Steps({ steps }: { steps?: Array<{ step: string; status: string; detail?: string }> }) {
  const { t } = useI18n();
  if (!steps?.length) return null;
  return (
    <ol className="flex flex-wrap gap-2 text-xs" aria-label={t('ai.pipeline')} data-testid="ai-steps">
      {steps.map((s, i) => (
        <li key={i} title={s.detail} className={cn('rounded-full border px-2.5 py-1', s.status === 'reused' && 'border-emerald-500/40 bg-emerald-500/10', s.status === 'skipped' && 'text-muted-foreground')}>
          {t(`ai.steps.${s.step}`)} · {t(`ai.stepStatus.${s.status}`)}
        </li>
      ))}
    </ol>
  );
}

export function UsageLine({ usage, model }: { usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; attempts: number }; model: string }) {
  const { t } = useI18n();
  return (
    <p className="text-xs text-muted-foreground" data-testid="ai-usage">
      {t('ai.usageLine', { input: usage.inputTokens, output: usage.outputTokens, attempts: usage.attempts, seconds: (usage.latencyMs / 1000).toFixed(1), model })}
      {usage.costUsd > 0 && ` · ≈ $${usage.costUsd.toFixed(4)}`}
    </p>
  );
}
