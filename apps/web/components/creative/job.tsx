'use client';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import type { ApiError } from '@/lib/api-client';
import type { CreativeJobStatus } from './types';

/** What the background job is doing: queued, running (with the provider's state for video), or retrying. */
export function CreativeJobProgress({ job, kind }: { job: CreativeJobStatus | null; kind: 'IMAGE' | 'VIDEO' }) {
  const { t } = useI18n();
  if (!job) return null;
  const label = job.retrying
    ? t('creative.job.retrying', { attempt: Math.min(job.attempt + 1, job.maxAttempts), max: job.maxAttempts })
    : job.status === 'QUEUED'
      ? t('creative.job.queued')
      : kind === 'VIDEO'
        ? t(`creative.job.video.${job.providerStatus ?? 'starting'}`)
        : t('creative.job.generatingImage', { count: job.requestedUnits });
  return (
    <div className="grid gap-1 rounded-xl border border-dashed bg-muted/30 px-4 py-3" role="status" aria-live="polite" data-testid="creative-job" data-status={job.status} data-provider-status={job.providerStatus ?? ''} data-retrying={job.retrying ? 'true' : 'false'}>
      <p className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {label}
      </p>
      <p className="text-xs text-muted-foreground">{t('creative.job.leaveHint')}</p>
    </div>
  );
}

export function CreativeError({ error }: { error: ApiError | null }) {
  const { t } = useI18n();
  if (!error) return null;
  const known = t(`creative.errors.${error.code}`);
  const text = known.startsWith('creative.errors.') ? t(`ai.errors.${error.code}`) : known;
  return (
    <div role="alert" data-testid="creative-error" className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{text.startsWith('ai.errors.') ? t('creative.errors.UNKNOWN') : text}</p>
        {error.details && (
          <ul className="mt-1 list-disc ps-5 text-muted-foreground">
            {error.details.map((d) => <li key={d}>{d}</li>)}
          </ul>
        )}
        {error.code === 'PRODUCT_CUTOUT_FAILED' && <p className="mt-1 text-muted-foreground">{error.message}</p>}
      </div>
    </div>
  );
}
