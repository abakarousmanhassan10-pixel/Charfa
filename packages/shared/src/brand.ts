/**
 * Single source of truth for brand identity. Import this instead of hard-coding names
 * (web metadata, UI, API docs, transactional emails).
 */
export const BRAND = {
  /** Official SaaS brand name. */
  name: 'TOUMA',
  /** Product name. */
  productName: 'TOUMA AI',
  /** Internal project name (package scope @touma/*). */
  internalName: 'TOUMA',
  slogan: {
    en: 'Your Business. Your AI Marketing Team.',
    fr: 'Votre entreprise. Votre équipe marketing IA.',
  },
  /** Brand colours used where CSS variables are unavailable (e.g. email clients). */
  colors: { primary: '#4f46e5', primaryForeground: '#ffffff', text: '#1e2130', muted: '#6b7085', border: '#e5e7ef' },
} as const;

export type BrandLocale = keyof typeof BRAND.slogan;

export function brandSlogan(locale: string): string {
  return BRAND.slogan[(locale in BRAND.slogan ? locale : 'en') as BrandLocale];
}
