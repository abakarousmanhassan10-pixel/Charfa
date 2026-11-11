// Test env: separate database. Override with TEST_DATABASE_URL in CI.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://touma:touma_dev_password@localhost:5432/touma_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379/1';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.AUTH_THROTTLE_LIMIT = process.env.AUTH_THROTTLE_LIMIT || '1000';
process.env.THROTTLE_LIMIT = '10000';
process.env.CORS_ORIGINS = 'http://localhost:3000';
// TEST-ONLY in-memory object storage (refused by the env loader outside APP_ENV=test).
process.env.STORAGE_DRIVER = 'memory';
// TEST-ONLY deterministic AI provider (refused by the env loader outside APP_ENV=test).
process.env.AI_PROVIDER = 'fake';
process.env.AI_MONTHLY_GENERATIONS_PER_BUSINESS = '40';
process.env.AI_RATE_LIMIT_PER_MINUTE = '1000';
// Generation runs in a BullMQ worker; tests host it inside the API process (production runs `node dist/ai-worker.js`).
process.env.AI_WORKER_INLINE = 'true';
// Creative Studio: TEST-ONLY providers (refused by the env loader outside APP_ENV=test). The real adapters are covered by unit tests.
process.env.IMAGE_PROVIDER = 'fake';
process.env.VIDEO_PROVIDER = 'fake';
process.env.CREATIVE_VIDEO_POLL_MS = '60';
process.env.CREATIVE_JOB_BACKOFF_MS = '40';
process.env.CREATIVE_RATE_LIMIT_PER_MINUTE = '1000';
process.env.CREATIVE_MODEL_PRICING = JSON.stringify({ 'gpt-image-1': { perImageUsd: 0.04 }, 'sora-2': { perSecondUsd: 0.1 } });
process.env.AI_JOB_ATTEMPTS = '3';
process.env.AI_JOB_BACKOFF_MS = '40';
// One provider call per job attempt, so retries are exercised at the queue level and stay fast.
process.env.AI_MAX_PROVIDER_RETRIES = '0';
process.env.AI_INPUT_COST_PER_1M_TOKENS = '0.15';
process.env.AI_OUTPUT_COST_PER_1M_TOKENS = '0.6';
// Per-model prices (override the flat defaults above); the fake provider reports models as "fake:<model>".
process.env.AI_MODEL_PRICING = JSON.stringify({ 'gpt-4o-mini': { inputPerMillion: 1, outputPerMillion: 2 } });
process.env.MEDIA_MAX_IMAGE_MB = '1';
process.env.MEDIA_MAX_VIDEO_MB = '2';
process.env.MEDIA_MAX_IMAGE_PIXELS = '4000000';
process.env.MALWARE_SCANNER = process.env.MALWARE_SCANNER || 'none';
// Real SMTP delivery to an in-process SMTP server started by the tests that read emails (test/mailbox.ts).
process.env.EMAIL_TRANSPORT = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = process.env.TEST_SMTP_PORT || '2525';
process.env.EMAIL_FROM = 'TOUMA Test <no-reply@touma.test>';
process.env.WEB_URL = 'http://localhost:3000';
// Calendar: the scheduler tick is driven by the tests (worker.tick()); the interval is made too long to interfere.
process.env.CALENDAR_TICK_MS = '600000';
process.env.CALENDAR_DISPATCH_BACKOFF_MS = '40';
process.env.CALENDAR_DISPATCH_ATTEMPTS = '3';
process.env.CALENDAR_RATE_LIMIT_PER_MINUTE = '1000';
// Social: the platform simulator replaces the real platforms (refused unless APP_ENV=test). Ticks are driven by the tests.
process.env.SOCIAL_PROVIDER_MODE = 'fake';
process.env.SOCIAL_TICK_MS = '600000';
process.env.SOCIAL_PUBLISH_BACKOFF_MS = '40';
process.env.SOCIAL_PUBLISH_ATTEMPTS = '3';
process.env.SOCIAL_RATE_LIMIT_PER_MINUTE = '1000';
process.env.META_APP_SECRET = 'test-meta-app-secret';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token-123456';
process.env.TIKTOK_CLIENT_SECRET = 'test-tiktok-client-secret';
process.env.PUBLIC_API_URL = 'https://api.touma.test';
