import { utcToZoned } from './timezone';
import type { ContentKind } from './social';

/**
 * Publishing policy vocabulary (N21). Pure functions: no I/O, no platform contact.
 * MANUAL = a person decides and schedules every post (the safe default and the fallback).
 * HYBRID = routine posts may be scheduled by the policy, anything risky waits for a person.
 * AUTO   = every post that passes the checks is scheduled by the policy; only hard-sensitive content waits for a person; BLOCKED never goes out.
 */
export const PUBLISHING_MODES = ['MANUAL', 'HYBRID', 'AUTO'] as const;
export type PublishingMode = (typeof PUBLISHING_MODES)[number];

/** Version of the consent text the person accepted. A new version needs a new consent before AUTO/HYBRID can run again. */
export const CONSENT_VERSION = '2026-11-v1';

export const RISK_CLASSES = ['LOW_RISK', 'REVIEW_REQUIRED', 'BLOCKED'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** What the platform's own rules allow, as far as TOUMA read them in official documentation. Nothing here was tested against a real platform. */
export interface PlatformAutomationFacts {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | 'MOCK';
  /** TOUMA has an adapter that publishes through the official API. */
  adapter: 'IMPLEMENTED' | 'TEST_ONLY';
  /** The platform requires the person to confirm choices for EACH post: automation must stop and ask. */
  perPostConfirmation: boolean;
  /** Scopes TOUMA requests (least privilege). */
  scopes: readonly string[];
  /** Content kinds the official API can publish (from TOUMA's platform limits). */
  contentKinds: readonly ContentKind[];
  limitations: string;
  consent: string;
}

export const PLATFORM_AUTOMATION: Record<PlatformAutomationFacts['platform'], PlatformAutomationFacts> = {
  INSTAGRAM: {
    platform: 'INSTAGRAM', adapter: 'IMPLEMENTED', perPostConfirmation: false,
    scopes: ['instagram_content_publish', 'instagram_basic', 'pages_show_list'],
    contentKinds: ['IMAGE', 'CAROUSEL', 'VIDEO'],
    limitations: 'Business/Creator account linked to a Page. Needs Meta app review for public use; in development mode only people with a role on the app can connect. Publishing limits per account are set by Meta and were not verified here.',
    consent: 'The account owner grants TOUMA the publishing permissions in Meta\'s own consent screen.',
  },
  TIKTOK: {
    platform: 'TIKTOK', adapter: 'IMPLEMENTED', perPostConfirmation: true,
    scopes: ['video.publish', 'video.upload', 'user.info.basic'],
    contentKinds: ['VIDEO'],
    limitations: 'Content Posting API: the person must choose privacy, interaction and commercial-content settings and confirm the music/branded-content declarations for every post. Unaudited apps can only post privately. TOUMA never fills these in on the person\'s behalf.',
    consent: 'Per post, in TOUMA, mirroring TikTok\'s posting screen (privacy, interactions, commercial disclosure, confirmation).',
  },
  YOUTUBE: {
    platform: 'YOUTUBE', adapter: 'IMPLEMENTED', perPostConfirmation: false,
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    contentKinds: ['VIDEO'],
    limitations: 'Uploads by unaudited API projects are locked to private until Google\'s compliance audit; default quota 10,000 units per day per project (an upload costs far more than a read). Sensitive scope: OAuth consent-screen verification needed.',
    consent: 'The channel owner grants the upload scope in Google\'s consent screen.',
  },
  MOCK: {
    platform: 'MOCK', adapter: 'TEST_ONLY', perPostConfirmation: false, scopes: ['all'], contentKinds: ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'],
    limitations: 'Test-only simulator (refused outside APP_ENV=test). Nothing is posted anywhere.', consent: 'None: simulated.',
  },
};

export const AUTOMATION_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const;
export const platformFacts = (platform: string): PlatformAutomationFacts | null => (PLATFORM_AUTOMATION as Record<string, PlatformAutomationFacts>)[platform] ?? null;

// ─── Publishing hours ──────────────────────────────────────────────────────

export interface HoursWindow { /** 0 = Sunday … 6 = Saturday */ days: number[]; from: string; to: string }
export const DEFAULT_HOURS: HoursWindow[] = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateHours(hours: unknown): hours is HoursWindow[] {
  return Array.isArray(hours) && hours.length > 0 && hours.length <= 14 && hours.every((w) => w && Array.isArray(w.days) && w.days.length > 0 && w.days.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) && typeof w.from === 'string' && typeof w.to === 'string' && HHMM.test(w.from) && HHMM.test(w.to) && w.from < w.to);
}

/** True when the instant, read in the policy's timezone, falls inside one of the windows. */
export function withinHours(at: Date, tz: string, hours: HoursWindow[]): boolean {
  const l = utcToZoned(at, tz);
  return hours.some((w) => w.days.includes(l.weekday) && l.time >= w.from && l.time < w.to);
}

// ─── Risk classification ───────────────────────────────────────────────────

export interface ClassifyInput {
  mode: PublishingMode;
  platform: string;
  contentKind: ContentKind;
  title?: string | null;
  caption?: string | null;
  hashtags?: string[];
  callToAction?: string | null;
  /** The content the agent grounded against the verified business data had unverified claims. */
  groundingIssues?: number;
  /** Policy settings. */
  allowedContentTypes: readonly string[];
  scheduledAt: Date;
  timezone: string;
  hours: HoursWindow[];
  /** Posts already scheduled/published that local day for this account, excluding this one. */
  postsThatDay: number;
  maxPostsPerDay: number;
  /** The platform needs a per-post confirmation that was not given yet. */
  platformConfirmationMissing: boolean;
  /** Brand profile known words (name) to detect an unusual brand change. Optional. */
  businessName?: string | null;
}

export interface RiskReason {
  code: string;
  /** hard = review even in AUTO mode; soft = review in HYBRID mode only; block = never goes out. */
  severity: 'block' | 'hard' | 'soft';
  message: string;
}
export interface Classification { risk: RiskClass; reasons: RiskReason[] }

const rx = (s: string) => new RegExp(s, 'iu');
const SENSITIVE: Array<{ code: string; re: RegExp; msg: string }> = [
  { code: 'HEALTH_CLAIM', re: rx('\\b(cure[sd]?|heals?|treats?|miracle|guérit|soigne|remède|traite\\s+le\\s+cancer|anti-?diab|perte\\s+de\\s+poids\\s+garantie|lose\\s+\\d+\\s?(kg|lbs?))\\b'), msg: 'Health or medical claim' },
  { code: 'FINANCIAL_PROMISE', re: rx('(guaranteed\\s+(returns?|profit|income)|gagnez?\\s+\\d+|revenus?\\s+garantis?|get\\s+rich|investment\\s+opportunity|crypto\\s+giveaway)'), msg: 'Financial promise' },
  { code: 'POLITICAL_RELIGIOUS', re: rx('\\b(vote\\s+for|élections?|election|parti\\s+politique|political\\s+party|religion|religious|jihad|fatwa)\\b'), msg: 'Political or religious statement' },
  { code: 'MINORS', re: rx('\\b(children\\s+under|enfants?\\s+de\\s+moins|kids\\s+only|mineurs?)\\b'), msg: 'Content aimed at minors' },
];
const MISLEADING = rx('(100\\s?%\\s+(guaranteed|garanti)|guaranteed\\s+results?|résultats?\\s+garantis?|the\\s+best\\s+in\\s+the\\s+world|le\\s+meilleur\\s+du\\s+monde|no\\s+risk|sans\\s+aucun\\s+risque|only\\s+today\\s+only|dernière\\s+chance\\s+absolue|limited\\s+to\\s+\\d+\\s+people)');
const PROMO_BIG = rx('(-|−|up\\s+to\\s+|jusqu\'à\\s+|)(5\\d|6\\d|7\\d|8\\d|9\\d)\\s?%\\s*(off|de\\s+réduction|discount|remise|rabais)?|\\b(free|gratuit|giveaway|concours|tirage\\s+au\\s+sort|win\\s+a)\\b');
const BRAND_CHANGE = rx('\\b(new\\s+name|nouveau\\s+nom|rebrand|nouvelle\\s+identité|new\\s+logo|nouveau\\s+logo|we\\s+(are|have)\\s+(now|moved|closed)|nous\\s+(avons\\s+)?(déménagé|fermé)|under\\s+new\\s+ownership)\\b');
const PERSONAL = [
  { code: 'EMAIL', re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/ },
  { code: 'PHONE', re: /(?<![\d.])(\+?\d[\d\s().-]{8,}\d)(?![\d.])/ },
  { code: 'ID_NUMBER', re: /\b(iban|passport|passeport|cni|ssn|carte\s+bancaire|card\s+number)\b/i },
];
const SECRETS = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,})/;

/**
 * Deterministic classification of one publication. It can only make a decision stricter than the platform rules and the policy, never looser:
 * BLOCKED beats REVIEW_REQUIRED beats LOW_RISK, and a BLOCKED post is never published by any mode. Wording lists are examples, not a guarantee:
 * the final safety net is the human review the merchant keeps for REVIEW_REQUIRED and the platform's own rules.
 */
export function classifyPublication(i: ClassifyInput): Classification {
  const reasons: RiskReason[] = [];
  const add = (code: string, severity: RiskReason['severity'], message: string) => reasons.push({ code, severity, message });
  const text = [i.title, i.caption, i.callToAction, ...(i.hashtags ?? [])].filter(Boolean).join('\n');
  const facts = platformFacts(i.platform);

  if (!i.caption?.trim() && i.contentKind === 'TEXT') add('EMPTY_CONTENT', 'block', 'The post has no text');
  if (SECRETS.test(text)) add('SECRET_IN_CONTENT', 'block', 'The text looks like it contains a secret or key');
  if (facts && !facts.contentKinds.includes(i.contentKind)) add('KIND_UNSUPPORTED', 'block', `${i.platform} cannot publish ${i.contentKind} through its official API`);
  if (!i.allowedContentTypes.includes(i.contentKind)) add('KIND_NOT_ALLOWED', 'block', `Content type ${i.contentKind} is not allowed by this account's policy`);
  if ((i.groundingIssues ?? 0) > 0) add('UNVERIFIED_FACTS', 'block', 'The text states facts that are not in the verified business data');

  if (i.platformConfirmationMissing) add('PLATFORM_CONFIRMATION', 'hard', 'The platform requires a confirmation for this post that a person has not given');
  if (!withinHours(i.scheduledAt, i.timezone, i.hours)) add('OUTSIDE_HOURS', 'hard', 'The time is outside the allowed publishing hours');
  if (i.postsThatDay >= i.maxPostsPerDay) add('DAILY_LIMIT', 'hard', `The daily limit of ${i.maxPostsPerDay} posts would be exceeded`);

  for (const s of SENSITIVE) if (s.re.test(text)) add(s.code, 'hard', s.msg);
  for (const p of PERSONAL) if (p.re.test(text)) add(`PERSONAL_DATA_${p.code}`, 'hard', 'The text contains personal data');
  if (MISLEADING.test(text)) add('MISLEADING', 'hard', 'The wording may be misleading');
  if (PROMO_BIG.test(text)) add('UNUSUAL_PROMOTION', 'soft', 'Unusual promotion (large discount, free offer or contest)');
  if (BRAND_CHANGE.test(text)) add('BRAND_CHANGE', 'soft', 'Announcement that changes how the brand presents itself');

  if (reasons.some((r) => r.severity === 'block')) return { risk: 'BLOCKED', reasons };
  if (i.mode === 'MANUAL') return { risk: 'REVIEW_REQUIRED', reasons: [...reasons, { code: 'MANUAL_MODE', severity: 'hard', message: 'This account is in manual mode' }] };
  const needsReview = i.mode === 'HYBRID' ? reasons.length > 0 : reasons.some((r) => r.severity === 'hard');
  return { risk: needsReview ? 'REVIEW_REQUIRED' : 'LOW_RISK', reasons };
}

// ─── Policy validation ─────────────────────────────────────────────────────

export const MAX_POSTS_PER_DAY_CEILING = 10;

export interface PolicyDraft { mode: PublishingMode; maximumPostsPerDay: number; timezone: string; allowedContentTypes: string[]; allowedPublishingHours: HoursWindow[] }
export function validatePolicyDraft(p: PolicyDraft): string[] {
  const errs: string[] = [];
  if (!PUBLISHING_MODES.includes(p.mode)) errs.push('mode');
  if (!Number.isInteger(p.maximumPostsPerDay) || p.maximumPostsPerDay < 1 || p.maximumPostsPerDay > MAX_POSTS_PER_DAY_CEILING) errs.push('maximumPostsPerDay');
  if (!p.allowedContentTypes.length || !p.allowedContentTypes.every((k) => ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'].includes(k))) errs.push('allowedContentTypes');
  if (!validateHours(p.allowedPublishingHours)) errs.push('allowedPublishingHours');
  try { new Intl.DateTimeFormat('en', { timeZone: p.timezone }); } catch { errs.push('timezone'); }
  return errs;
}
