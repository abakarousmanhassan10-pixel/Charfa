import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';

/**
 * Full-stack E2E: real API (built) + real Next.js server + real PostgreSQL/Redis (test database).
 * Prerequisites: `pnpm build` and a migrated test database (see docs/TESTING.md).
 */
const root = resolve(__dirname, '../..');
const testEnv = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgresql://touma:touma_dev_password@localhost:5432/touma_test?schema=public',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef01234',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789abcdef0123',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  API_PORT: '4100',
  CORS_ORIGINS: 'http://localhost:3100',
  WEB_URL: 'http://localhost:3100',
  AUTH_THROTTLE_LIMIT: '1000',
  AUTH_REFRESH_THROTTLE_LIMIT: '10000',
  THROTTLE_LIMIT: '10000',
  // TEST-ONLY in-memory object storage (the API refuses it unless APP_ENV=test).
  STORAGE_DRIVER: 'memory',
  // TEST-ONLY deterministic AI provider (the API refuses it unless APP_ENV=test).
  AI_PROVIDER: 'fake',
  AI_RATE_LIMIT_PER_MINUTE: '1000',
  // Generation runs in a BullMQ worker; the E2E API hosts it inline (production runs `node dist/ai-worker.js`).
  AI_WORKER_INLINE: 'true',
  AI_JOB_BACKOFF_MS: '100',
  AI_MODEL_PRICING: JSON.stringify({ 'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 } }),
  // TEST-ONLY deterministic image/video providers (refused unless APP_ENV=test). Real providers are never faked in production.
  IMAGE_PROVIDER: 'fake',
  VIDEO_PROVIDER: 'fake',
  CREATIVE_VIDEO_POLL_MS: '60',
  CREATIVE_JOB_BACKOFF_MS: '40',
  CREATIVE_RATE_LIMIT_PER_MINUTE: '1000',
  CREATIVE_MODEL_PRICING: JSON.stringify({ 'gpt-image-1': { perImageUsd: 0.04 }, 'sora-2': { perSecondUsd: 0.1 } }),
  CALENDAR_RATE_LIMIT_PER_MINUTE: '1000',
  // TEST-ONLY platform simulator (the API refuses it unless APP_ENV=test). No real platform is contacted.
  SOCIAL_PROVIDER_MODE: 'fake',
  SOCIAL_PUBLISHING_ENABLED: 'true', // the master switch is OFF by default; the simulator needs it on
  SOCIAL_MAX_PUBLICATIONS_PER_DAY: '1000',
  SOCIAL_COMMENTS_ENABLED: 'true',
  SOCIAL_COMMENT_REPLIES_ENABLED: 'true',
  SOCIAL_RATE_LIMIT_PER_MINUTE: '1000',
  SALES_PUBLIC_RATE_LIMIT_PER_MINUTE: '10000',
  SOCIAL_TICK_MS: '1000',
  SOCIAL_PUBLISH_BACKOFF_MS: '200',
  CALENDAR_TICK_MS: '1000',
  PUBLIC_API_URL: 'https://api.touma.test',
  CALENDAR_DISPATCH_BACKOFF_MS: '100',
  // Real SMTP delivery to a local capture server started by account.e2e.ts (no email provider mock in the API).
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2626',
  EMAIL_FROM: 'TOUMA AI <no-reply@touma.test>',
  RATE_LIMIT_STORE: 'redis',
  // Newer modules are off by default; the browser tests exercise them (simulated adapters, no provider, nothing outbound).
  ORCHESTRATOR_ENABLED: 'true',
  WORKFLOWS_ENABLED: 'true',
  MARKET_INTELLIGENCE_ENABLED: 'true',
  SALES_ASSIST_ENABLED: 'true',
};

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: resolve(root, 'apps/api'),
      url: 'http://localhost:4100/api/v1/health',
      env: testEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx next start -p 3100',
      cwd: resolve(root, 'apps/web'),
      url: 'http://localhost:3100',
      // API_URL is baked into rewrites at build time; build with API_URL=http://localhost:4100 for E2E.
      env: { NODE_ENV: 'production' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
