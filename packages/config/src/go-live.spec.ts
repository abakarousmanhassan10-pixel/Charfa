import { loadEnv } from './env';
import { evaluateGoLive } from './go-live';

const valid = { APP_ENV: 'test', DATABASE_URL: 'postgresql://u:p@localhost:5432/d', REDIS_URL: 'redis://localhost:6379', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), STORAGE_DRIVER: 'memory', AI_PROVIDER: 'fake', IMAGE_PROVIDER: 'fake', VIDEO_PROVIDER: 'fake', SOCIAL_PROVIDER_MODE: 'fake' } as Record<string, string>;
/** A non-test base: no simulator allowed, durable storage, real text AI, nothing paid yet. */
const dev = { ...valid, APP_ENV: 'development', AI_PROVIDER: 'openai', IMAGE_PROVIDER: 'none', VIDEO_PROVIDER: 'none', SOCIAL_PROVIDER_MODE: 'live', STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://localhost:9000', S3_REGION: 'auto', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' } as Record<string, string>;
const PRICES = JSON.stringify({ 'gpt-image-1': { perImageUsd: 0.04 }, 'vid-1': { perSecondUsd: 0.1 } });

describe('paid generation guard (loadEnv)', () => {
  it('a real image provider with a key refuses to start without the switch, the platform cap and a price', () => {
    const base = { ...dev, IMAGE_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real' };
    expect(() => loadEnv(base)).toThrow(/PAID_GENERATION_ENABLED/);
    expect(() => loadEnv({ ...base, PAID_GENERATION_ENABLED: 'true' })).toThrow(/CREATIVE_PLATFORM_MONTHLY_CAP_MICROS/);
    expect(() => loadEnv({ ...base, PAID_GENERATION_ENABLED: 'true', CREATIVE_PLATFORM_MONTHLY_CAP_MICROS: '50000000' })).toThrow(/price for gpt-image-1/);
    expect(loadEnv({ ...base, PAID_GENERATION_ENABLED: 'true', CREATIVE_PLATFORM_MONTHLY_CAP_MICROS: '50000000', CREATIVE_MODEL_PRICING: PRICES }).PAID_GENERATION_ENABLED).toBe(true);
  });
  it('a real video provider also needs its own model price', () => {
    const base = { ...dev, VIDEO_PROVIDER: 'openai', VIDEO_MODEL: 'vid-1', OPENAI_API_KEY: 'sk-test-not-real', PAID_GENERATION_ENABLED: 'true', CREATIVE_PLATFORM_MONTHLY_CAP_MICROS: '1000000' };
    expect(() => loadEnv(base)).toThrow(/price for vid-1/);
    expect(loadEnv({ ...base, CREATIVE_MODEL_PRICING: PRICES }).VIDEO_PROVIDER).toBe('openai');
  });
  it('a DEFAULT image provider with a key (text-only deployment) is switched off, not refused: no spending, no crash', () => {
    const e = loadEnv({ ...dev, OPENAI_API_KEY: 'sk-test-not-real', IMAGE_PROVIDER: undefined } as unknown as Record<string, string>);
    expect(e.IMAGE_PROVIDER).toBe('none');
    expect(evaluateGoLive(e).capabilities.find((c) => c.id === 'creative-images')).toMatchObject({ mode: 'disabled' });
  });
  it('is not triggered without a key, by the simulators, or by free test mode', () => {
    expect(() => loadEnv({ ...dev, IMAGE_PROVIDER: 'openai' })).not.toThrow(); // no key: cannot spend
    expect(() => loadEnv({ ...valid, CREATIVE_STUDIO_MODE: 'mock', OPENAI_API_KEY: 'sk-test-not-real' })).not.toThrow();
  });
});

describe('go-live report', () => {
  const report = (o: Record<string, string>) => evaluateGoLive(loadEnv({ ...valid, ...o }));
  it('a simulated demo is reported as SIMULATION, never as ready', () => {
    const r = report({ CREATIVE_STUDIO_MODE: 'mock' });
    expect(r.overall).toBe('SIMULATION');
    expect(r.capabilities.find((c) => c.id === 'creative-images')).toMatchObject({ mode: 'simulated', ok: true });
    expect(r.capabilities.find((c) => c.id === 'storage')).toMatchObject({ mode: 'simulated', ok: false });
    expect(r.capabilities.find((c) => c.id === 'email')?.missing).toContain('EMAIL_TRANSPORT=smtp');
  });
  it('lists exactly what a real configuration still lacks, by variable name only', () => {
    const r = evaluateGoLive(loadEnv({ ...dev, IMAGE_PROVIDER: 'openai', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' }));
    expect(r.overall).toBe('REAL_BLOCKED');
    expect(r.capabilities.find((c) => c.id === 'creative-images')?.missing).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'PAID_GENERATION_ENABLED=true', 'CREATIVE_PLATFORM_MONTHLY_CAP_MICROS']));
    expect(r.capabilities.find((c) => c.id === 'storage')?.missing).toEqual(expect.arrayContaining(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']));
    expect(r.blockers.length).toBeGreaterThan(3);
  });
  it('real e-mail or storage alone does not make a deployment "real": only external effects do', () => {
    const r = report({ CREATIVE_STUDIO_MODE: 'mock', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.test' });
    expect(r.capabilities.find((c) => c.id === 'email')).toMatchObject({ mode: 'real', ok: true });
    expect(r.overall).toBe('SIMULATION');
  });
  it('never contains a secret value', () => {
    const r = report({ OPENAI_API_KEY: 'sk-super-secret-value', JWT_ACCESS_SECRET: 'x'.repeat(40) });
    expect(JSON.stringify(r)).not.toMatch(/sk-super-secret-value|postgresql:|xxxxxxxx/);
  });
});
