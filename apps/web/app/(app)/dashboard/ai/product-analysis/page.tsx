'use client';
import { useEffect, useState } from 'react';
import { AiError } from '@/components/ai/ai-error';
import { AiSection, Steps, UsageLine } from '@/components/ai/ai-section';
import { GeneratePanel } from '@/components/ai/generate-panel';
import { ItemSelect, LanguageSelect, parseItem } from '@/components/ai/selectors';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import { ProductAnalysisView } from '@/components/ai/views';
import type { Generation } from '@/components/ai/types';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { EmptyState } from '@/components/ui/states';
import { api } from '@/lib/api-client';

export default function ProductAnalysisPage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const status = useAiStatus();
  const gen = useGenerate();
  const [item, setItem] = useState('');
  const [language, setLanguage] = useState(active?.defaultLocale ?? locale);
  const [instructions, setInstructions] = useState('');

  // Show the latest analysis of the selected item, if any.
  useEffect(() => {
    gen.setResult(null);
    const parsed = parseItem(item);
    if (!active || !parsed.itemId) return;
    void api<{ generation: Generation | null }>(`/ai/generations/latest/product-analysis?itemId=${parsed.itemId}`, { businessId: active.id }).then((r) => r.generation && gen.setResult(r.generation));
  }, [item, active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = gen.result;
  return (
    <AiSection title={t('ai.tabs.productAnalysis')} description={t('ai.pa.description')}>
      <GeneratePanel
        instructions={instructions}
        onInstructions={setInstructions}
        pending={gen.pending}
        configured={status.data?.configured ?? false}
        canGenerate={Boolean(item)}
        onGenerate={() => gen.run('/ai/product-analysis', { language, ...parseItem(item), instructions: instructions || undefined })}
        onRegenerate={current ? () => gen.regenerate(current.id, instructions || undefined) : undefined}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <ItemSelect value={item} onChange={setItem} optional={false} />
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
      </GeneratePanel>
      <AiError error={gen.error} />
      {current?.output ? (
        <div className="grid gap-3">
          <Steps steps={current.steps} />
          <UsageLine usage={current.usage} model={current.model} />
          <ProductAnalysisView data={current.output} />
        </div>
      ) : (
        <EmptyState title={t('ai.pa.empty')} hint={t('ai.pa.emptyHint')} />
      )}
    </AiSection>
  );
}
