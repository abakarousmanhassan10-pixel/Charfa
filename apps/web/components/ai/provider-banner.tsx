'use client';
import { useI18n } from '@/components/i18n-provider';
import { useAiStatus } from './use-ai';

/** Tells the merchant when the AI is simulated or not configured, so a generic result is never mistaken for a real AI answer. */
export function AiProviderBanner() {
  const { t } = useI18n();
  const status = useAiStatus();
  const s = status.data;
  if (!s) return null;
  if (!s.configured) return <p className="mb-4 rounded-md bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="ai-not-configured">{t('ai.notConfiguredBanner')}</p>;
  if (s.provider === 'fake') return <p className="mb-4 rounded-md bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="ai-simulated">{t('ai.simulatedBanner')}</p>;
  return null;
}
