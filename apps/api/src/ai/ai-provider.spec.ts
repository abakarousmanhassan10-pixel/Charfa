import { FakeTextProvider, OpenAIProvider } from '@touma/ai-engine';
import { loadEnv } from '@touma/config';
import { aiMode, createTextProvider } from './ai-provider';

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
  it('stays disabled with a key when the server switch is off (default)', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const env = loadEnv({ ...base, OPENAI_API_KEY: 'sk-from-env' });
    expect(env.OPENAI_ENABLED).toBe(false);
    const p = createTextProvider(env);
    expect(p.isConfigured()).toBe(false);
    expect(aiMode(env, p.isConfigured())).toBe('disabled');
    await expect(p.generate({ model: 'm', system: 's', user: 'u', schemaName: 'x', jsonSchema: { type: 'object' }, maxOutputTokens: 10, timeoutMs: 1000 } as never)).rejects.toThrow(/not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('is configured only with the switch on AND a key', () => {
    const env = loadEnv({ ...base, OPENAI_API_KEY: 'sk-from-env', OPENAI_ENABLED: 'true' });
    const p = createTextProvider(env);
    expect(p.isConfigured()).toBe(true);
    expect(aiMode(env, true)).toBe('real');
    expect(createTextProvider(loadEnv({ ...base, OPENAI_ENABLED: 'true' })).isConfigured()).toBe(false);
  });
  it('reports the test providers as simulated', () => {
    expect(aiMode(loadEnv({ ...base, AI_PROVIDER: 'mock-openai', APP_ENV: 'test' }), true)).toBe('simulated');
  });
  it('only builds the fake provider in the test environment', () => {
    expect(createTextProvider(loadEnv({ ...base, AI_PROVIDER: 'fake', APP_ENV: 'test' }))).toBeInstanceOf(FakeTextProvider);
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'fake', APP_ENV: 'staging' })).toThrow();
  });
});
