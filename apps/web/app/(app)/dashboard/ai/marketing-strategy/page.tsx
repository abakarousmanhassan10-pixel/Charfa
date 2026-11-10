'use client';
import { useEffect, useState } from 'react';
import { AiError } from '@/components/ai/ai-error';
import { AiSection, Steps, UsageLine } from '@/components/ai/ai-section';
import { GeneratePanel } from '@/components/ai/generate-panel';
import { LanguageSelect, PlatformToggle } from '@/components/ai/selectors';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import { StrategyView } from '@/components/ai/views';
import type { Generation } from '@/components/ai/types';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { EmptyState, LoadingRows } from '@/components/ui/states';
import { useResource } from '@/lib/use-resource';

export default function StrategyPage() {
  const { t, locale } = useI18n();
  const { active } = useBusiness();
  const status = useAiStatus();
  const latest = useResource<{ generation: Generation | null }>('/ai/generations/latest/marketing-strategy', active?.id);
  const gen = useGenerate();
  const [platforms, setPlatforms] = useState<string[]>(['INSTAGRAM', 'FACEBOOK']);
  const [goal, setGoal] = useState('');
  const [language, setLanguage] = useState(active?.defaultLocale ?? locale);
  const [instructions, setInstructions] = useState('');
  useEffect(() => gen.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = gen.result ?? latest.data?.generation ?? null;

  return (
    <AiSection title={t('ai.tabs.strategy')} description={t('ai.st.description')}>
      <GeneratePanel
        instructions={instructions}
        onInstructions={setInstructions}
        pending={gen.pending}
        configured={status.data?.configured ?? false}
        canGenerate={platforms.length > 0}
        onGenerate={() => gen.run('/ai/marketing-strategy', { language, platforms, goal: goal || undefined, instructions: instructions || undefined })}
        onRegenerate={current ? () => gen.regenerate(current.id, instructions || undefined) : undefined}
      >
        <PlatformToggle value={platforms} onChange={setPlatforms} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ai-goal" label={t('ai.fields.goal')} optional optionalLabel={t('common.optional')}>
            <Input id="ai-goal" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={300} placeholder={t('ai.goalPh')} />
          </Field>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
      </GeneratePanel>
      <AiError error={gen.error} />
      {latest.loading && !current ? (
        <LoadingRows rows={3} label={t('common.loading')} />
      ) : current?.output ? (
        <div className="grid gap-3">
          <Steps steps={current.steps} />
          <UsageLine usage={current.usage} model={current.model} />
          <StrategyView data={current.output} />
        </div>
      ) : (
        <EmptyState title={t('ai.st.empty')} hint={t('ai.st.emptyHint')} />
      )}
    </AiSection>
  );
}
