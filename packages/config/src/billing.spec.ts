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

describe('billing enforcement flag (N23.2)', () => {
  it('is off by default and cannot be on without billing', () => {
    expect(loadEnv(valid).BILLING_ENFORCEMENT_ENABLED).toBe(false);
    expect(() => loadEnv({ ...valid, BILLING_ENFORCEMENT_ENABLED: 'true' })).toThrow(/requires BILLING_ENABLED=true/);
    expect(loadEnv({ ...valid, BILLING_ENFORCEMENT_ENABLED: 'true', BILLING_ENABLED: 'true' }).BILLING_ENFORCEMENT_ENABLED).toBe(true);
  });
});

describe('billing engine configuration (N26)', () => {
  it('grace and reminder policies are configurable and bounded; iyzico is selectable but inert', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ BILLING_GRACE_DAYS: 3, BILLING_REMINDER_DAYS: 3 });
    expect(loadEnv({ ...valid, BILLING_GRACE_DAYS: '0' }).BILLING_GRACE_DAYS).toBe(0);
    expect(loadEnv({ ...valid, BILLING_GRACE_DAYS: '10', BILLING_REMINDER_DAYS: '7' })).toMatchObject({ BILLING_GRACE_DAYS: 10, BILLING_REMINDER_DAYS: 7 });
    expect(() => loadEnv({ ...valid, BILLING_GRACE_DAYS: '-1' })).toThrow();
    expect(() => loadEnv({ ...valid, BILLING_GRACE_DAYS: '31' })).toThrow();
    expect(() => loadEnv({ ...valid, BILLING_REMINDER_DAYS: '0' })).toThrow();
    expect(loadEnv({ ...valid, BILLING_PROVIDER: 'iyzico' }).BILLING_PROVIDER).toBe('iyzico');
    expect(() => loadEnv({ ...valid, BILLING_PROVIDER: 'stripe' })).toThrow();
  });
});

describe('Paddle sandbox and live payment lock (N27)', () => {
  const key = 'pdl_sdbx_apikey_0123456789';
  it('live payments are refused whatever else is set; sandbox is the default', () => {
    expect(loadEnv(valid).PAYMENT_ENVIRONMENT).toBe('sandbox');
    expect(() => loadEnv({ ...valid, PAYMENT_ENVIRONMENT: 'live' })).toThrow(/blocked in this build/);
    expect(() => loadEnv({ ...valid, PAYMENT_ENVIRONMENT: 'live', BILLING_PROVIDER: 'paddle-sandbox', PADDLE_API_KEY: key })).toThrow(/blocked in this build/);
  });
  it('only a sandbox key is accepted; the base URL override exists only in the test environment', () => {
    expect(loadEnv({ ...valid, PADDLE_API_KEY: key }).PADDLE_API_KEY).toBe(key);
    expect(() => loadEnv({ ...valid, PADDLE_API_KEY: 'pdl_live_apikey_0123456789' })).toThrow(/SANDBOX key/);
    expect(() => loadEnv({ ...valid, PADDLE_API_BASE_URL: 'http://127.0.0.1:9' })).toThrow(/APP_ENV=test/);
    expect(loadEnv({ ...valid, APP_ENV: 'test', PADDLE_API_BASE_URL: 'http://127.0.0.1:9' }).PADDLE_API_BASE_URL).toBe('http://127.0.0.1:9');
  });
  it('the price map is validated: plan, interval, optional :ONCE, Paddle price ids only', () => {
    const ok = { 'STARTER:MONTHLY': 'pri_01abcdefghij', 'PRO:YEARLY:ONCE': 'pri_01abcdefghik' };
    expect(loadEnv({ ...valid, PADDLE_PRICE_MAP: JSON.stringify(ok) }).PADDLE_PRICE_MAP).toEqual(ok);
    expect(loadEnv(valid).PADDLE_PRICE_MAP).toEqual({});
    for (const bad of ['not json', '[1]', JSON.stringify({ 'GOLD:MONTHLY': 'pri_01abcdefghij' }), JSON.stringify({ 'STARTER:WEEKLY': 'pri_01abcdefghij' }), JSON.stringify({ 'STARTER:MONTHLY': 'price-1' })]) {
      expect(() => loadEnv({ ...valid, PADDLE_PRICE_MAP: bad })).toThrow();
    }
  });
  it('the sandbox and Lemon Squeezy providers are selectable but never production-approved', () => {
    expect(loadEnv({ ...valid, BILLING_PROVIDER: 'paddle-sandbox' }).BILLING_PROVIDER).toBe('paddle-sandbox');
    expect(loadEnv({ ...valid, BILLING_PROVIDER: 'lemonsqueezy' }).BILLING_PROVIDER).toBe('lemonsqueezy');
    expect(productionProblems(loadEnv({ ...valid, BILLING_PROVIDER: 'paddle-sandbox' })).join(' ')).toMatch(/not approved for production/);
  });
});
