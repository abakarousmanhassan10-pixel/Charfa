import { FORMAT_RULES, type AiFormat, type AiLanguage, type AiPlatform } from '@touma/shared';
import { type BusinessContext, validSources } from './context';
import type { GeneratedContent } from './schemas';
import { collectStrings } from './safety';

// ─── Grounding (anti-fabrication) ─────────────────────────────────────────────

const CURRENCY = String.raw`(?:XAF|XOF|FCFA|CFA|F\s?CFA|USD|EUR|GBP|TRY|MAD|AED|SAR|CAD|CHF|NGN|DH|TL|€|\$|£|₺|₦)`;
const AMOUNT = String.raw`\d[\d\s.,  ]*\d|\d`;
const MONEY_RE = new RegExp(String.raw`(?:${CURRENCY}\s?(${AMOUNT}))|(?:(${AMOUNT})\s?${CURRENCY})`, 'giu');
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s?%/g;
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;

/** Claim families that are risky to invent. A claim is allowed only if the data mentions the concept. */
const CLAIMS: Array<{ name: string; output: RegExp; evidence: RegExp }> = [
  { name: 'free delivery', output: /free (delivery|shipping)|livraison (gratuite|offerte)|ücretsiz (kargo|teslimat)|(توصيل|شحن) مجاني/i, evidence: /free (delivery|shipping)|livraison (gratuite|offerte)|ücretsiz (kargo|teslimat)|(توصيل|شحن) مجاني|gratuit|free|ücretsiz|مجان/i },
  { name: 'guarantee', output: /guarantee|warranty|garantie|garanti|ضمان/i, evidence: /guarantee|warranty|garantie|garanti|ضمان/i },
  { name: 'refund', output: /money[- ]back|refund|rembours|para iade|استرداد/i, evidence: /money[- ]back|refund|rembours|iade|return|retour|استرداد|إرجاع/i },
  { name: 'certification', output: /certified|certifi[ée]|sertifika|معتمد|organic|biologique|\bbio\b|organik|عضوي/i, evidence: /certif|sertifika|معتمد|organic|biologique|\bbio\b|organik|عضوي/i },
  { name: 'ranking', output: /\b(number one|#1|n°\s?1|no\.\s?1|best in (town|the city|the country)|meilleur(e)? de|le meilleur|en iyi)\b|الأفضل/i, evidence: /award|prix|ödül|جائزة|number one|#1|n°\s?1|best|meilleur|en iyi|الأفضل/i },
  { name: 'award', output: /award[- ]winning|prize[- ]winning|primé|ödüllü|حائز/i, evidence: /award|prix|primé|ödül|جائزة|حائز/i },
];

const digits = (v: string) => v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
/** Numbers as they may appear in the data: "1500", "1500.00" → "1500"; "1 500 XAF" → "1500". */
function numberVariants(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d\s.,  ]*\d|\d/g)) {
    const raw = m[0];
    out.add(digits(raw));
    const noDecimals = raw.replace(/[.,]00?$/, '');
    out.add(digits(noDecimals));
  }
  return out;
}

export interface GroundingOptions {
  /** Fields whose values are source ids, checked against the context instead of as text. */
  sourceFields?: string[];
}

export function checkGrounding(output: unknown, ctx: BusinessContext): string[] {
  const issues: string[] = [];
  const contextText = JSON.stringify({ business: ctx.business, products: ctx.products, services: ctx.services, knowledge: ctx.knowledge });
  const contextLower = contextText.toLowerCase();
  const known = numberVariants(contextText);
  const sources = validSources(ctx);
  const text = collectStrings(stripSourceFields(output)).join('\n');

  for (const m of text.matchAll(MONEY_RE)) {
    const amount = m[1] ?? m[2] ?? '';
    const d = digits(amount.replace(/[.,]00?$/, ''));
    if (d && !known.has(d) && !known.has(digits(amount))) issues.push(`Unsupported price or amount "${m[0].trim()}": not present in the business data`);
  }
  for (const m of text.matchAll(PERCENT_RE)) {
    if (!known.has(digits(m[1]!))) issues.push(`Unsupported percentage "${m[0]}": not present in the business data`);
  }
  for (const c of CLAIMS) {
    if (c.output.test(text) && !c.evidence.test(contextText)) issues.push(`Unsupported claim (${c.name}): the business data does not mention it`);
  }
  for (const m of text.matchAll(URL_RE)) {
    if (!contextLower.includes(m[0].toLowerCase().replace(/[.,;:!?]+$/, ''))) issues.push(`URL not present in the business data: ${m[0]}`);
  }
  for (const src of collectSources(output)) {
    if (!sources.has(src)) issues.push(`Unknown source "${src}": cite only ids present in the business data`);
  }
  if (/<\/?business_data>|NON-NEGOTIABLE RULES|sk-[A-Za-z0-9]{16,}/.test(text)) issues.push('Output leaks internal instructions or secrets');
  return [...new Set(issues)];
}

const SOURCE_KEYS = new Set(['source', 'relatedSources']);

function stripSourceFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSourceFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SOURCE_KEYS.has(k)).map(([k, v]) => [k, stripSourceFields(v)]));
  }
  return value;
}

function collectSources(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectSources(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'source' && typeof v === 'string') out.push(v);
      else if (k === 'relatedSources' && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && out.push(x));
      else collectSources(v, out);
    }
  }
  return out;
}

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
