'use client';
import { PlugZap } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';

/** Said plainly when a provider is not configured: nothing is simulated, and the admin is told what to set. */
export function NotConfigured({ kind }: { kind: 'image' | 'video' }) {
  const { t } = useI18n();
  return (
    <div role="status" data-testid={`creative-not-configured-${kind}`} className="mb-6 flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <PlugZap className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{t(`creative.notConfigured.${kind}.title`)}</p>
        <p className="mt-1 text-muted-foreground">{t(`creative.notConfigured.${kind}.text`)}</p>
      </div>
    </div>
  );
}
