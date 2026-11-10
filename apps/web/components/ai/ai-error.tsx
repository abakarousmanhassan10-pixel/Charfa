'use client';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import type { ApiError } from '@/lib/api-client';

export function AiError({ error }: { error: ApiError | null }) {
  const { t } = useI18n();
  if (!error) return null;
  const known = t(`ai.errors.${error.code}`);
  return (
    <div role="alert" data-testid="ai-error" className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <div>
        <p className="font-medium">{known.startsWith('ai.errors.') ? t('ai.errors.UNKNOWN') : known}</p>
        {error.code === 'AI_INVALID_OUTPUT' && <p className="mt-1 text-muted-foreground">{error.message}</p>}
      </div>
    </div>
  );
}
