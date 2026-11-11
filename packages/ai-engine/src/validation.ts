import { FORMAT_RULES, HOLIDAY_TERMS, PLATFORM_RULES, PROMOTION_PATTERNS, VIDEO_FORMATS, type AiFormat, type AiLanguage, type AiPlatform, type VideoFormat } from '@touma/shared';
import type { BusinessContext } from './context';
import { collectStrings } from './safety';
import type { ContentPlan, GeneratedContent, Storyboard } from './schemas';

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

// ─── Content plan ─────────────────────────────────────────────────────────────

export interface PlanRequest {
  language: AiLanguage;
  startDate: string;
  days: number;
  postsPerWeek: number;
  platforms: AiPlatform[];
  /** Occasions the merchant supplied: the ONLY holidays or events the plan may use. */
  occasions: Array<{ name: string; date: string; day: number }>;
}

const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Structure, balance and honesty of a plan against what was asked for and the verified business data. */
export function checkContentPlan(plan: ContentPlan, ctx: BusinessContext, req: PlanRequest): string[] {
  const issues: string[] = [];
  if (plan.language !== req.language) issues.push(`language must be ${req.language}`);
  if (plan.startDate !== req.startDate) issues.push(`startDate must be ${req.startDate}`);
  if (plan.days !== req.days) issues.push(`days must be ${req.days}`);

  const target = Math.max(1, Math.round((req.postsPerWeek * req.days) / 7));
  const slack = Math.ceil(target * 0.2) + 1;
  if (plan.items.length < Math.max(1, target - slack) || plan.items.length > target + slack) issues.push(`the plan has ${plan.items.length} posts but about ${target} were requested (${req.postsPerWeek} per week for ${req.days} days)`);

  const itemIds = new Map<string, 'PRODUCT' | 'SERVICE'>([...ctx.products.map((p) => [p.id, 'PRODUCT'] as const), ...ctx.services.map((x) => [x.id, 'SERVICE'] as const)]);
  const known = new Set(req.occasions.map((o) => norm(o.name)));
  const dataText = norm(collectStrings({ b: ctx.business, p: ctx.products, s: ctx.services, k: ctx.knowledge }).join('\n'));
  const seenTitles = new Set<string>();
  const perDay = new Map<string, number>();
  const usedOccasions = new Set<string>();

  plan.items.forEach((it, idx) => {
    const at = `item ${idx + 1}`;
    if (it.day > req.days) issues.push(`${at}: day ${it.day} is outside the ${req.days}-day plan`);
    if (!req.platforms.includes(it.platform)) issues.push(`${at}: platform ${it.platform} was not requested`);
    const key = `${it.platform}:${it.day}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
    const t = norm(`${it.platform}:${it.title}`);
    if (seenTitles.has(t)) issues.push(`${at}: duplicate title "${it.title}" on ${it.platform}`);
    seenTitles.add(t);

    if (it.itemId) {
      const kind = itemIds.get(it.itemId);
      if (!kind) issues.push(`${at}: itemId ${it.itemId} is not an active product or service of this business`);
      else if (kind !== it.itemType) issues.push(`${at}: itemType must be ${kind} for ${it.itemId}`);
    } else if (it.itemType) issues.push(`${at}: itemType needs an itemId`);
    if ((it.pillar === 'PROMOTIONAL' || it.pillar === 'PRODUCT_SHOWCASE') && !it.itemId) issues.push(`${at}: a ${it.pillar} post must be about a product or service of the business`);

    if (it.pillar === 'SEASONAL') {
      const occ = req.occasions.find((o) => norm(o.name) === norm(it.occasion ?? ''));
      if (!occ) issues.push(`${at}: a SEASONAL post must use one of the occasions provided by the merchant (${req.occasions.map((o) => o.name).join(', ') || 'none were provided'})`);
      else {
        usedOccasions.add(norm(occ.name));
        if (it.day !== occ.day) issues.push(`${at}: "${occ.name}" is on day ${occ.day}, not day ${it.day}`);
      }
    } else if (it.occasion) issues.push(`${at}: only SEASONAL posts may name an occasion`);

    const text = `${it.title}\n${it.brief}`;
    const lower = norm(text);
    for (const re of PROMOTION_PATTERNS) {
      const m = re.exec(text);
      if (m && !dataText.includes(norm(m[0]).trim())) issues.push(`${at}: mentions "${m[0].trim()}", a promotion or discount that is not in the verified business data`);
    }
    for (const term of HOLIDAY_TERMS) {
      const n = norm(term);
      if (new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(lower) && !dataText.includes(n) && ![...known].some((k) => k.includes(n) || n.includes(k))) {
        issues.push(`${at}: mentions "${term}", an occasion that the merchant did not provide`);
      }
    }
  });

  for (const [key, n] of perDay) {
    const platform = key.split(':')[0] as AiPlatform;
    if (n > Math.min(2, PLATFORM_RULES[platform].maxPerDay)) issues.push(`too many posts for ${key.replace(':', ' on day ')}`);
  }
  for (const o of req.occasions) if (!usedOccasions.has(norm(o.name))) issues.push(`the occasion "${o.name}" (day ${o.day}) must have a SEASONAL post`);

  if (plan.items.length >= 8) {
    const counts = new Map<string, number>();
    for (const it of plan.items) if (it.pillar !== 'SEASONAL') counts.set(it.pillar, (counts.get(it.pillar) ?? 0) + 1);
    const nonSeasonal = [...counts.values()].reduce((a, b) => a + b, 0);
    if (counts.size < 3) issues.push('the plan must mix at least 3 different content pillars');
    if (nonSeasonal && Math.max(...counts.values()) / nonSeasonal > 0.5) issues.push('no single content pillar may be more than half of the plan');
  }
  issues.push(...checkLanguage(plan.items.map((i) => `${i.title}. ${i.brief}`).join(' '), req.language));
  return issues;
}
