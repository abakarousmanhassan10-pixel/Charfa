'use client';
import { useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ContentOutput, FormatRule } from './types';

function Counter({ value, max }: { value: string | null; max?: number }) {
  if (!max) return null;
  const n = value?.length ?? 0;
  return <span className={`text-xs tabular-nums ${n > max ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{n} / {max}</span>;
}

/**
 * Editable view of a generated content item. Limits from the platform rules are shown live;
 * the API re-validates everything when the draft is saved.
 */
export function ContentEditor({
  initial,
  rule,
  saving,
  regenerating,
  savedVersion,
  onSave,
  onRegenerate,
  readOnly,
}: {
  initial: ContentOutput;
  rule: FormatRule;
  saving: boolean;
  regenerating: boolean;
  savedVersion: number | null;
  onSave: (output: ContentOutput, edited: boolean) => void;
  onRegenerate: (instructions: string) => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const [c, setC] = useState<ContentOutput>(initial);
  const [hashtags, setHashtags] = useState(initial.hashtags.join(' '));
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    setC(initial);
    setHashtags(initial.hashtags.join(' '));
    setDirty(false);
  }, [initial]);

  const dir = c.language === 'ar' ? 'rtl' : 'ltr';
  const set = <K extends keyof ContentOutput>(k: K, v: ContentOutput[K]) => {
    setC((x) => ({ ...x, [k]: v }));
    setDirty(true);
  };
  const tags = hashtags.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : `#${h}`));
  const output = { ...c, hashtags: tags };
  const totalSeconds = c.scenes.reduce((s, x) => s + (Number(x.durationSeconds) || 0), 0);
  const ro = readOnly || saving;

  return (
    <Card data-testid="content-editor">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>{t('ai.result')}</CardTitle>
        <div className="flex flex-wrap gap-1">
          {c.platform && <Badge>{t(`ai.platforms.${c.platform}`)}</Badge>}
          <Badge variant="muted">{t(`ai.formats.${c.format}`)}</Badge>
          <Badge variant="muted">{c.language.toUpperCase()}</Badge>
          {dirty && <Badge variant="warning">{t('ai.edited')}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4" dir={dir}>
        {(c.title !== null || rule.requires.includes('title')) && (
          <Field id="ce-title" label={t('ai.ce.title')}>
            <Input id="ce-title" value={c.title ?? ''} onChange={(e) => set('title', e.target.value)} disabled={ro} dir={dir} />
            <Counter value={c.title} max={rule.maxTitleChars} />
          </Field>
        )}
        {(c.hook !== null || rule.requires.includes('hook')) && (
          <Field id="ce-hook" label={t('ai.ce.hook')}>
            <Input id="ce-hook" value={c.hook ?? ''} onChange={(e) => set('hook', e.target.value)} disabled={ro} dir={dir} />
          </Field>
        )}
        {(c.caption !== null || rule.requires.includes('caption')) && (
          <Field id="ce-caption" label={t('ai.ce.caption')}>
            <Textarea id="ce-caption" rows={7} value={c.caption ?? ''} onChange={(e) => set('caption', e.target.value)} disabled={ro} dir={dir} />
            <Counter value={c.caption} max={rule.maxCaptionChars} />
          </Field>
        )}
        {(c.description !== null || rule.requires.includes('description')) && (
          <Field id="ce-description" label={t('ai.ce.description')}>
            <Textarea id="ce-description" rows={7} value={c.description ?? ''} onChange={(e) => set('description', e.target.value)} disabled={ro} dir={dir} />
            <Counter value={c.description} max={rule.maxDescriptionChars} />
          </Field>
        )}

        {c.slides.length > 0 && (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">{t('ai.ce.slides', { min: rule.slides?.min ?? 0, max: rule.slides?.max ?? 0 })}</legend>
            {c.slides.map((s, i) => (
              <div key={i} className="grid gap-2 rounded-md border p-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  {t('ai.ce.slide', { n: i + 1 })}
                  {!ro && c.slides.length > (rule.slides?.min ?? 1) && (
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('ai.ce.removeSlide', { n: i + 1 })} onClick={() => set('slides', c.slides.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <Input aria-label={t('ai.ce.slideHeading', { n: i + 1 })} value={s.heading} disabled={ro} dir={dir} onChange={(e) => set('slides', c.slides.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))} />
                <Textarea aria-label={t('ai.ce.slideBody', { n: i + 1 })} rows={2} value={s.body} disabled={ro} dir={dir} onChange={(e) => set('slides', c.slides.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
              </div>
            ))}
            {!ro && c.slides.length < (rule.slides?.max ?? 10) && (
              <Button variant="outline" size="sm" className="w-fit" onClick={() => set('slides', [...c.slides, { heading: '', body: '' }])}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('ai.ce.addSlide')}
              </Button>
            )}
          </fieldset>
        )}

        {c.scenes.length > 0 && (
          <fieldset className="grid gap-3">
            <legend className="flex w-full items-center justify-between text-sm font-medium">
              {t('ai.ce.scenes')}
              <span className={`text-xs ${rule.durationSeconds && (totalSeconds > rule.durationSeconds.max || totalSeconds < rule.durationSeconds.min) ? 'text-destructive' : 'text-muted-foreground'}`}>
                {t('ai.ce.duration', { seconds: totalSeconds, max: rule.durationSeconds?.max ?? 0 })}
              </span>
            </legend>
            {c.scenes.map((s, i) => (
              <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[5rem_1fr]">
                <Field id={`ce-scene-${i}-d`} label={t('ai.ce.seconds')}>
                  <Input id={`ce-scene-${i}-d`} type="number" min={1} max={60} value={s.durationSeconds} disabled={ro} onChange={(e) => set('scenes', c.scenes.map((x, j) => (j === i ? { ...x, durationSeconds: Number(e.target.value) } : x)))} />
                </Field>
                <div className="grid gap-2">
                  <Textarea aria-label={t('ai.ce.visual', { n: i + 1 })} rows={2} value={s.visual} disabled={ro} dir={dir} onChange={(e) => set('scenes', c.scenes.map((x, j) => (j === i ? { ...x, visual: e.target.value } : x)))} />
                  <Input aria-label={t('ai.ce.voiceover', { n: i + 1 })} placeholder={t('ai.ce.voiceoverPh')} value={s.voiceover ?? ''} disabled={ro} dir={dir} onChange={(e) => set('scenes', c.scenes.map((x, j) => (j === i ? { ...x, voiceover: e.target.value || null } : x)))} />
                  <Input aria-label={t('ai.ce.onScreen', { n: i + 1 })} placeholder={t('ai.ce.onScreenPh')} value={s.onScreenText ?? ''} disabled={ro} dir={dir} onChange={(e) => set('scenes', c.scenes.map((x, j) => (j === i ? { ...x, onScreenText: e.target.value || null } : x)))} />
                </div>
              </div>
            ))}
          </fieldset>
        )}

        {c.storyFrames.length > 0 && (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">{t('ai.ce.frames')}</legend>
            {c.storyFrames.map((f, i) => (
              <div key={i} className="grid gap-2 rounded-md border p-3">
                <Textarea aria-label={t('ai.ce.frameText', { n: i + 1 })} rows={2} value={f.text} disabled={ro} dir={dir} onChange={(e) => set('storyFrames', c.storyFrames.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                <p className="text-xs text-muted-foreground">{f.visualIdea}{f.interactiveElement ? ` · ${f.interactiveElement}` : ''}</p>
              </div>
            ))}
          </fieldset>
        )}

        {rule.maxHashtags > 0 && (
          <Field id="ce-hashtags" label={t('ai.ce.hashtags')} hint={t('ai.ce.hashtagsHint', { max: rule.maxHashtags })}>
            <Input id="ce-hashtags" value={hashtags} onChange={(e) => { setHashtags(e.target.value); setDirty(true); }} disabled={ro} dir={dir} />
            <span className={`text-xs ${tags.length > rule.maxHashtags ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{tags.length} / {rule.maxHashtags}</span>
          </Field>
        )}
        <Field id="ce-cta" label={t('ai.ce.cta')}>
          <Input id="ce-cta" value={c.callToAction} onChange={(e) => set('callToAction', e.target.value)} disabled={ro} dir={dir} />
        </Field>

        {c.visualSuggestions.length > 0 && (
          <div className="text-sm"><p className="font-medium">{t('ai.ce.visuals')}</p><ul className="mt-1 list-disc ps-5 text-muted-foreground">{c.visualSuggestions.map((v, i) => <li key={i}>{v}</li>)}</ul></div>
        )}
        {c.claims.length > 0 && (
          <details className="rounded-md border p-3 text-sm" dir="ltr">
            <summary className="cursor-pointer font-medium">{t('ai.ce.claims', { count: c.claims.length })}</summary>
            <ul className="mt-2 space-y-1">{c.claims.map((x, i) => <li key={i} className="flex flex-wrap gap-2"><span dir="auto">{x.claim}</span><Badge variant="muted" className="font-mono text-[10px]">{x.source.split(':')[0]}</Badge></li>)}</ul>
          </details>
        )}
        {c.warnings.length > 0 && (
          <div role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">{t('ai.ce.warnings')}</p>
            <ul className="mt-1 list-disc ps-5">{c.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}
      </CardContent>
      {!readOnly && (
        <CardContent className="grid gap-3 border-t pt-4">
          <Field id="ce-feedback" label={t('ai.ce.feedback')} optional optionalLabel={t('common.optional')}>
            <Input id="ce-feedback" value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={500} placeholder={t('ai.ce.feedbackPh')} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onSave(output, dirty)} disabled={saving || regenerating}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
              {t('ai.saveDraft')}
            </Button>
            <Button variant="outline" onClick={() => onRegenerate(feedback)} disabled={saving || regenerating}>
              {regenerating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              {t('ai.regenerate')}
            </Button>
            {savedVersion !== null && <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{t('ai.draftSaved', { version: savedVersion })}</span>}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
