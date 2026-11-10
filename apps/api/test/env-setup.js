// Test env: separate database. Override with TEST_DATABASE_URL in CI.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://aima:aima_dev_password@localhost:5432/aima_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379/1';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.AUTH_THROTTLE_LIMIT = process.env.AUTH_THROTTLE_LIMIT || '1000';
process.env.THROTTLE_LIMIT = '10000';
process.env.CORS_ORIGINS = 'http://localhost:3000';
