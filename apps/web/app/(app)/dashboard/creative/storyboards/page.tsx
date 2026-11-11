'use client';
import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { AiError } from '@/components/ai/ai-error';
import { ItemSelect, LanguageSelect, parseItem, ToneSelect } from '@/components/ai/selectors';
import type { Generation } from '@/components/ai/types';
import { useAiStatus, useGenerate } from '@/components/ai/use-ai';
import { JobProgress } from '@/components/ai/review';
import { useBusiness } from '@/components/business-provider';
import { CreativeSection } from '@/components/creative/creative-section';
import { StoryboardView } from '@/components/creative/storyboard-view';
import type { Storyboard } from '@/components/creative/types';
import { useCreativeStatus } from '@/components/creative/use-creative';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { qs, useResource, type Paged } from '@/lib/use-resource';

export default function StoryboardsPage() {
  const { t, locale } = useI18n();
  const { active, can } = useBusiness();
  const ai = useAiStatus();
  const status = useCreativeStatus();
  const gen = useGenerate<Storyboard>();
  const history = useResource<Paged<Generation<Storyboard>>>(`/creative/storyboards${qs({ status: 'SUCCEEDED', pageSize: 8 })}`, active?.id);
  const formats = status.data?.options.videoFormats ?? {};
  const [language, setLanguage] = useState(active?.defaultLocale ?? locale);
  const [format, setFormat] = useState('SHORT_VERTICAL');
  const [seconds, setSeconds] = useState(12);
  const [style, setStyle] = useState('CINEMATIC');
  const [tone, setTone] = useState('FRIENDLY');
  const [item, setItem] = useState('');
  const [instructions, setInstructions] = useState('');
  const rule = formats[format];
  useEffect(() => gen.setResult(null), [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (rule && (seconds < rule.minSeconds || seconds > rule.maxSeconds)) setSeconds(Math.min(rule.maxSeconds, Math.max(rule.minSeconds, seconds)));
  }, [rule, seconds]);
  useEffect(() => {
    if (gen.result) void history.reload();
  }, [gen.result?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = gen.result as Generation<Storyboard> | null;
  const configured = ai.data?.configured ?? false;
  const canUse = can('ai.use') && configured && !gen.pending;
  const seconds_options = rule ? Array.from(new Set([rule.minSeconds, 8, 12, 15, 20, 30, 45, 60, rule.maxSeconds].filter((s) => s >= rule.minSeconds && s <= rule.maxSeconds))).sort((a, b) => a - b) : [8, 12];

  return (
    <CreativeSection title={t('creative.storyboards.title')} description={t('creative.storyboards.subtitle')}>
      {ai.data && !configured && (
        <div role="status" className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <p className="font-medium">{t('ai.notConfiguredTitle')}</p>
          <p className="mt-1 text-muted-foreground">{t('ai.notConfiguredText')}</p>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardContent className="grid gap-4 pt-6">
            <ItemSelect value={item} onChange={setItem} />
            <div className="grid grid-cols-2 gap-3">
              <Field id="sb-format" label={t('creative.videos.format')}>
                <Select id="sb-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                  {Object.keys(formats).length ? Object.keys(formats).map((k) => <option key={k} value={k}>{t(`creative.enums.videoFormats.${k}`)}</option>) : <option value={format}>{format}</option>}
                </Select>
              </Field>
              <Field id="sb-seconds" label={t('creative.videos.seconds')}>
                <Select id="sb-seconds" value={String(seconds)} onChange={(e) => setSeconds(Number(e.target.value))}>
                  {seconds_options.map((s) => <option key={s} value={s}>{s}s</option>)}
                </Select>
              </Field>
            </div>
            <Field id="sb-style" label={t('creative.videos.style')}>
              <Select id="sb-style" value={style} onChange={(e) => setStyle(e.target.value)}>
                {(status.data?.options.videoStyles ?? [style]).map((s) => <option key={s} value={s}>{t(`creative.enums.videoStyles.${s}`)}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <LanguageSelect value={language} onChange={setLanguage} />
              <ToneSelect value={tone} onChange={setTone} />
            </div>
            <Field id="sb-instructions" label={t('ai.fields.instructions')} optional optionalLabel={t('common.optional')}>
              <Textarea id="sb-instructions" rows={2} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </Field>
            {!can('ai.use') && <p className="text-sm text-muted-foreground">{t('ai.noPermission')}</p>}
            <Button disabled={!canUse} className="w-full" onClick={() => void gen.run('/creative/storyboards', { language, format, seconds, style, tone, ...parseItem(item), instructions: instructions || undefined })}>
              {gen.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              {gen.pending ? t('creative.storyboards.generating') : t('creative.storyboards.generate')}
            </Button>
          </CardContent>
        </Card>

        <div className="grid min-w-0 content-start gap-4">
          <JobProgress job={gen.job} />
          <AiError error={gen.error} />
          {current?.output ? <StoryboardView generation={current} canCreateVideo={status.data?.video.configured ?? false} /> : !gen.pending && <EmptyState title={t('creative.storyboards.empty')} hint={t('creative.storyboards.emptyHint')} />}
          {history.data && history.data.items.length > 0 && (
            <section aria-label={t('creative.storyboards.previous')}>
              <h2 className="mb-2 text-sm font-semibold">{t('creative.storyboards.previous')}</h2>
              <ul className="grid gap-2 sm:grid-cols-2" data-testid="storyboard-history">
                {history.data.items.map((g) => (
                  <li key={g.id}>
                    <button type="button" onClick={() => gen.setResult(g)} className="w-full rounded-lg border p-3 text-start text-sm hover:bg-muted/50">
                      <span className="block truncate font-medium">{g.output?.title}</span>
                      <span className="block text-xs text-muted-foreground">{t(`creative.enums.videoFormats.${g.output?.format}`)} · {g.output?.totalSeconds}s · {new Date(g.createdAt).toLocaleDateString(locale)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </CreativeSection>
  );
}
