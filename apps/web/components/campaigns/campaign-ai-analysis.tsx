'use client';
import { Loader2 } from 'lucide-react';
import { AiError } from '@/components/ai/ai-error';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';

interface Analysis {
  summary: string;
  evidence: 'REAL' | 'SIMULATED_ONLY' | 'NONE';
  observations: Array<{ text: string }>;
  recommendations: Array<{ text: string }>;
  caveats: string[];
}

/** A plain-language reading of a campaign's measured results. It explains and suggests; it never publishes, spends or changes anything. */
export function CampaignAiAnalysis({ campaignId, enabled }: { campaignId: string; enabled: boolean }) {
  const { t, locale } = useI18n();
  const gen = useGenerate<Analysis>();
  const status = useAiStatus().data;
  const simulated = status?.mode === 'simulated';
  const unavailable = status?.mode === 'disabled';
  const out = gen.result?.output ?? null;
  return (
    <div className="grid gap-2" data-testid="campaign-ai">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!enabled || gen.pending || unavailable} onClick={() => void gen.run('/ai/campaign-analysis', { language: locale === 'fr' ? 'fr' : 'en', campaignId })} data-testid="ai-analysis-button">
          {gen.pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t('campaigns.aiAnalysis')}
        </Button>
        {unavailable && <span className="text-xs text-muted-foreground" data-testid="ai-analysis-unavailable">{t('ai.notConfiguredBanner')}</span>}
        {!enabled && <span className="text-xs text-muted-foreground">{t('campaigns.aiNeedsMetrics')}</span>}
      </div>
      <AiError error={gen.error} />
      {out && (
        <div className="grid gap-1 rounded-md border p-3 text-sm" data-testid="ai-analysis-result">
          {simulated && <p className="w-fit rounded bg-amber-500/10 px-2 py-0.5 text-xs" data-testid="ai-result-simulated">{t('ai.simulatedBadge')}</p>}
          <p>{out.summary}</p>
          {out.observations.length > 0 && <ul className="list-disc pl-5">{out.observations.map((o) => <li key={o.text}>{o.text}</li>)}</ul>}
          {out.recommendations.length > 0 && <><p className="font-medium">{t('campaigns.aiSuggestions')}</p><ul className="list-disc pl-5">{out.recommendations.map((r) => <li key={r.text}>{r.text}</li>)}</ul></>}
          {out.caveats.length > 0 && <p className="text-xs text-muted-foreground">{out.caveats.join(' ')}</p>}
          <p className="text-xs text-muted-foreground">{t('campaigns.aiNote')}</p>
        </div>
      )}
    </div>
  );
}
