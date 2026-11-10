import { z } from 'zod';
import type { BusinessType } from './business.schemas';

export const PRODUCT_AVAILABILITY = ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'MADE_TO_ORDER', 'DISCONTINUED'] as const;
export const SERVICE_AVAILABILITY = ['AVAILABLE', 'BY_APPOINTMENT', 'UNAVAILABLE'] as const;
export const CATALOG_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export const CATEGORY_KINDS = ['PRODUCT', 'SERVICE'] as const;
export const KNOWLEDGE_CATEGORIES = [
  'COMPANY',
  'PRODUCT',
  'SERVICE',
  'PRICING',
  'DELIVERY_POLICY',
  'RETURN_POLICY',
  'FAQ',
  'CUSTOMER_SUPPORT',
  'OTHER',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** Money is exchanged as a decimal string (never a float): up to 10 integer digits, 2 decimals. */
export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
export const moneySchema = z.string().trim().regex(MONEY_PATTERN, 'Use a positive amount like 19.99');

/** Compares two decimal strings exactly (no floating point). */
export function compareMoney(a: string, b: string): number {
  const norm = (v: string) => {
    const [i = '0', f = ''] = v.split('.');
    return [i.replace(/^0+(?=\d)/, ''), (f + '00').slice(0, 2)] as const;
  };
  const [ai, af] = norm(a);
  const [bi, bf] = norm(b);
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  const ca = ai + af;
  const cb = bi + bf;
  return ca === cb ? 0 : ca < cb ? -1 : 1;
}

export const LIST_ITEM_MAX = 20;
export const LIST_ITEM_LENGTH = 200;

const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v === '' ? undefined : v));
const list = z
  .array(z.string().trim().min(1).max(LIST_ITEM_LENGTH))
  .max(LIST_ITEM_MAX)
  .default([]);

export const productInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: optText(5000),
    categoryId: z.string().optional().transform((v) => (v === '' ? undefined : v)),
    price: moneySchema.optional().or(z.literal('').transform(() => undefined)),
    discountPrice: moneySchema.optional().or(z.literal('').transform(() => undefined)),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
    sku: optText(64),
    stockQuantity: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    availability: z.enum(PRODUCT_AVAILABILITY).default('IN_STOCK'),
    status: z.enum(CATALOG_STATUSES).default('DRAFT'),
    features: list,
    benefits: list,
    targetAudience: optText(2000),
    url: optText(2048).refine((v) => v === undefined || /^https?:\/\/\S+$/i.test(v), 'URL must start with http(s)://'),
  })
  .superRefine((v, ctx) => {
    if (v.discountPrice !== undefined) {
      if (v.price === undefined) ctx.addIssue({ code: 'custom', path: ['discountPrice'], message: 'Set a regular price first' });
      else if (compareMoney(v.discountPrice, v.price) >= 0)
        ctx.addIssue({ code: 'custom', path: ['discountPrice'], message: 'Discount price must be lower than the price' });
    }
  });
export type ProductInput = z.infer<typeof productInputSchema>;

export const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: optText(5000),
  categoryId: z.string().optional().transform((v) => (v === '' ? undefined : v)),
  price: moneySchema.optional().or(z.literal('').transform(() => undefined)),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  durationMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30).optional(),
  availability: z.enum(SERVICE_AVAILABILITY).default('AVAILABLE'),
  availabilityNotes: optText(500),
  bookingInfo: optText(2000),
  bookingUrl: optText(2048).refine((v) => v === undefined || /^https?:\/\/\S+$/i.test(v), 'URL must start with http(s)://'),
  status: z.enum(CATALOG_STATUSES).default('DRAFT'),
  features: list,
  benefits: list,
  targetAudience: optText(2000),
});
export type ServiceInput = z.infer<typeof serviceInputSchema>;

// ─── Default categories (industry templates) ──────────────────────────────────

type Tpl = Array<[en: string, fr: string]>;

const PRODUCT_TEMPLATES: Partial<Record<BusinessType, Tpl>> = {
  ECOMMERCE: [['Clothing', 'Vêtements'], ['Accessories', 'Accessoires'], ['Electronics', 'Électronique'], ['Home', 'Maison'], ['Beauty', 'Beauté']],
  RESTAURANT: [['Starters', 'Entrées'], ['Main dishes', 'Plats'], ['Desserts', 'Desserts'], ['Drinks', 'Boissons'], ['Menus & combos', 'Menus & formules']],
  RETAIL_STORE: [['New arrivals', 'Nouveautés'], ['Best sellers', 'Meilleures ventes'], ['Promotions', 'Promotions'], ['Essentials', 'Essentiels']],
  BRAND: [['Core collection', 'Collection principale'], ['Limited editions', 'Éditions limitées'], ['Bundles', 'Coffrets']],
  SMALL_BUSINESS: [['Products', 'Produits'], ['Promotions', 'Promotions']],
};

const SERVICE_TEMPLATES: Partial<Record<BusinessType, Tpl>> = {
  RESTAURANT: [['Delivery', 'Livraison'], ['Catering', 'Traiteur'], ['Private events', 'Événements privés']],
  AGENCY: [['Strategy', 'Stratégie'], ['Design', 'Design'], ['Content', 'Contenu'], ['Advertising', 'Publicité']],
  FREELANCER: [['Consulting', 'Conseil'], ['Projects', 'Projets'], ['Training', 'Formation']],
  SERVICE_PROVIDER: [['Consultation', 'Consultation'], ['Installation', 'Installation'], ['Maintenance', 'Maintenance'], ['Support', 'Assistance']],
  SMALL_BUSINESS: [['Services', 'Services']],
  RETAIL_STORE: [['Delivery', 'Livraison'], ['After-sales service', 'Service après-vente']],
  ECOMMERCE: [['Shipping', 'Expédition'], ['Gift wrapping', 'Emballage cadeau']],
};

const GENERIC: Record<'PRODUCT' | 'SERVICE', Tpl> = {
  PRODUCT: [['General', 'Général']],
  SERVICE: [['General', 'Général']],
};

export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'category'
  );
}

/** Default categories for a business type, in the business's language (EN fallback). */
export function defaultCategories(type: BusinessType, kind: 'PRODUCT' | 'SERVICE', locale: string) {
  const tpl = (kind === 'PRODUCT' ? PRODUCT_TEMPLATES : SERVICE_TEMPLATES)[type] ?? GENERIC[kind];
  return tpl.map(([en, fr], i) => {
    const name = locale === 'fr' ? fr : en;
    return { name, slug: slugify(en), sortOrder: i };
  });
}

// ─── Media rules ──────────────────────────────────────────────────────────────

export const MEDIA_RULES = {
  'image/jpeg': { type: 'IMAGE', ext: 'jpg' },
  'image/png': { type: 'IMAGE', ext: 'png' },
  'image/webp': { type: 'IMAGE', ext: 'webp' },
  'image/gif': { type: 'IMAGE', ext: 'gif' },
  'video/mp4': { type: 'VIDEO', ext: 'mp4' },
  'video/quicktime': { type: 'VIDEO', ext: 'mov' },
  'video/webm': { type: 'VIDEO', ext: 'webm' },
} as const;
export type AllowedMimeType = keyof typeof MEDIA_RULES;
export const ALLOWED_MIME_TYPES = Object.keys(MEDIA_RULES) as AllowedMimeType[];
/** Defaults; the API enforces its own configured limits (MEDIA_MAX_IMAGE_MB / MEDIA_MAX_VIDEO_MB). */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export function isAllowedMime(mime: string): mime is AllowedMimeType {
  return mime in MEDIA_RULES;
}
