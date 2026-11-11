'use client';
import { useEffect, useState } from 'react';
import { AiError } from '@/components/ai/ai-error';
import { AiSection, Steps, UsageLine } from '@/components/ai/ai-section';
import { GeneratePanel } from '@/components/ai/generate-panel';
import { LanguageSelect } from '@/components/ai/selectors';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import { BusinessAnalysisView } from '@/components/ai/views';
import type { Generation } from '@/components/ai/types';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { EmptyState, LoadingRows } from '@/components/ui/states';
import { useResource } from '@/lib/use-resource';

export default function BusinessAnalysisPage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const status = useAiStatus();
  const latest = useResource<{ generation: Generation | null }>('/ai/generations/latest/business-analysis', active?.id);
  const gen = useGenerate();
  const [language, setLanguage] = useState(active?.defaultLocale ?? locale);
  const [instructions, setInstructions] = useState('');
  useEffect(() => gen.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = gen.result ?? latest.data?.generation ?? null;

  return (
    <AiSection title={t('ai.tabs.businessAnalysis')} description={t('ai.ba.description')}>
      <GeneratePanel
        instructions={instructions}
        onInstructions={setInstructions}
        pending={gen.pending}
        job={gen.job}
        configured={status.data?.configured ?? false}
        onGenerate={() => gen.run('/ai/business-analysis', { language, instructions: instructions || undefined })}
        onRegenerate={current ? () => gen.regenerate(current.id, instructions || undefined) : undefined}
      >
        <div className="sm:w-60"><LanguageSelect value={language} onChange={setLanguage} /></div>
      </GeneratePanel>
      <AiError error={gen.error} />
      {latest.loading && !current ? (
        <LoadingRows rows={3} label={t('common.loading')} />
      ) : current?.output ? (
        <div className="grid gap-3">
          <Steps steps={current.steps} />
          <UsageLine usage={current.usage} model={current.model} />
          <BusinessAnalysisView data={current.output} />
        </div>
      ) : (
        <EmptyState title={t('ai.ba.empty')} hint={t('ai.ba.emptyHint')} />
      )}
    </AiSection>
  );
}
