import { loadEnv, productionProblems } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('billing configuration (N24)', () => {
  it('is off by default with no provider and no founder', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ BILLING_ENABLED: false, BILLING_PROVIDER: 'none', FOUNDER_EMAILS: [] });
  });
  it('parses the founder allow-list (trimmed, lower-cased)', () => {
    expect(loadEnv({ ...valid, FOUNDER_EMAILS: ' Founder@Example.com , second@example.com ,' }).FOUNDER_EMAILS).toEqual(['founder@example.com', 'second@example.com']);
  });
  it('the simulated provider is test-only', () => {
    expect(() => loadEnv({ ...valid, BILLING_PROVIDER: 'simulated', APP_ENV: 'development' })).toThrow(/only allowed when APP_ENV=test/);
    expect(loadEnv({ ...valid, BILLING_PROVIDER: 'simulated', APP_ENV: 'test' }).BILLING_PROVIDER).toBe('simulated');
  });
  it('production refuses BILLING_ENABLED until a provider adapter is verified', () => {
    expect(productionProblems(loadEnv({ ...valid, BILLING_ENABLED: 'true' })).join(' ')).toMatch(/BILLING_ENABLED must stay false/);
    expect(productionProblems(loadEnv(valid)).join(' ')).not.toMatch(/BILLING_ENABLED/);
  });
});

describe('Payoneer personal account guard (N25)', () => {
  it('refuses the payoneer provider unless the account is a business account', () => {
    expect(loadEnv(valid).PAYONEER_ACCOUNT_TYPE).toBe('personal');
    expect(() => loadEnv({ ...valid, BILLING_PROVIDER: 'payoneer' })).toThrow(/personal Payoneer account must not be used/);
    expect(() => loadEnv({ ...valid, BILLING_PROVIDER: 'payoneer', PAYONEER_ACCOUNT_TYPE: 'personal' })).toThrow(/PAYONEER_ACCOUNT_TYPE=business/);
    expect(loadEnv({ ...valid, BILLING_PROVIDER: 'payoneer', PAYONEER_ACCOUNT_TYPE: 'business' }).BILLING_PROVIDER).toBe('payoneer');
  });
  it('failed-payment limit is configurable and bounded', () => {
    expect(loadEnv(valid).BILLING_MAX_FAILED_PAYMENTS).toBe(3);
    expect(() => loadEnv({ ...valid, BILLING_MAX_FAILED_PAYMENTS: '0' })).toThrow();
  });
});
