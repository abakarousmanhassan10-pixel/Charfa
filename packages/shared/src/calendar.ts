import type { AiPlatform } from './ai';

/** Content calendar vocabularies and scheduling rules, shared by the API and the web app. */
export const CONTENT_PILLARS = ['PROMOTIONAL', 'EDUCATIONAL', 'PRODUCT_SHOWCASE', 'ENGAGEMENT', 'BRAND_AWARENESS', 'SEASONAL'] as const;
export type ContentPillar = (typeof CONTENT_PILLARS)[number];

export const TIME_SOURCES = ['MANUAL', 'ANALYTICS', 'ESTIMATE'] as const;
export type TimeSource = (typeof TIME_SOURCES)[number];

export const ENTRY_STATUSES = ['DRAFT', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const CONFLICT_CODES = ['SLOT_TOO_CLOSE', 'DAILY_LIMIT', 'PAST_TIME', 'DUPLICATE_PLACEMENT', 'ACCOUNT_NOT_CONNECTED'] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];
/** Hard conflicts block scheduling; soft ones are shown and can be acknowledged. */
export const HARD_CONFLICTS: readonly ConflictCode[] = ['PAST_TIME', 'DUPLICATE_PLACEMENT'];

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const CALENDAR_LIMITS = {
  rangeMaxDays: 45,
  planMinDays: 7,
  planMaxDays: 30,
  postsPerWeekMin: 1,
  postsPerWeekMax: 14,
  planMaxItems: 60,
  occasionsMax: 15,
  recurrenceMaxOccurrences: 60,
  recurrenceMaxDays: 180,
  /** A slot must be at least this far in the future to be authorized. */
  minLeadMinutes: 2,
  titleMax: 150,
  captionMax: 4000,
  briefMax: 600,
} as const;

interface PlatformRule {
  /** Posts to the same account closer than this are flagged as too close. */
  minGapMinutes: number;
  /** More posts than this on one local day are flagged. */
  maxPerDay: number;
  /** General-guidance local posting times. These are ESTIMATES, never audience data. */
  estimate: { weekday: string[]; weekend: string[] };
}

export const PLATFORM_RULES: Record<AiPlatform, PlatformRule> = {
  INSTAGRAM: { minGapMinutes: 180, maxPerDay: 2, estimate: { weekday: ['12:00', '18:00', '20:00'], weekend: ['10:00', '19:00'] } },
  FACEBOOK: { minGapMinutes: 180, maxPerDay: 2, estimate: { weekday: ['09:00', '13:00', '19:00'], weekend: ['10:00', '18:00'] } },
  TIKTOK: { minGapMinutes: 120, maxPerDay: 3, estimate: { weekday: ['18:00', '20:00', '21:00'], weekend: ['11:00', '19:00'] } },
  YOUTUBE: { minGapMinutes: 360, maxPerDay: 1, estimate: { weekday: ['15:00', '17:00'], weekend: ['11:00', '16:00'] } },
};

/** Minimum number of published posts with measured engagement before analytics drive a recommendation. */
export const ANALYTICS_MIN_SAMPLES = 10;

/** Words that point to a holiday, season or promotion. The planner may only use the ones the merchant supplied. */
export const HOLIDAY_TERMS = [
  'ramadan', 'ramadhan', 'eid', 'aid el', 'aïd', 'aid al', 'tabaski', 'christmas', 'noël', 'noel', 'new year', 'nouvel an', 'nouvel-an', 'black friday', 'cyber monday',
  "valentine", "saint-valentin", "mother's day", "mothers day", 'fête des mères', "father's day", 'fête des pères', 'easter', 'pâques', 'ashura', 'mawlid', 'back to school', 'rentrée',
  'independence day', "fête de l'indépendance", 'halloween', 'thanksgiving', 'soldes', 'sales season',
];
/** Promotion claims (discounts, free offers). They may only appear when the business data says the same. */
export const PROMOTION_PATTERNS: RegExp[] = [
  /\b\d{1,3}\s?%/i,
  /\b(discount|sale|on sale|clearance|coupon|promo code|special offer|limited[- ]time|buy one get one|bogo|free shipping|free delivery|giveaway)\b/i,
  /\b(r[ée]duction|remise|promotion|promo|solde|offre sp[ée]ciale|offre limit[ée]e|livraison gratuite|gratuit|jeu concours)\b/i,
];
