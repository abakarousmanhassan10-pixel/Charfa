import { z } from 'zod';
import { SUPPORTED_LOCALES } from './i18n';

export const BUSINESS_TYPES = [
  'ECOMMERCE',
  'RESTAURANT',
  'RETAIL_STORE',
  'SMALL_BUSINESS',
  'BRAND',
  'AGENCY',
  'FREELANCER',
  'SERVICE_PROVIDER',
  'OTHER',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Common currencies offered in the UI. The API accepts any valid ISO 4217 code. */
export const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'XAF', 'XOF', 'MAD', 'TRY', 'AED', 'SAR', 'CAD', 'CHF', 'NGN'] as const;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

export const businessInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(BUSINESS_TYPES),
  description: optionalText(2000),
  website: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || /^https?:\/\/[^\s]+$/i.test(v), { message: 'Website must start with http:// or https://' }),
  industry: optionalText(120),
  city: optionalText(120),
  address: optionalText(300),
  contactEmail: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => (v === '' ? undefined : v?.toLowerCase()))
    .refine((v) => v === undefined || z.string().email().safeParse(v).success, { message: 'Invalid email address' }),
  contactPhone: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || /^\+?[0-9 ().-]{6,32}$/.test(v), { message: 'Invalid phone number' }),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a 2-letter country code')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  defaultLocale: z.enum(SUPPORTED_LOCALES).default('en'),
  timezone: z.string().refine(isValidTimezone, { message: 'Invalid timezone' }).default('UTC'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD'),
  brandVoice: optionalText(2000),
  targetAudience: optionalText(2000),
  objectives: optionalText(2000),
});
export type BusinessInput = z.infer<typeof businessInputSchema>;
