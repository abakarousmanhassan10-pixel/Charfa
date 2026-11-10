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

  it('reports integrations as not configured without credentials', () => {
    expect(integrationStatus(loadEnv(valid))).toEqual({ openai: false, storage: false });
  });
});
