import { FORMAT_RULES, VIDEO_FORMATS, type AiFormat, type AiLanguage, type AiPlatform, type VideoFormat } from '@touma/shared';
import type { GeneratedContent, Storyboard } from './schemas';

// ─── Language ─────────────────────────────────────────────────────────────────

const STOPWORDS: Record<'en' | 'fr' | 'tr', string[]> = {
  en: ['the', 'and', 'you', 'your', 'with', 'for', 'our', 'this', 'is', 'are', 'to', 'of'],
  fr: ['le', 'la', 'les', 'et', 'vous', 'votre', 'nos', 'avec', 'pour', 'des', 'est', 'une', 'du'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'sizin', 'çok', 'daha', 'en', 'olan', 'gibi', 'hemen'],
};

/** Lightweight language check: script for Arabic, stopword voting for Latin-script languages. */
export function checkLanguage(text: string, lang: AiLanguage): string[] {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return [];
  const arabic = (text.match(/\p{Script=Arabic}/gu) ?? []).length / letters.length;
  if (lang === 'ar') return arabic >= 0.5 ? [] : ['Content must be written in Arabic'];
  if (arabic > 0.2) return [`Content must be written in ${lang}, not Arabic`];
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 25) return [];
  const score = (l: 'en' | 'fr' | 'tr') => words.filter((w) => STOPWORDS[l].includes(w)).length;
  const scores = { en: score('en'), fr: score('fr'), tr: score('tr') };
  const best = (Object.keys(scores) as Array<'en' | 'fr' | 'tr'>).sort((a, b) => scores[b] - scores[a])[0]!;
  if (best !== lang && scores[best] >= 3 && scores[best] > 2 * scores[lang as 'en' | 'fr' | 'tr']) {
    return [`Content appears to be in "${best}" but "${lang}" was requested`];
  }
  return [];
}

// ─── Platform rules for generated content ────────────────────────────────────

const HASHTAG_RE = /^#[\p{L}\p{N}_]{1,59}$/u;

export function checkContent(c: GeneratedContent, req: { format: AiFormat; platform: AiPlatform | null; language: AiLanguage }): string[] {
  const issues: string[] = [];
  const rule = FORMAT_RULES[req.format];
  if (c.format !== req.format) issues.push(`format must be ${req.format}`);
  if (c.platform !== rule.platform) issues.push(`platform must be ${rule.platform ?? 'null'}`);
  if (c.language !== req.language) issues.push(`language must be ${req.language}`);

  const has = { caption: !!c.caption?.trim(), title: !!c.title?.trim(), description: !!c.description?.trim(), hook: !!c.hook?.trim(), slides: c.slides.length > 0, scenes: c.scenes.length > 0, storyFrames: c.storyFrames.length > 0 };
  for (const r of rule.requires) if (!has[r]) issues.push(`${r} is required for ${req.format}`);

  if (c.caption && c.caption.length > rule.maxCaptionChars) issues.push(`caption exceeds ${rule.maxCaptionChars} characters (${c.caption.length})`);
  if (rule.maxTitleChars && c.title && c.title.length > rule.maxTitleChars) issues.push(`title exceeds ${rule.maxTitleChars} characters`);
  if (rule.maxDescriptionChars && c.description && c.description.length > rule.maxDescriptionChars) issues.push(`description exceeds ${rule.maxDescriptionChars} characters`);

  if (c.hashtags.length > rule.maxHashtags) issues.push(`at most ${rule.maxHashtags} hashtags for ${req.format} (got ${c.hashtags.length})`);
  const bad = c.hashtags.filter((h) => !HASHTAG_RE.test(h));
  if (bad.length) issues.push(`invalid hashtags (must start with # and contain no spaces or punctuation): ${bad.slice(0, 3).join(', ')}`);
  if (new Set(c.hashtags.map((h) => h.toLowerCase())).size !== c.hashtags.length) issues.push('duplicate hashtags');

  if (rule.slides && (c.slides.length < rule.slides.min || c.slides.length > rule.slides.max)) issues.push(`carousel needs ${rule.slides.min}–${rule.slides.max} slides`);
  if (rule.storyFrames && (c.storyFrames.length < rule.storyFrames.min || c.storyFrames.length > rule.storyFrames.max)) issues.push(`story needs ${rule.storyFrames.min}–${rule.storyFrames.max} frames`);
  if (rule.durationSeconds && c.scenes.length) {
    const total = c.scenes.reduce((s, x) => s + x.durationSeconds, 0);
    if (total < rule.durationSeconds.min || total > rule.durationSeconds.max) issues.push(`total video duration must be ${rule.durationSeconds.min}–${rule.durationSeconds.max}s (got ${total}s)`);
    if (c.scenes.some((sc, i) => sc.order !== i + 1)) issues.push('scenes must be ordered 1..n');
  }
  const text = [c.title, c.hook, c.caption, c.description, ...c.slides.flatMap((s) => [s.heading, s.body]), ...c.scenes.flatMap((s) => [s.voiceover, s.onScreenText]), ...c.storyFrames.map((f) => f.text), c.callToAction]
    .filter(Boolean)
    .join(' ');
  issues.push(...checkLanguage(text, req.language));
  return issues;
}

/** Structure and timing of a storyboard against what was asked for. */
export function checkStoryboard(sb: Storyboard, req: { format: VideoFormat; seconds: number; language: AiLanguage }): string[] {
  const issues: string[] = [];
  const rule = VIDEO_FORMATS[req.format];
  if (sb.format !== req.format) issues.push(`format must be ${req.format}`);
  if (sb.aspectRatio !== rule.aspect) issues.push(`aspectRatio must be ${rule.aspect} for ${req.format}`);
  if (sb.language !== req.language) issues.push(`language must be ${req.language}`);
  if (sb.scenes.some((x, i) => x.order !== i + 1)) issues.push('scenes must be ordered 1..n');
  if (sb.scenes.length < 2) issues.push('a storyboard needs at least 2 scenes');
  const total = sb.scenes.reduce((n, x) => n + x.durationSeconds, 0);
  const tolerance = Math.max(2, Math.round(req.seconds * 0.15));
  if (Math.abs(total - req.seconds) > tolerance) issues.push(`scene durations add up to ${total}s but the video must be about ${req.seconds}s (±${tolerance}s)`);
  if (Math.abs(sb.totalSeconds - total) > 1) issues.push(`totalSeconds (${sb.totalSeconds}) must equal the sum of the scene durations (${total})`);
  const spoken = [sb.hook, sb.voiceoverScript, ...sb.scenes.flatMap((x) => [x.voiceover, x.onScreenText]), sb.callToAction].filter(Boolean).join(' ');
  issues.push(...checkLanguage(spoken, req.language));
  return issues;
}
