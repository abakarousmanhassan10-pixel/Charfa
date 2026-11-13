import { z } from 'zod';
import { parseCreativePricing, parsePricingTable } from './ai-pricing';

/**
 * Centralised, validated environment configuration.
 * Every application (api, worker) loads its configuration through this schema so
 * that a missing or weak secret fails fast at boot instead of at runtime.
 */
const secret = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`);

export const appEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'development', 'staging', 'production', 'test']).default('local'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  /** Port the API listens on. When unset, the platform's PORT variable is used (Render, Heroku-style hosts), then 4000. */
  API_PORT: z.coerce.number().int().positive().default(4000),
  /**
   * Number of reverse proxies in front of the API whose X-Forwarded-For entries are trusted (Express `trust proxy`).
   * Only that many hops, counted from the API, are believed: anything a client puts further left is ignored.
   * 1 = a single platform load balancer (default). Raise it only after checking the real hop count in staging
   * (for example 2 when another proxy such as the web host sits in front of the platform). 0 = trust no proxy header.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  /** 32-byte key, base64 encoded, used for AES-256-GCM encryption of OAuth tokens. */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64',
    }),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
  AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Session refreshes per minute per client IP (every page load refreshes; offices share IPs). */
  AUTH_REFRESH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(60),
  /** Abuse guard until plan limits arrive (Phase 10): max businesses a user can own. */
  MAX_OWNED_BUSINESSES: z.coerce.number().int().positive().default(5),
  // Optional provider credentials. Absence means the integration is "not configured".
  // ─── TOUMA AI engine ───
  /** openai (default) | fake: deterministic TEST-ONLY provider, refused unless APP_ENV=test. */
  AI_PROVIDER: z.enum(['openai', 'fake']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_ORGANIZATION: z.string().optional(),
  /** Any model supporting Structured Outputs (json_schema, strict). */
  AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /** Leave empty to use each agent's default (analysis 0.3, strategy 0.6, content 0.8). */
  AI_TEMPERATURE: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(2).optional()),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(4000),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(90_000),
  AI_MAX_PROVIDER_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
  /** Per-business monthly caps (until plan limits arrive in Phase 10). */
  AI_MONTHLY_GENERATIONS_PER_BUSINESS: z.coerce.number().int().positive().default(300),
  AI_MONTHLY_TOKENS_PER_BUSINESS: z.coerce.number().int().positive().default(3_000_000),
  /** Per-user requests per minute on generation endpoints. */
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** USD per 1M tokens, from the provider's pricing page. 0 = unknown (cost reported as not configured). */
  AI_INPUT_COST_PER_1M_TOKENS: z.coerce.number().min(0).default(0),
  AI_OUTPUT_COST_PER_1M_TOKENS: z.coerce.number().min(0).default(0),
  /** Per-model prices as JSON: {"gpt-4o-mini":{"inputPerMillion":0.15,"outputPerMillion":0.6}}. Overrides the flat prices above. */
  AI_MODEL_PRICING: z
    .string()
    .optional()
    .transform((v, ctx) => {
      try {
        return parsePricingTable(v);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    }),
  /** Tokens held per reserved generation unit (input + output estimate) until the real usage is known. */
  AI_TOKENS_RESERVED_PER_GENERATION: z.coerce.number().int().min(100).default(12_000),
  /** BullMQ attempts for transient failures (provider rate limit, timeout, outage) and backoff between them. */
  AI_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  AI_JOB_BACKOFF_MS: z.coerce.number().int().min(10).default(5_000),
  AI_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /** Run the AI queue worker inside the API process (development, tests). Production runs `node dist/ai-worker.js`. */
  AI_WORKER_INLINE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // ─── Creative Studio (images, videos) ────────────────────────────────────────
  /** openai = OpenAI Images (uses OPENAI_API_KEY); none = disabled. fake = deterministic test-only provider (APP_ENV=test only). */
  IMAGE_PROVIDER: z.enum(['openai', 'none', 'fake']).default('openai'),
  IMAGE_MODEL: z.string().min(1).default('gpt-image-1'),
  /** Video is opt-in because it is costly: none (default), openai (Sora API, uses OPENAI_API_KEY) or the test-only fake. */
  VIDEO_PROVIDER: z.enum(['none', 'openai', 'fake']).default('none'),
  VIDEO_MODEL: z.string().min(1).default('sora-2'),
  CREATIVE_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(180_000),
  /** Monthly limits per business (an active plan's aiImagesPerMonth / aiVideoSecondsPerMonth take precedence). */
  CREATIVE_MONTHLY_IMAGES_PER_BUSINESS: z.coerce.number().int().positive().default(100),
  CREATIVE_MONTHLY_VIDEO_SECONDS_PER_BUSINESS: z.coerce.number().int().positive().default(120),
  CREATIVE_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CREATIVE_JOB_BACKOFF_MS: z.coerce.number().int().min(10).default(5_000),
  CREATIVE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  /** How often a running video job asks the provider for its status, and when it gives up. */
  CREATIVE_VIDEO_POLL_MS: z.coerce.number().int().min(20).default(10_000),
  CREATIVE_VIDEO_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(20),
  CREATIVE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** How often the calendar worker looks for due entries, in ms. */
  CALENDAR_TICK_MS: z.coerce.number().int().min(20).default(15_000),
  CALENDAR_DISPATCH_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CALENDAR_DISPATCH_BACKOFF_MS: z.coerce.number().int().min(10).default(5_000),
  /** An entry that is this many minutes from publication triggers an "upcoming" notification. */
  CALENDAR_REMINDER_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  /** A dispatch claim older than this is considered abandoned (worker crash) and is released. */
  CALENDAR_LOCK_SECONDS: z.coerce.number().int().min(1).default(120),
  CALENDAR_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // ── Social platforms. Credentials come from each platform's developer portal and are server-side secrets. ──
  /** live (default): official platform APIs. fake: deterministic TEST-ONLY providers, refused unless APP_ENV=test. */
  SOCIAL_PROVIDER_MODE: z.enum(['live', 'fake']).default('live'),
  /** The public https base URL of this API, used for OAuth redirect URIs, webhooks and media URLs that platforms download from. */
  PUBLIC_API_URL: z.string().url().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16).optional(),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  /** LinkedIn REST API version header (YYYYMM). */
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/).default('202411'),
  /** Personal profile publishing (Share on LinkedIn, w_member_social). On by default; it is self-serve. */
  LINKEDIN_PERSONAL_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /**
   * Company Page (organization) publishing. OFF until LinkedIn approves the Community Management API for the application.
   * Turning it on requires LINKEDIN_ORG_APPROVAL_REF (who/when/what LinkedIn approved) so it cannot be enabled by accident.
   */
  LINKEDIN_ORG_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** The approved Community Management application. When empty, the personal application's credentials are used. */
  LINKEDIN_ORG_CLIENT_ID: z.string().optional(),
  LINKEDIN_ORG_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_ORG_APPROVAL_REF: z.string().max(300).optional(),
  SOCIAL_STATE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /** Tokens that expire within this many hours are refreshed in the background. */
  SOCIAL_TOKEN_REFRESH_AHEAD_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** People are warned this many days before a token that cannot be refreshed expires. */
  SOCIAL_TOKEN_WARN_DAYS: z.coerce.number().int().min(1).max(60).default(7),
  SOCIAL_PUBLISH_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  SOCIAL_PUBLISH_BACKOFF_MS: z.coerce.number().int().min(10).default(10_000),
  SOCIAL_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  /** How often the social worker refreshes tokens, polls in-flight publications and collects metrics, in ms. */
  SOCIAL_TICK_MS: z.coerce.number().int().min(20).default(30_000),
  /** An in-flight publication that the platform has not finished after this many minutes is failed (its outcome stays unknown if it may exist). */
  SOCIAL_PROCESSING_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  SOCIAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /** Customer chat model (defaults to AI_MODEL). Chat needs fast answers: its own timeout, and a temperature that can be switched off ("none") for models that reject it. */
  SALES_AGENT_MODEL: z.string().min(1).optional(),
  SALES_AGENT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  SALES_AGENT_TEMPERATURE: z.string().regex(/^(none|[01](\.\d+)?|2(\.0+)?)$/, 'SALES_AGENT_TEMPERATURE must be "none" or a number from 0 to 2').default('0.2'),
  /** Sales agent: AI replies/drafts one business may generate per day (cost control), and public chat limits per IP per minute. */
  SALES_AGENT_DAILY_REPLY_CAP: z.coerce.number().int().positive().default(500),
  SALES_PUBLIC_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Public chat anti-flood: new conversations one business may receive per hour. */
  SALES_NEW_CONVERSATIONS_PER_HOUR: z.coerce.number().int().positive().default(120),
  /** How often the retention purge runs (ms). 0 switches the automatic purge off (the merchant's retention setting is then not enforced). */
  SALES_RETENTION_INTERVAL_MS: z.coerce.number().int().min(0).default(21_600_000),
  /** Optional bot protection for starting a customer chat: Cloudflare Turnstile. Off by default; needs both keys when on. */
  CHAT_CAPTCHA_PROVIDER: z.enum(['none', 'turnstile']).default('none'),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),
  SALES_MAX_CUSTOMER_MESSAGES_PER_CONVERSATION: z.coerce.number().int().positive().default(60),
  /** Per-model prices (JSON, USD): {"gpt-image-1":{"perImageUsd":0.04},"sora-2":{"perSecondUsd":0.1}}. Unset = cost reported as unknown. */
  CREATIVE_MODEL_PRICING: z
    .string()
    .optional()
    .transform((v, ctx) => {
      try {
        return parseCreativePricing(v);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    }),
  /** Health endpoint of the standalone AI worker (node dist/ai-worker.js). */
  AI_WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4002),
  /** Reservations of jobs that never finished are released after this many minutes by the reconciler. */
  AI_RESERVATION_STALE_MINUTES: z.coerce.number().int().min(1).default(120),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** aws | r2 (Cloudflare) | minio | custom. Sets addressing/region defaults. */
  S3_PROVIDER: z.enum(['aws', 'r2', 'minio', 'custom']).default('minio'),
  /** Override path-style addressing (default: true for minio/custom, false for aws/r2). */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** Create the bucket on first use. Only for local MinIO; production buckets are provisioned explicitly. */
  S3_AUTO_CREATE_BUCKET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Default storage quota per business (originals + thumbnails). Can be overridden per business. */
  MEDIA_STORAGE_QUOTA_MB: z.coerce.number().positive().default(1024),
  /** Decompression-bomb guard: maximum decoded image size in pixels. */
  MEDIA_MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  /** clamav: scan every upload with clamd (INSTREAM). none: no scanning (refused in production unless ALLOW_UNSCANNED_UPLOADS=true). */
  MALWARE_SCANNER: z.enum(['clamav', 'none']).default('none'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ALLOW_UNSCANNED_UPLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // ─── Email ───
  /** smtp: real delivery. log: development only, emails (with links) are written to the server log. */
  EMAIL_TRANSPORT: z.enum(['smtp', 'log']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('TOUMA <no-reply@localhost>'),
  // ─── Infrastructure ───
  /** redis: rate limits shared by all API instances. memory: single-instance development only. */
  RATE_LIMIT_STORE: z.enum(['redis', 'memory']).default('redis'),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  /**
   * s3 (default): S3-compatible storage. memory: in-process store for automated tests ONLY;
   * the loader refuses it unless APP_ENV=test.
   */
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),
  MEDIA_MAX_IMAGE_MB: z.coerce.number().positive().max(100).default(10),
  MEDIA_MAX_VIDEO_MB: z.coerce.number().positive().max(2048).default(200),
  /** Lifetime of signed media URLs handed to browsers. */
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
});

export type AppEnv = z.infer<typeof appEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(rawSource: Record<string, string | undefined> = process.env): AppEnv {
  // Hosts such as Render inject PORT; an explicit API_PORT always wins.
  const source = { ...rawSource };
  if (!source.API_PORT?.trim()) {
    if (source.PORT?.trim()) source.API_PORT = source.PORT;
    else delete source.API_PORT;
  }
  const parsed = appEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const env = parsed.data;
  if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
    const problems = productionProblems(env);
    if (problems.length) throw new EnvValidationError(problems);
  }
  if (env.EMAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
    throw new EnvValidationError(['SMTP_HOST is required when EMAIL_TRANSPORT=smtp']);
  }
  if (env.EMAIL_TRANSPORT === 'smtp') {
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
      throw new EnvValidationError(['SMTP_USER and SMTP_PASSWORD must be set together']);
    }
    // Wrong TLS mode for the port makes the connection hang or fail with an obscure error: fail at boot instead.
    if ((env.SMTP_PORT === 465 || env.SMTP_PORT === 2465) && !env.SMTP_SECURE) {
      throw new EnvValidationError([`SMTP_PORT=${env.SMTP_PORT} uses implicit TLS: set SMTP_SECURE=true`]);
    }
    if ([25, 587, 2525, 2587].includes(env.SMTP_PORT) && env.SMTP_SECURE) {
      throw new EnvValidationError([`SMTP_PORT=${env.SMTP_PORT} uses STARTTLS: set SMTP_SECURE=false`]);
    }
  }
  if (env.AI_PROVIDER === 'fake' && env.APP_ENV !== 'test') {
    throw new EnvValidationError(['AI_PROVIDER=fake is only allowed when APP_ENV=test']);
  }
  if (env.CHAT_CAPTCHA_PROVIDER === 'turnstile' && (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET)) {
    throw new EnvValidationError(['CHAT_CAPTCHA_PROVIDER=turnstile requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET']);
  }
  if (env.LINKEDIN_ORG_ENABLED && !env.LINKEDIN_ORG_APPROVAL_REF?.trim()) {
    throw new EnvValidationError(['LINKEDIN_ORG_ENABLED=true requires LINKEDIN_ORG_APPROVAL_REF: record what LinkedIn approved (product, date, reference) before enabling organization publishing']);
  }
  if (env.SOCIAL_PROVIDER_MODE === 'fake' && env.APP_ENV !== 'test') {
    throw new EnvValidationError(['SOCIAL_PROVIDER_MODE=fake is only allowed when APP_ENV=test']);
  }
  if ((env.IMAGE_PROVIDER === 'fake' || env.VIDEO_PROVIDER === 'fake') && env.APP_ENV !== 'test') {
    throw new EnvValidationError(['IMAGE_PROVIDER=fake and VIDEO_PROVIDER=fake are only allowed when APP_ENV=test']);
  }
  if (env.STORAGE_DRIVER === 'memory' && env.APP_ENV !== 'test') {
    throw new EnvValidationError(['STORAGE_DRIVER=memory is only allowed when APP_ENV=test']);
  }
  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new EnvValidationError(['JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ']);
  }
  return env;
}

const EXAMPLE_VALUES = [
  'change-me-access-secret-at-least-32-characters',
  'change-me-refresh-secret-at-least-32-characters',
  'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
];

/**
 * Production/staging requirements. Every problem is listed at once so a deployment fails fast
 * with a complete report, and the API never starts in a half-secure configuration.
 */
export function productionProblems(env: AppEnv): string[] {
  const p: string[] = [];
  const https = (u: string) => u.startsWith('https://');
  if (!https(env.WEB_URL)) p.push('WEB_URL must use https');
  if (env.CORS_ORIGINS.some((o) => !https(o))) p.push('CORS_ORIGINS must only contain https origins');
  if (env.COOKIE_SECURE === false) p.push('COOKIE_SECURE must not be false');
  for (const [k, v] of [['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET], ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET], ['TOKEN_ENCRYPTION_KEY', env.TOKEN_ENCRYPTION_KEY]] as const) {
    if (EXAMPLE_VALUES.includes(v)) p.push(`${k} still has the .env.example value`);
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) p.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (env.DATABASE_URL.includes('touma_dev_password') || env.DATABASE_URL.includes('aima_dev_password')) p.push('DATABASE_URL uses the development password');
  if (env.STORAGE_DRIVER !== 's3') p.push('STORAGE_DRIVER must be s3');
  if (!(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) p.push('S3 storage must be configured (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)');
  if (env.S3_AUTO_CREATE_BUCKET) p.push('S3_AUTO_CREATE_BUCKET must be false (provision the bucket explicitly)');
  if (env.EMAIL_TRANSPORT !== 'smtp') p.push('EMAIL_TRANSPORT must be smtp');
  if (!env.SMTP_HOST) p.push('SMTP_HOST is required');
  if (/localhost/i.test(env.EMAIL_FROM)) p.push('EMAIL_FROM must be a real sender address');
  if (env.MALWARE_SCANNER === 'none' && !env.ALLOW_UNSCANNED_UPLOADS) p.push('MALWARE_SCANNER must be clamav (or set ALLOW_UNSCANNED_UPLOADS=true to accept the risk explicitly)');
  if (env.RATE_LIMIT_STORE !== 'redis') p.push('RATE_LIMIT_STORE must be redis');
  if (env.AI_PROVIDER === 'fake') p.push('AI_PROVIDER=fake is test-only');
  if (env.SOCIAL_PROVIDER_MODE === 'fake') p.push('SOCIAL_PROVIDER_MODE=fake is test-only');
  const socialConfigured = Boolean(env.META_APP_ID || env.TIKTOK_CLIENT_KEY || env.GOOGLE_CLIENT_ID || env.LINKEDIN_CLIENT_ID);
  if (socialConfigured && !env.PUBLIC_API_URL) p.push('PUBLIC_API_URL is required when a social platform is configured (OAuth redirect URIs, webhooks and media URLs)');
  if (env.PUBLIC_API_URL && !https(env.PUBLIC_API_URL)) p.push('PUBLIC_API_URL must use https');
  if (env.IMAGE_PROVIDER === 'fake' || env.VIDEO_PROVIDER === 'fake') p.push('IMAGE_PROVIDER/VIDEO_PROVIDER=fake are test-only');
  return p;
}

/** Reports which optional external integrations are configured. Never returns secret values. */
export function integrationStatus(env: AppEnv) {
  return {
    openai: env.AI_PROVIDER === 'fake' || Boolean(env.OPENAI_API_KEY),
    email: env.EMAIL_TRANSPORT === 'smtp' && Boolean(env.SMTP_HOST),
    malwareScanning: env.MALWARE_SCANNER === 'clamav',
    storage:
      env.STORAGE_DRIVER === 'memory' || Boolean(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
  };
}
