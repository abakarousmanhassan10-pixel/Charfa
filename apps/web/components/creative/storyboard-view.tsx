'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Check, Clapperboard, Copy } from 'lucide-react';
import { QualityLine } from '@/components/ai/review';
import type { Generation } from '@/components/ai/types';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Storyboard } from './types';

const SEGMENT = ['bg-primary/80', 'bg-primary/55', 'bg-primary/35', 'bg-primary/65'];

/** A script and storyboard: a timeline of scenes, then each scene's visual, camera, voiceover, text and audio. */
export function StoryboardView({ generation, canCreateVideo }: { generation: Generation<Storyboard>; canCreateVideo: boolean }) {
  const { t } = useI18n();
  const sb = generation.output;
  const [copied, setCopied] = useState(false);
  if (!sb) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sb.videoPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="grid gap-4" data-testid="storyboard-view" dir={sb.language === 'ar' ? 'rtl' : undefined}>
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{sb.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{sb.concept}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge>{t(`creative.enums.videoFormats.${sb.format}`)}</Badge>
              <Badge variant="muted">{sb.aspectRatio}</Badge>
              <Badge variant="muted">{sb.totalSeconds}s</Badge>
            </div>
          </div>
          <p className="rounded-lg bg-primary/5 px-3 py-2 text-sm"><span className="font-medium">{t('creative.storyboards.hook')}: </span>{sb.hook}</p>

          <ol className="flex h-9 overflow-hidden rounded-lg border text-xs" aria-label={t('creative.storyboards.timeline')} data-testid="storyboard-timeline">
            {sb.scenes.map((s, i) => (
              <li key={s.order} style={{ flex: s.durationSeconds }} className={`flex items-center justify-center px-1 font-medium ${SEGMENT[i % SEGMENT.length]}`} title={s.visual}>
                {s.order} · {s.durationSeconds}s
              </li>
            ))}
          </ol>

          <ul className="grid gap-3 md:grid-cols-2">
            {sb.scenes.map((s) => (
              <li key={s.order} className="grid gap-1.5 rounded-xl border p-3 text-sm" data-testid="storyboard-scene">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{t('creative.storyboards.scene', { n: s.order })}</span>
                  <span className="text-xs text-muted-foreground">{s.durationSeconds}s</span>
                </div>
                <p>{s.visual}</p>
                {s.camera && <p className="text-xs text-muted-foreground">{t('creative.storyboards.camera')}: {s.camera}</p>}
                {s.voiceover && <p className="text-xs"><span className="font-medium">{t('creative.storyboards.voiceover')}: </span>{s.voiceover}</p>}
                {s.onScreenText && <p className="text-xs"><span className="font-medium">{t('creative.storyboards.onScreen')}: </span>{s.onScreenText}</p>}
                {s.audio && <p className="text-xs text-muted-foreground">{t('creative.storyboards.audio')}: {s.audio}</p>}
                {s.productFocus && <p className="text-xs text-muted-foreground">{t('creative.storyboards.focus')}: {s.productFocus}</p>}
              </li>
            ))}
          </ul>

          {sb.voiceoverScript && (
            <div className="text-sm">
              <h3 className="mb-1 font-medium">{t('creative.storyboards.script')}</h3>
              <p className="whitespace-pre-wrap text-muted-foreground">{sb.voiceoverScript}</p>
            </div>
          )}
          <p className="text-sm"><span className="font-medium">{t('creative.storyboards.cta')}: </span>{sb.callToAction}{sb.musicMood && <span className="text-muted-foreground"> · {t('creative.storyboards.music')}: {sb.musicMood}</span>}</p>
          <div className="text-sm">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="font-medium">{t('creative.storyboards.videoPrompt')}</h3>
              <Button size="sm" variant="ghost" onClick={copy}>
                {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                {copied ? t('creative.storyboards.copied') : t('creative.storyboards.copy')}
              </Button>
            </div>
            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">{sb.videoPrompt}</p>
          </div>
          {(sb.missingInformation.length > 0 || sb.warnings.length > 0) && (
            <ul className="list-disc space-y-1 rounded-lg bg-amber-500/10 py-2 pe-3 ps-7 text-xs">
              {[...sb.missingInformation, ...sb.warnings].map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          <QualityLine quality={generation.quality} />
          {canCreateVideo && (
            <div>
              <Button asChild>
                <Link href={`/dashboard/creative/videos?storyboard=${generation.id}`}>
                  <Clapperboard className="h-4 w-4" aria-hidden />
                  {t('creative.storyboards.makeVideo')}
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
