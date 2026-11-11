'use client';
import { useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { Steps } from './ai-section';
import type { Generation, JobStatus, QualityReport } from './types';

/** What the background job is doing right now: queued, running, or waiting to retry. */
export function JobProgress({ job }: { job: JobStatus | null }) {
  const { t } = useI18n();
  if (!job) return null;
  const label = job.retrying ? t('ai.job.retrying', { attempt: Math.min(job.attempt + 1, job.maxAttempts), max: job.maxAttempts }) : job.status === 'QUEUED' ? t('ai.job.queued') : t('ai.job.running');
  return (
    <div className="grid gap-2 rounded-md border border-dashed px-3 py-2" data-testid="ai-job" data-status={job.status} data-retrying={job.retrying ? 'true' : 'false'} aria-live="polite">
      <p className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {label}
      </p>
      <Steps steps={job.steps} testId="ai-job-steps" />
      <p className="text-xs text-muted-foreground">{t('ai.job.leaveHint')}</p>
    </div>
  );
}

/** Result of the accuracy check: which facts were matched to the verified business data. */
export function QualityLine({ quality }: { quality?: QualityReport | null }) {
  const { t } = useI18n();
  if (!quality) return null;
  const verified = Object.values(quality.verified).reduce((n, v) => n + v.length, 0);
  return (
    <div className="text-xs" data-testid="ai-quality" data-passed={quality.passed ? 'true' : 'false'}>
      <p className={`flex items-center gap-1.5 ${quality.passed ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}>
        {quality.passed ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
        {quality.passed ? t('ai.quality.passed', { count: verified }) : t('ai.quality.failed', { count: quality.issues.length })}
      </p>
      {!quality.passed && (
        <ul className="mt-1 list-disc ps-5 text-muted-foreground">
          {quality.issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      )}
    </div>
  );
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted' | 'default'> = { APPROVED: 'success', REJECTED: 'warning', IN_REVIEW: 'default', DRAFT: 'muted' };

/**
 * Human approval of a saved draft. AI-written content can only be published once a person with
 * `content.approve` has approved this exact text; editing it sends it back to draft.
 */
export function ApprovalPanel({ generation, onChange }: { generation: Generation; onChange: (g: Generation) => void }) {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const content = generation.content;

  async function act(action: 'submit-review' | 'approve' | 'reject') {
    if (!active) return;
    setBusy(action);
    setError(null);
    try {
      const res = await api<Generation>(`/ai/generations/${generation.id}/${action}`, { method: 'POST', businessId: active.id, json: action === 'reject' ? { reason } : {} });
      onChange(res);
      setRejecting(false);
      setReason('');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', String(err)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="ai-review">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('ai.review.title')}
          {content && <Badge variant={STATUS_VARIANT[content.status] ?? 'muted'} data-testid="ai-review-status">{t(`ai.review.status.${content.status}`)}</Badge>}
        </CardTitle>
        <CardDescription>{t('ai.review.hint')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!content && <p className="text-sm text-muted-foreground">{t('ai.review.saveFirst')}</p>}
        {content?.status === 'APPROVED' && content.approvedAt && (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {t('ai.review.approvedOn', { date: new Date(content.approvedAt).toLocaleDateString(locale) })}
          </p>
        )}
        {content?.status === 'REJECTED' && content.rejectionReason && <p className="text-sm">{t('ai.review.rejectedWith', { reason: content.rejectionReason })}</p>}
        {content && (content.status === 'DRAFT' || content.status === 'REJECTED') && can('content.write') && (
          <div>
            <Button size="sm" onClick={() => act('submit-review')} disabled={busy !== null}>
              {busy === 'submit-review' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('ai.review.submit')}
            </Button>
          </div>
        )}
        {content?.status === 'IN_REVIEW' &&
          (can('content.approve') ? (
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => act('approve')} disabled={busy !== null}>
                  {busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {t('ai.review.approve')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting((v) => !v)} disabled={busy !== null}>{t('ai.review.reject')}</Button>
              </div>
              {rejecting && (
                <div className="grid gap-2">
                  <label htmlFor="reject-reason" className="text-sm font-medium">{t('ai.review.reasonLabel')}</label>
                  <Textarea id="reject-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('ai.review.reasonPh')} />
                  <div>
                    <Button size="sm" variant="outline" onClick={() => act('reject')} disabled={busy !== null || reason.trim().length < 3}>{t('ai.review.confirmReject')}</Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('ai.review.waiting')}</p>
          ))}
        {error && (
          <div role="alert" data-testid="ai-review-error" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <p className="font-medium">{error.code === 'APPROVAL_BLOCKED' ? t('ai.review.blockedTitle') : (t(`ai.errors.${error.code}`).startsWith('ai.errors.') ? error.message : t(`ai.errors.${error.code}`))}</p>
            {error.code === 'APPROVAL_BLOCKED' && <p className="mt-1 text-muted-foreground">{t('ai.review.blockedHint')}</p>}
            {error.details && (
              <ul className="mt-1 list-disc ps-5 text-muted-foreground">
                {error.details.map((d) => <li key={d}>{d}</li>)}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
