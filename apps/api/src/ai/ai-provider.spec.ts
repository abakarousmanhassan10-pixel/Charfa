import { FakeTextProvider, OpenAIProvider } from '@touma/ai-engine';
import { loadEnv } from '@touma/config';
import { createTextProvider } from './ai-provider';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('createTextProvider', () => {
  it('uses OpenAI by default and reports "not configured" without a key', () => {
    const p = createTextProvider(loadEnv(base));
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.isConfigured()).toBe(false);
  });
  it('is configured with a key from the environment', () => {
    expect(createTextProvider(loadEnv({ ...base, OPENAI_API_KEY: 'sk-from-env' })).isConfigured()).toBe(true);
  });
  it('only builds the fake provider in the test environment', () => {
    expect(createTextProvider(loadEnv({ ...base, AI_PROVIDER: 'fake', APP_ENV: 'test' }))).toBeInstanceOf(FakeTextProvider);
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'fake', APP_ENV: 'staging' })).toThrow();
  });
});
