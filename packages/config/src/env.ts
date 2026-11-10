import { z } from 'zod';

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
  API_PORT: z.coerce.number().int().positive().default(4000),
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
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Required for MinIO and most S3-compatible providers. */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
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

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = appEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const env = parsed.data;
  if (env.AI_PROVIDER === 'fake' && env.APP_ENV !== 'test') {
    throw new EnvValidationError(['AI_PROVIDER=fake is only allowed when APP_ENV=test']);
  }
  if (env.STORAGE_DRIVER === 'memory' && env.APP_ENV !== 'test') {
    throw new EnvValidationError(['STORAGE_DRIVER=memory is only allowed when APP_ENV=test']);
  }
  if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new EnvValidationError(['JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ']);
  }
  return env;
}

/** Reports which optional external integrations are configured. Never returns secret values. */
export function integrationStatus(env: AppEnv) {
  return {
    openai: env.AI_PROVIDER === 'fake' || Boolean(env.OPENAI_API_KEY),
    storage:
      env.STORAGE_DRIVER === 'memory' || Boolean(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY),
  };
}
