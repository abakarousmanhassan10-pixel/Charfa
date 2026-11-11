import { AI_PLATFORMS, AI_TONES } from './ai';

/**
 * Creative Studio vocabulary shared by the API, the worker and the web app: what can be asked for,
 * and the exact pixel sizes behind each choice.
 */

export const IMAGE_TYPES = ['PRODUCT_AD', 'ECOMMERCE_PHOTO', 'LIFESTYLE', 'PROMO_POSTER', 'SOCIAL_GRAPHIC', 'SEASONAL_CAMPAIGN', 'BRAND_VISUAL'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const IMAGE_STYLES = ['PHOTOREALISTIC', 'MINIMAL', 'LUXURY', 'PLAYFUL', 'BOLD', 'NATURAL', 'VINTAGE', 'MODERN', 'ILLUSTRATED'] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];

export const IMAGE_BACKGROUNDS = ['WHITE_STUDIO', 'LIGHT_GRADIENT', 'BRAND_COLOR', 'NATURAL_OUTDOOR', 'HOME_INTERIOR', 'KITCHEN', 'WORKSHOP', 'MARKET', 'CUSTOM'] as const;
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];

export const IMAGE_THEMES = ['NONE', 'RAMADAN', 'EID', 'BLACK_FRIDAY', 'SUMMER', 'WINTER', 'NEW_YEAR', 'VALENTINES', 'MOTHERS_DAY', 'BACK_TO_SCHOOL', 'CUSTOM'] as const;
export type ImageTheme = (typeof IMAGE_THEMES)[number];

export const ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9', '3:4', '4:3'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Long edge in pixels. HD above what a provider renders natively is an upscale and is flagged as such. */
export const RESOLUTIONS = { STANDARD: 1080, HD: 1920 } as const;
export type Resolution = keyof typeof RESOLUTIONS;
export const RESOLUTION_KEYS = Object.keys(RESOLUTIONS) as Resolution[];

export const OVERLAY_POSITIONS = ['TOP', 'CENTER', 'BOTTOM'] as const;
export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];

export const LOGO_PLACEMENTS = ['NONE', 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT'] as const;
export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];

/**
 * EXACT: the merchant's product pixels are cut out and composited onto a generated scene, so the product
 *   is not repainted by the model (needs a plain or transparent background in the photo).
 * GUIDED: the model edits the photo with an instruction to keep the product unchanged. Best effort: review
 *   the result against the original.
 */
export const PRESERVATION_MODES = ['EXACT', 'GUIDED'] as const;
export type PreservationMode = (typeof PRESERVATION_MODES)[number];

export const CREATIVE_PLATFORMS = [...AI_PLATFORMS, 'ANY'] as const;
export type CreativePlatform = (typeof CREATIVE_PLATFORMS)[number];

/** Aspect ratios that suit each platform; the first is the default. */
export const PLATFORM_ASPECTS: Record<CreativePlatform, readonly AspectRatio[]> = {
  INSTAGRAM: ['1:1', '4:5', '9:16'],
  FACEBOOK: ['1:1', '16:9', '4:5'],
  TIKTOK: ['9:16'],
  YOUTUBE: ['16:9'],
  ANY: ['1:1', '4:5', '9:16', '16:9', '3:4', '4:3'],
};

export function parseAspect(a: AspectRatio): { w: number; h: number } {
  const [w, h] = a.split(':').map(Number);
  return { w: w!, h: h! };
}

/** Exact output size for an aspect ratio and resolution (long edge = resolution, even numbers). */
export function dimensionsFor(aspect: AspectRatio, resolution: Resolution): { width: number; height: number } {
  const { w, h } = parseAspect(aspect);
  const long = RESOLUTIONS[resolution];
  const even = (n: number) => 2 * Math.round(n / 2);
  return w >= h ? { width: long, height: even((long * h) / w) } : { width: even((long * w) / h), height: long };
}

export const VIDEO_FORMATS = {
  SHORT_VERTICAL: { aspect: '9:16', label: 'Short vertical (Reels, TikTok, Shorts)', platforms: ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK'], minSeconds: 4, maxSeconds: 60 },
  SQUARE: { aspect: '1:1', label: 'Square (feed)', platforms: ['INSTAGRAM', 'FACEBOOK'], minSeconds: 4, maxSeconds: 30 },
  LANDSCAPE: { aspect: '16:9', label: 'Landscape (YouTube, web)', platforms: ['YOUTUBE', 'FACEBOOK'], minSeconds: 4, maxSeconds: 90 },
} as const satisfies Record<string, { aspect: AspectRatio; label: string; platforms: readonly string[]; minSeconds: number; maxSeconds: number }>;
export type VideoFormat = keyof typeof VIDEO_FORMATS;
export const VIDEO_FORMAT_KEYS = Object.keys(VIDEO_FORMATS) as VideoFormat[];

export const VIDEO_STYLES = ['CINEMATIC', 'UGC', 'MINIMAL', 'ENERGETIC', 'LUXURY', 'DOCUMENTARY'] as const;
export type VideoStyle = (typeof VIDEO_STYLES)[number];

export const BRAND_COLOR_ROLES = ['PRIMARY', 'SECONDARY', 'ACCENT', 'BACKGROUND', 'TEXT'] as const;
export type BrandColorRole = (typeof BRAND_COLOR_ROLES)[number];
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Fonts a brand kit can name. Overlays use the font only when it is installed on the worker; otherwise
 * the generic family (sans-serif / serif) is used, so the choice never breaks rendering.
 */
export const BRAND_FONTS = {
  Inter: 'sans-serif', Poppins: 'sans-serif', Montserrat: 'sans-serif', Roboto: 'sans-serif', 'Open Sans': 'sans-serif', 'Noto Sans': 'sans-serif', Cairo: 'sans-serif',
  'Playfair Display': 'serif', Lora: 'serif', Merriweather: 'serif', Amiri: 'serif', Georgia: 'serif',
  Arial: 'sans-serif', Helvetica: 'sans-serif',
} as const;
export type BrandFont = keyof typeof BRAND_FONTS;
export const BRAND_FONT_NAMES = Object.keys(BRAND_FONTS) as BrandFont[];

export const BRAND_TONES = AI_TONES;

export const CREATIVE_LIMITS = {
  maxImagesPerRequest: 4,
  maxOverlayChars: 120,
  maxGuidelinesChars: 2000,
  maxInstructionChars: 500,
  maxColors: 8,
} as const;
