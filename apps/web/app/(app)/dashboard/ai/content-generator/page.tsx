'use client';
import { useEffect, useMemo, useState } from 'react';
import { AI_PLATFORMS, FORMAT_RULES, FORMATS_BY_PLATFORM, type AiFormat } from '@touma/shared';
import { AiError } from '@/components/ai/ai-error';
import { AiSection, Steps, UsageLine } from '@/components/ai/ai-section';
import { ContentEditor } from '@/components/ai/content-editor';
import { GeneratePanel } from '@/components/ai/generate-panel';
import { ItemSelect, LanguageSelect, parseItem, PurposeSelect, ToneSelect } from '@/components/ai/selectors';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import type { ContentOutput, Generation } from '@/components/ai/types';
import { useBusiness } from '@/components/business-provider';
import { useI18n } from '@/components/i18n-provider';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api-client';

export default function ContentGeneratorPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const status = useAiStatus();
  const gen = useGenerate<ContentOutput>();
  const [platform, setPlatform] = useState<string>('INSTAGRAM');
  const formats = useMemo(() => FORMATS_BY_PLATFORM[platform as keyof typeof FORMATS_BY_PLATFORM] ?? [], [platform]);
  const [format, setFormat] = useState<AiFormat>('INSTAGRAM_CAPTION');
  const [purpose, setPurpose] = useState('PROMOTIONAL');
  const [tone, setTone] = useState('FRIENDLY');
  const [language, setLanguage] = useState(active?.defaultLocale ?? locale);
  const [item, setItem] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!formats.includes(format)) setFormat(formats[0]!);
  }, [formats, format]);
  useEffect(() => gen.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = gen.result as Generation<ContentOutput> | null;
  const rule = current?.format ? FORMAT_RULES[current.format as AiFormat] : FORMAT_RULES[format];

  async function save(output: ContentOutput, edited: boolean) {
    if (!current || !active) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api<{ generation: Generation<ContentOutput>; content: { version: number } }>(`/ai/generations/${current.id}/draft`, {
        method: 'POST',
        businessId: active.id,
        json: edited ? { output } : {},
      });
      gen.setResult({ ...res.generation, steps: current.steps });
      setSaved(res.content.version);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err : new ApiError(0, 'UNKNOWN', String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AiSection title={t('ai.tabs.content')} description={t('ai.cg.description')}>
      <GeneratePanel
        instructions={instructions}
        onInstructions={setInstructions}
        pending={gen.pending}
        configured={status.data?.configured ?? false}
        onGenerate={() => {
          setSaved(null);
          void gen.run('/ai/content', { format, purpose, tone, language, ...parseItem(item), instructions: instructions || undefined });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="ai-platform" label={t('ai.fields.platform')}>
            <Select id="ai-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {AI_PLATFORMS.map((p) => <option key={p} value={p}>{t(`ai.platforms.${p}`)}</option>)}
              <option value="ANY">{t('ai.platforms.ANY')}</option>
            </Select>
          </Field>
          <Field id="ai-format" label={t('ai.fields.format')}>
            <Select id="ai-format" value={format} onChange={(e) => setFormat(e.target.value as AiFormat)}>
              {formats.map((f) => <option key={f} value={f}>{t(`ai.formats.${f}`)}</option>)}
            </Select>
          </Field>
          <PurposeSelect value={purpose} onChange={setPurpose} />
          <ToneSelect value={tone} onChange={setTone} />
          <LanguageSelect value={language} onChange={setLanguage} />
          <ItemSelect value={item} onChange={setItem} />
        </div>
      </GeneratePanel>
      <AiError error={gen.error ?? saveError} />
      {current?.output ? (
        <div className="grid gap-3">
          <Steps steps={current.steps} />
          <UsageLine usage={current.usage} model={current.model} />
          <ContentEditor
            initial={current.output}
            rule={rule}
            saving={saving}
            regenerating={gen.pending}
            savedVersion={saved}
            readOnly={!can('content.write')}
            onSave={save}
            onRegenerate={(feedback) => {
              setSaved(null);
              void gen.regenerate(current.id, feedback || undefined);
            }}
          />
        </div>
      ) : (
        !gen.pending && <EmptyState title={t('ai.cg.empty')} hint={t('ai.cg.emptyHint')} />
      )}
    </AiSection>
  );
}
