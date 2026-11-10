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
  THROTTLE_LIMIT: '10000',
  // TEST-ONLY in-memory object storage (the API refuses it unless APP_ENV=test).
  STORAGE_DRIVER: 'memory',
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
