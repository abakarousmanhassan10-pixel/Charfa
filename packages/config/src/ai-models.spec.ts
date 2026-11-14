import { loadEnv, modelFor, productionProblems } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('AI models by configuration', () => {
  it('uses AI_MODEL for every task unless a task has its own model', () => {
    const env = loadEnv({ ...valid, AI_MODEL: 'default-model', AI_TASK_MODELS: '{"CONTENT":"copy-model","PRODUCT_ANALYSIS":"analysis-model"}' });
    expect(modelFor(env, 'CONTENT')).toBe('copy-model');
    expect(modelFor(env, 'PRODUCT_ANALYSIS')).toBe('analysis-model');
    expect(modelFor(env, 'STORYBOARD')).toBe('default-model');
    expect(modelFor(loadEnv(valid), 'CONTENT')).toBe('gpt-4o-mini'); // the default is configuration too, not a constant in the agents
  });
  it('refuses a typo or a bad value instead of silently using the default', () => {
    expect(() => loadEnv({ ...valid, AI_TASK_MODELS: '{"CONTENTS":"x"}' })).toThrow(/unknown task "CONTENTS"/);
    expect(() => loadEnv({ ...valid, AI_TASK_MODELS: '{"CONTENT":""}' })).toThrow(/invalid model/);
    expect(() => loadEnv({ ...valid, AI_TASK_MODELS: '{"CONTENT":"two words"}' })).toThrow(/invalid model/);
    expect(() => loadEnv({ ...valid, AI_TASK_MODELS: '[1]' })).toThrow(/JSON object/);
    expect(() => loadEnv({ ...valid, AI_TASK_MODELS: 'not json' })).toThrow(/JSON object/);
    expect(loadEnv({ ...valid, AI_TASK_MODELS: '' }).AI_TASK_MODELS).toEqual({});
  });
  it('the mock OpenAI provider is only accepted in the test environment, and never in production', () => {
    expect(loadEnv({ ...valid, APP_ENV: 'test', AI_PROVIDER: 'mock-openai' }).AI_PROVIDER).toBe('mock-openai');
    expect(() => loadEnv({ ...valid, APP_ENV: 'local', AI_PROVIDER: 'mock-openai' })).toThrow(/only allowed when APP_ENV=test/);
    const env = loadEnv({ ...valid, APP_ENV: 'test', AI_PROVIDER: 'mock-openai' });
    expect(productionProblems(env).join(' ')).toMatch(/AI_PROVIDER=mock-openai is test-only/);
  });
});
