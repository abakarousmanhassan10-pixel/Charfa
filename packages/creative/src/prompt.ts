import type { AspectRatio, ImageBackground, ImageStyle, ImageTheme, ImageType, CreativePlatform, VideoStyle } from '@touma/shared';

/** Untrusted merchant text goes into provider prompts: strip control characters and markup, collapse whitespace, cap length. */
export function clean(value: string | null | undefined, max = 300): string {
  return (value ?? '')
    // eslint-disable-next-line no-control-regex, no-irregular-whitespace -- stripping control and bidi characters is the point
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/[<>{}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface PromptBrand {
  colors: Array<{ name: string; hex: string; role: string }>;
  visualStyle?: string | null;
  guidelines?: string | null;
}

export interface PromptItem {
  kind: 'PRODUCT' | 'SERVICE';
  name: string;
  description?: string | null;
  features: string[];
  benefits: string[];
  category?: string | null;
}

export interface PromptBusiness {
  name: string;
  type?: string | null;
  industry?: string | null;
  description?: string | null;
  city?: string | null;
}

/**
 * How the image is produced:
 *  TEXT_TO_IMAGE  the model draws the whole picture (no photo supplied: the product is only an illustration)
 *  SCENE_ONLY     the model draws an empty scene; TOUMA composites the merchant's real product onto it (EXACT)
 *  EDIT           the model edits the merchant's photo and is told to keep the product unchanged (GUIDED)
 */
export type PromptMode = 'TEXT_TO_IMAGE' | 'SCENE_ONLY' | 'EDIT';

export interface ImagePromptInput {
  mode: PromptMode;
  business: PromptBusiness;
  item?: PromptItem | null;
  type: ImageType;
  style: ImageStyle;
  background: ImageBackground;
  backgroundNote?: string | null;
  theme: ImageTheme;
  themeNote?: string | null;
  platform: CreativePlatform;
  aspect: AspectRatio;
  brand?: PromptBrand | null;
  instructions?: string | null;
  /** Text will be added by TOUMA afterwards: leave a calm area for it. */
  hasOverlay: boolean;
}

const TYPE_BRIEF: Record<ImageType, string> = {
  PRODUCT_AD: 'A professional advertisement for the product: striking, clean composition, the product is the hero',
  ECOMMERCE_PHOTO: 'An e-commerce product photograph: evenly lit, sharp, accurate colours, neutral and uncluttered',
  LIFESTYLE: 'A lifestyle image showing the product in a natural, believable everyday setting',
  PROMO_POSTER: 'A promotional poster layout: bold visual hierarchy with generous space for headline text',
  SOCIAL_GRAPHIC: 'An eye-catching social media graphic, built to stop the scroll on a phone screen',
  SEASONAL_CAMPAIGN: 'A seasonal campaign visual with a festive atmosphere that supports the product',
  BRAND_VISUAL: 'A brand promotional visual that conveys the identity and mood of the business',
};

const STYLE_BRIEF: Record<ImageStyle, string> = {
  PHOTOREALISTIC: 'photorealistic, natural lighting',
  MINIMAL: 'minimalist, lots of negative space, restrained palette',
  LUXURY: 'premium and elegant, soft dramatic lighting, rich materials',
  PLAYFUL: 'playful and colourful, lively energy',
  BOLD: 'bold, high contrast, strong colour blocking',
  NATURAL: 'natural and organic, soft daylight, earthy tones',
  VINTAGE: 'vintage, warm film tones, nostalgic',
  MODERN: 'modern and clean, crisp lines, contemporary',
  ILLUSTRATED: 'stylised illustration, clean shapes',
};

const BACKGROUND_BRIEF: Record<ImageBackground, string> = {
  WHITE_STUDIO: 'a seamless white studio backdrop with a soft floor shadow',
  LIGHT_GRADIENT: 'a smooth light gradient backdrop',
  BRAND_COLOR: 'a clean backdrop in the brand colours',
  NATURAL_OUTDOOR: 'a natural outdoor setting with soft light',
  HOME_INTERIOR: 'a bright, tasteful home interior',
  KITCHEN: 'a warm kitchen or dining setting',
  WORKSHOP: 'a craft workshop or studio setting',
  MARKET: 'a lively market or shopfront setting',
  CUSTOM: 'the setting described below',
};

const THEME_BRIEF: Record<ImageTheme, string> = {
  NONE: '',
  RAMADAN: 'Ramadan: warm lantern light, crescent and star motifs, an evening atmosphere (respectful, no people praying)',
  EID: 'Eid celebration: festive, joyful, elegant gold accents',
  BLACK_FRIDAY: 'Black Friday sale mood: dark, high-contrast, energetic',
  SUMMER: 'summer: bright sun, fresh and airy',
  WINTER: 'winter: cosy, cool light with warm accents',
  NEW_YEAR: 'New Year celebration: sparkle, midnight tones',
  VALENTINES: "Valentine's Day: romantic, soft reds and pinks",
  MOTHERS_DAY: "Mother's Day: tender, floral, warm",
  BACK_TO_SCHOOL: 'back to school: fresh, bright, youthful',
  CUSTOM: '',
};

const PLATFORM_BRIEF: Record<CreativePlatform, string> = {
  INSTAGRAM: 'Designed for Instagram',
  FACEBOOK: 'Designed for Facebook',
  TIKTOK: 'Designed for TikTok',
  YOUTUBE: 'Designed for YouTube',
  ANY: '',
};

function brandLine(brand?: PromptBrand | null): string {
  if (!brand) return '';
  const colors = brand.colors.slice(0, 6).map((c) => `${clean(c.role, 12).toLowerCase()} ${c.hex}`);
  return [colors.length ? `Brand colour palette: ${colors.join(', ')}.` : '', brand.visualStyle ? `Brand visual style: ${clean(brand.visualStyle, 60)}.` : '', brand.guidelines ? `Brand guidelines: ${clean(brand.guidelines, 400)}` : ''].filter(Boolean).join(' ');
}

function itemLine(item?: PromptItem | null): string {
  if (!item) return '';
  const bits = [`${item.kind === 'PRODUCT' ? 'Product' : 'Service'}: ${clean(item.name, 120)}.`];
  if (item.category) bits.push(`Category: ${clean(item.category, 60)}.`);
  if (item.description) bits.push(`Description: ${clean(item.description, 400)}`);
  if (item.features.length) bits.push(`Features: ${item.features.slice(0, 6).map((f) => clean(f, 80)).join('; ')}.`);
  if (item.benefits.length) bits.push(`Benefits: ${item.benefits.slice(0, 4).map((f) => clean(f, 80)).join('; ')}.`);
  return bits.join(' ');
}

/**
 * Builds the provider prompt from verified facts only. It never states prices, discounts or claims, and it asks the
 * model not to draw any text: words are added afterwards by TOUMA from the merchant's own text, so they are never
 * misspelled or invented by the model.
 */
export function buildImagePrompt(i: ImagePromptInput): string {
  const parts: string[] = [];
  const setting = i.background === 'CUSTOM' && i.backgroundNote ? clean(i.backgroundNote, 200) : BACKGROUND_BRIEF[i.background];
  const theme = i.theme === 'CUSTOM' ? clean(i.themeNote, 120) : THEME_BRIEF[i.theme];
  const composition = [`${TYPE_BRIEF[i.type]}.`, `Style: ${STYLE_BRIEF[i.style]}.`, `Setting: ${setting}.`, theme ? `Theme: ${theme}.` : '', `Aspect ratio ${i.aspect}.`, PLATFORM_BRIEF[i.platform] ? `${PLATFORM_BRIEF[i.platform]}.` : ''].filter(Boolean).join(' ');

  if (i.mode === 'SCENE_ONLY') {
    parts.push(`An empty background scene for a product photo. ${composition}`);
    parts.push('There is NO product, NO people and NO objects in the middle of the frame: keep the centre and lower-centre clear and uncluttered, as a place where a product will be added later. Natural perspective, soft light that would suit an object placed in the middle.');
  } else if (i.mode === 'EDIT') {
    parts.push(`Edit this product photo. KEEP THE PRODUCT EXACTLY AS IT IS: the same shape, proportions, colours, materials, label, logo and any printed text. Do not redraw, restyle, recolour, resize or replace the product. Change only what surrounds it. ${composition}`);
    parts.push(itemLine(i.item));
  } else {
    parts.push(composition);
    parts.push(itemLine(i.item));
    parts.push('Depict the product plausibly from this description only. Do not invent packaging, brand names, logos or printed text.');
  }
  parts.push(`Business: ${clean(i.business.name, 100)}${i.business.industry ? ` (${clean(i.business.industry, 60)})` : ''}.`);
  const brand = brandLine(i.brand);
  if (brand) parts.push(brand);
  if (i.hasOverlay) parts.push('Leave a calm, uncluttered area (top or bottom) where text will be added afterwards.');
  parts.push('Do NOT draw any words, letters, numbers, logos or watermarks anywhere in the image.');
  if (i.instructions) parts.push(`Additional guidance from the merchant: ${clean(i.instructions, 300)}`);
  return parts.filter(Boolean).join(' ');
}

// ─── Video ────────────────────────────────────────────────────────────────────

const VIDEO_STYLE_BRIEF: Record<VideoStyle, string> = {
  CINEMATIC: 'cinematic, shallow depth of field, smooth camera moves',
  UGC: 'authentic handheld phone footage, natural and unpolished',
  MINIMAL: 'clean minimalist shots, calm pacing',
  ENERGETIC: 'fast, energetic cuts and movement',
  LUXURY: 'slow, elegant, premium lighting',
  DOCUMENTARY: 'documentary style, honest and observational',
};

export interface VideoPromptInput {
  business: PromptBusiness;
  item?: PromptItem | null;
  style: VideoStyle;
  aspect: AspectRatio;
  seconds: number;
  brand?: PromptBrand | null;
  instructions?: string | null;
  /** Condensed concept from a storyboard (already grounded in verified facts), or the scene being rendered. */
  storyboard?: { title: string; concept?: string | null; scenes: Array<{ order: number; durationSeconds: number; visual: string; camera?: string | null }> } | null;
  sceneOrder?: number | null;
}

export function buildVideoPrompt(i: VideoPromptInput): string {
  const parts = [`A ${i.seconds}-second ${VIDEO_STYLE_BRIEF[i.style]} promotional video, ${i.aspect} frame.`];
  if (i.storyboard) {
    const scenes = i.sceneOrder ? i.storyboard.scenes.filter((s) => s.order === i.sceneOrder) : i.storyboard.scenes;
    if (i.storyboard.concept && !i.sceneOrder) parts.push(`Concept: ${clean(i.storyboard.concept, 300)}`);
    parts.push(scenes.map((s) => `Scene ${s.order} (${s.durationSeconds}s): ${clean(s.visual, 300)}${s.camera ? ` Camera: ${clean(s.camera, 100)}.` : ''}`).join(' '));
  }
  parts.push(itemLine(i.item));
  parts.push(`Business: ${clean(i.business.name, 100)}.`);
  const brand = brandLine(i.brand);
  if (brand) parts.push(brand);
  parts.push('Show the product faithfully as described. Do not invent prices, claims, brand names or on-screen text.');
  if (i.instructions) parts.push(`Additional guidance from the merchant: ${clean(i.instructions, 300)}`);
  return parts.filter(Boolean).join(' ');
}
