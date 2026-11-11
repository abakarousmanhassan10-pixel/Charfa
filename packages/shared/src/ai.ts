/**
 * TOUMA AI shared vocabulary: platforms, formats, tones, languages and platform limits.
 * The API validates every AI output against these rules; the web uses them to build selectors.
 */
export const AI_PLATFORMS = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE'] as const;
export type AiPlatform = (typeof AI_PLATFORMS)[number];

/** Languages TOUMA AI can write content in (independent of the UI languages). */
export const AI_LANGUAGES = ['en', 'fr', 'tr', 'ar'] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];
export const AI_LANGUAGE_NAMES: Record<AiLanguage, string> = { en: 'English', fr: 'Français', tr: 'Türkçe', ar: 'العربية' };

export const AI_TONES = ['PROFESSIONAL', 'FRIENDLY', 'PLAYFUL', 'INSPIRATIONAL', 'LUXURY', 'EDUCATIONAL', 'URGENT'] as const;
export type AiTone = (typeof AI_TONES)[number];

/** Purpose of the content (the "content type" selector). */
export const AI_CONTENT_PURPOSES = ['PROMOTIONAL', 'EDUCATIONAL', 'ANNOUNCEMENT', 'ENGAGEMENT', 'STORYTELLING', 'TESTIMONIAL_REQUEST'] as const;
export type AiContentPurpose = (typeof AI_CONTENT_PURPOSES)[number];

/** Output formats. Platform-specific formats plus platform-independent copy. */
export const AI_FORMATS = [
  'INSTAGRAM_CAPTION',
  'INSTAGRAM_REEL_SCRIPT',
  'INSTAGRAM_STORY',
  'INSTAGRAM_CAROUSEL',
  'FACEBOOK_PROMOTIONAL_POST',
  'FACEBOOK_EDUCATIONAL_POST',
  'FACEBOOK_PRODUCT_ANNOUNCEMENT',
  'TIKTOK_VIDEO_SCRIPT',
  'YOUTUBE_VIDEO',
  'YOUTUBE_SHORTS_SCRIPT',
  'PRODUCT_DESCRIPTION',
  'AD_COPY',
  'PROMOTIONAL_MESSAGE',
] as const;
export type AiFormat = (typeof AI_FORMATS)[number];

export interface FormatRule {
  platform: AiPlatform | null;
  /** Which output sections are required for this format. */
  requires: Array<'caption' | 'title' | 'description' | 'slides' | 'scenes' | 'storyFrames' | 'hook'>;
  maxCaptionChars: number;
  maxTitleChars?: number;
  maxDescriptionChars?: number;
  maxHashtags: number;
  slides?: { min: number; max: number };
  storyFrames?: { min: number; max: number };
  /** Total scene duration bounds for video scripts, in seconds. */
  durationSeconds?: { min: number; max: number };
  guidance: string;
}

/**
 * Limits follow each platform's published constraints (with conservative values where platforms
 * have changed limits over time). Keep in sync with docs/AI.md.
 */
export const FORMAT_RULES: Record<AiFormat, FormatRule> = {
  INSTAGRAM_CAPTION: { platform: 'INSTAGRAM', requires: ['caption'], maxCaptionChars: 2200, maxHashtags: 30, guidance: 'Feed post caption. Strong first line (shown before "more"), line breaks for readability, emojis sparingly, 3–15 relevant hashtags.' },
  INSTAGRAM_REEL_SCRIPT: { platform: 'INSTAGRAM', requires: ['hook', 'scenes', 'caption'], maxCaptionChars: 2200, maxHashtags: 30, durationSeconds: { min: 7, max: 90 }, guidance: 'Vertical 9:16 Reel. Hook in the first 2 seconds, fast scenes, on-screen text, ends with a call to action.' },
  INSTAGRAM_STORY: { platform: 'INSTAGRAM', requires: ['storyFrames'], maxCaptionChars: 500, maxHashtags: 5, storyFrames: { min: 1, max: 10 }, guidance: 'Sequence of 15-second story frames with short text, one idea per frame, interactive sticker ideas (poll, question, link).' },
  INSTAGRAM_CAROUSEL: { platform: 'INSTAGRAM', requires: ['slides', 'caption'], maxCaptionChars: 2200, maxHashtags: 30, slides: { min: 2, max: 10 }, guidance: 'Swipeable carousel: cover slide with a promise, one point per slide, last slide = call to action.' },
  FACEBOOK_PROMOTIONAL_POST: { platform: 'FACEBOOK', requires: ['caption'], maxCaptionChars: 5000, maxHashtags: 5, guidance: 'Promotional Facebook post: clear offer, why it matters, how to buy or contact. Few or no hashtags.' },
  FACEBOOK_EDUCATIONAL_POST: { platform: 'FACEBOOK', requires: ['caption'], maxCaptionChars: 5000, maxHashtags: 5, guidance: 'Educational Facebook post: useful tips related to the business, conversational, invites comments.' },
  FACEBOOK_PRODUCT_ANNOUNCEMENT: { platform: 'FACEBOOK', requires: ['title', 'caption'], maxCaptionChars: 5000, maxTitleChars: 120, maxHashtags: 5, guidance: 'Product announcement: headline, what it is, verified benefits, availability and how to get it.' },
  TIKTOK_VIDEO_SCRIPT: { platform: 'TIKTOK', requires: ['hook', 'scenes', 'caption'], maxCaptionChars: 2200, maxHashtags: 8, durationSeconds: { min: 7, max: 60 }, guidance: 'Short vertical TikTok video. Hook in the first second, authentic tone, trends only if relevant, scene by scene with on-screen text.' },
  YOUTUBE_VIDEO: { platform: 'YOUTUBE', requires: ['title', 'description'], maxCaptionChars: 5000, maxTitleChars: 100, maxDescriptionChars: 5000, maxHashtags: 15, guidance: 'YouTube video metadata: searchable title (max 100 chars), description with a summary in the first 2 lines, chapters ideas, links placeholders, 3–15 hashtags.' },
  YOUTUBE_SHORTS_SCRIPT: { platform: 'YOUTUBE', requires: ['title', 'hook', 'scenes'], maxCaptionChars: 1000, maxTitleChars: 100, maxHashtags: 15, durationSeconds: { min: 7, max: 60 }, guidance: 'YouTube Short: vertical, under 60 seconds, immediate hook, loopable ending.' },
  PRODUCT_DESCRIPTION: { platform: null, requires: ['title', 'description'], maxCaptionChars: 1000, maxTitleChars: 150, maxDescriptionChars: 3000, maxHashtags: 0, guidance: 'Product page description: benefit-led, scannable, only verified specifications.' },
  AD_COPY: { platform: null, requires: ['title', 'caption'], maxCaptionChars: 600, maxTitleChars: 60, maxHashtags: 0, guidance: 'Paid ad copy: short headline, primary text focused on one benefit, explicit call to action. No hashtags.' },
  PROMOTIONAL_MESSAGE: { platform: null, requires: ['caption'], maxCaptionChars: 700, maxHashtags: 0, guidance: 'Short promotional message for WhatsApp/SMS/broadcast: friendly, one offer, one call to action, no hashtags.' },
};

export const FORMATS_BY_PLATFORM: Record<AiPlatform | 'ANY', AiFormat[]> = {
  INSTAGRAM: ['INSTAGRAM_CAPTION', 'INSTAGRAM_REEL_SCRIPT', 'INSTAGRAM_STORY', 'INSTAGRAM_CAROUSEL'],
  FACEBOOK: ['FACEBOOK_PROMOTIONAL_POST', 'FACEBOOK_EDUCATIONAL_POST', 'FACEBOOK_PRODUCT_ANNOUNCEMENT'],
  TIKTOK: ['TIKTOK_VIDEO_SCRIPT'],
  YOUTUBE: ['YOUTUBE_VIDEO', 'YOUTUBE_SHORTS_SCRIPT'],
  ANY: ['PRODUCT_DESCRIPTION', 'AD_COPY', 'PROMOTIONAL_MESSAGE'],
};

export const AI_TASKS = ['BUSINESS_ANALYSIS', 'PRODUCT_ANALYSIS', 'MARKETING_STRATEGY', 'CONTENT', 'STORYBOARD', 'CONTENT_PLAN'] as const;
export type AiTask = (typeof AI_TASKS)[number];
