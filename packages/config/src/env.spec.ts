import { EnvValidationError, integrationStatus, loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('rejects short secrets', () => {
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/32 bytes/);
  });

  it('rejects identical JWT secrets in production', () => {
    expect(() =>
      loadEnv({ ...valid, NODE_ENV: 'production', JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET }),
    ).toThrow(/must differ/);
  });

  it('defaults the storage provider preset and keeps path style unset for the preset to decide', () => {
    const env = loadEnv(valid);
    expect(env.S3_PROVIDER).toBe('minio');
    expect(env.S3_FORCE_PATH_STYLE).toBeUndefined();
    expect(env.RATE_LIMIT_STORE).toBe('redis');
  });

  it('refuses the in-memory storage driver outside tests', () => {
    expect(() => loadEnv({ ...valid, STORAGE_DRIVER: 'memory', APP_ENV: 'development' })).toThrow(/only allowed when APP_ENV=test/);
    expect(loadEnv({ ...valid, STORAGE_DRIVER: 'memory', APP_ENV: 'test' }).STORAGE_DRIVER).toBe('memory');
  });

  it('refuses the fake AI provider outside tests and validates AI settings', () => {
    expect(() => loadEnv({ ...valid, AI_PROVIDER: 'fake', APP_ENV: 'production' })).toThrow(/AI_PROVIDER=fake/);
    expect(() => loadEnv({ ...valid, AI_TEMPERATURE: '3' })).toThrow();
    const env = loadEnv({ ...valid, AI_TEMPERATURE: '' });
    expect(env.AI_TEMPERATURE).toBeUndefined();
    expect(env.AI_MODEL).toBe('gpt-4o-mini');
  });

  it('reports integrations as not configured without credentials', () => {
    expect(integrationStatus(loadEnv(valid))).toEqual({ openai: false, storage: false, email: false, malwareScanning: false });
  });

  const prod = {
    ...valid,
    APP_ENV: 'production',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://touma:strong-pass@db.internal:5432/touma?sslmode=require',
    WEB_URL: 'https://app.touma.example',
    CORS_ORIGINS: 'https://app.touma.example',
    STORAGE_DRIVER: 's3',
    S3_PROVIDER: 'r2',
    S3_BUCKET: 'touma-media',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    EMAIL_FROM: 'TOUMA <no-reply@touma.example>',
    MALWARE_SCANNER: 'clamav',
  };

  it('accepts a complete production configuration', () => {
    expect(() => loadEnv(prod)).not.toThrow();
  });

  it('lists every production problem at once', () => {
    const err = (() => {
      try {
        loadEnv({ ...valid, APP_ENV: 'production', DATABASE_URL: 'postgresql://touma:touma_dev_password@db:5432/touma', WEB_URL: 'http://x.example', JWT_ACCESS_SECRET: 'change-me-access-secret-at-least-32-characters' });
      } catch (e) {
        return e as EnvValidationError;
      }
    })()!;
    expect(err).toBeInstanceOf(EnvValidationError);
    const all = err.issues.join('\n');
    for (const m of ['WEB_URL must use https', 'JWT_ACCESS_SECRET still has the .env.example value', 'S3 storage must be configured', 'EMAIL_TRANSPORT must be smtp', 'MALWARE_SCANNER must be clamav', 'DATABASE_URL uses the development password']) {
      expect(all).toContain(m);
    }
  });

  it('allows unscanned uploads in production only when explicitly accepted', () => {
    expect(() => loadEnv({ ...prod, MALWARE_SCANNER: 'none' })).toThrow(/MALWARE_SCANNER/);
    expect(() => loadEnv({ ...prod, MALWARE_SCANNER: 'none', ALLOW_UNSCANNED_UPLOADS: 'true' })).not.toThrow();
  });

  it('requires SMTP_HOST for smtp transport', () => {
    expect(() => loadEnv({ ...valid, EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
  });
});

describe('AI settings', () => {
  it('parses per-model pricing and the job settings with defaults', () => {
    const env = loadEnv({ ...valid, AI_MODEL_PRICING: '{"gpt-4o-mini":{"inputPerMillion":0.15,"outputPerMillion":0.6}}' });
    expect(env.AI_MODEL_PRICING['gpt-4o-mini']).toEqual({ inputPerMillion: 0.15, outputPerMillion: 0.6 });
    expect(env).toMatchObject({ AI_JOB_ATTEMPTS: 3, AI_WORKER_INLINE: false, AI_TOKENS_RESERVED_PER_GENERATION: 12000 });
    expect(loadEnv(valid).AI_MODEL_PRICING).toEqual({});
  });
  it('rejects malformed pricing instead of silently reporting wrong costs', () => {
    expect(() => loadEnv({ ...valid, AI_MODEL_PRICING: 'not json' })).toThrow(/valid JSON/);
    expect(() => loadEnv({ ...valid, AI_MODEL_PRICING: '{"m":{"inputPerMillion":-1,"outputPerMillion":1}}' })).toThrow(/numeric/);
  });
});

describe('Creative Studio settings', () => {
  it('defaults: images through OpenAI (needs a key), video disabled, limits and polling', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ IMAGE_PROVIDER: 'openai', IMAGE_MODEL: 'gpt-image-1', VIDEO_PROVIDER: 'none', CREATIVE_MONTHLY_IMAGES_PER_BUSINESS: 100, CREATIVE_MONTHLY_VIDEO_SECONDS_PER_BUSINESS: 120 });
    expect(env.CREATIVE_MODEL_PRICING).toEqual({});
  });
  it('parses per-model prices and rejects malformed ones', () => {
    const env = loadEnv({ ...valid, CREATIVE_MODEL_PRICING: '{"gpt-image-1":{"perImageUsd":0.04},"sora-2":{"perSecondUsd":0.1}}' });
    expect(env.CREATIVE_MODEL_PRICING['sora-2']).toEqual({ perSecondUsd: 0.1 });
    expect(() => loadEnv({ ...valid, CREATIVE_MODEL_PRICING: '{"m":{}}' })).toThrow(/needs a numeric/);
    expect(() => loadEnv({ ...valid, CREATIVE_MODEL_PRICING: 'nope' })).toThrow(/valid JSON/);
  });
  it('the fake providers are test-only', () => {
    expect(() => loadEnv({ ...valid, IMAGE_PROVIDER: 'fake' })).toThrow(/only allowed when APP_ENV=test/);
    expect(() => loadEnv({ ...valid, VIDEO_PROVIDER: 'fake' })).toThrow(/only allowed when APP_ENV=test/);
    expect(loadEnv({ ...valid, APP_ENV: 'test', IMAGE_PROVIDER: 'fake', VIDEO_PROVIDER: 'fake' }).IMAGE_PROVIDER).toBe('fake');
  });
  it('LinkedIn organization publishing is off by default and cannot be enabled without recording the approval', () => {
    const env = loadEnv(valid);
    expect(env.LINKEDIN_ORG_ENABLED).toBe(false);
    expect(env.LINKEDIN_PERSONAL_ENABLED).toBe(true);
    expect(() => loadEnv({ ...valid, LINKEDIN_ORG_ENABLED: 'true' })).toThrow(/LINKEDIN_ORG_APPROVAL_REF/);
    expect(() => loadEnv({ ...valid, LINKEDIN_ORG_ENABLED: 'true', LINKEDIN_ORG_APPROVAL_REF: '   ' })).toThrow(/LINKEDIN_ORG_APPROVAL_REF/);
    expect(loadEnv({ ...valid, LINKEDIN_ORG_ENABLED: 'true', LINKEDIN_ORG_APPROVAL_REF: 'Community Management API approved 2027-01-15, ref CM-123' }).LINKEDIN_ORG_ENABLED).toBe(true);
  });
  it('chat model settings: own timeout, temperature can be switched off, bad values are rejected', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ SALES_AGENT_TIMEOUT_MS: 30_000, SALES_AGENT_TEMPERATURE: '0.2' });
    expect(env.SALES_AGENT_MODEL).toBeUndefined();
    expect(loadEnv({ ...valid, SALES_AGENT_TEMPERATURE: 'none', SALES_AGENT_MODEL: 'gpt-5-mini' })).toMatchObject({ SALES_AGENT_TEMPERATURE: 'none', SALES_AGENT_MODEL: 'gpt-5-mini' });
    expect(() => loadEnv({ ...valid, SALES_AGENT_TEMPERATURE: 'hot' })).toThrow(/SALES_AGENT_TEMPERATURE/);
    expect(() => loadEnv({ ...valid, SALES_AGENT_TIMEOUT_MS: '100' })).toThrow();
  });
});
