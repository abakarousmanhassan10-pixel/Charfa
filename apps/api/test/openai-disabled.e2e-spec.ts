import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { aiHelpers, as } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * N23.1: the real OpenAI provider is selected and a key is present, but the server switch OPENAI_ENABLED is off (the default).
 * Nothing may be sent: every call is refused as "not configured" and a spy proves no HTTP request is made.
 */
const CANARY = 'sk-canary-Disabled-0123456789abcdef';

describe('OpenAI disabled by default (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    set('AI_PROVIDER', 'openai');
    set('OPENAI_API_KEY', CANARY);
    set('OPENAI_ENABLED', undefined); // default = off
    set('OPENAI_BASE_URL', undefined);
    await resetDb();
    app = await startApp();
    h = aiHelpers(app);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterAll(async () => {
    fetchSpy.mockRestore();
    await app.close();
    await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('reports a disabled AI (not simulated, not real) and exposes no key', async () => {
    const t = await h.tenant('Off Shop');
    const status = (await request(h.http).get('/api/v1/ai/status').set(as(t)).expect(200)).body;
    expect(status).toMatchObject({ configured: false, mode: 'disabled', realSwitch: false, provider: 'openai' });
    expect(JSON.stringify(status)).not.toContain(CANARY);
  });

  it('refuses generation with AI_NOT_CONFIGURED, creates no job and sends no request', async () => {
    const t = await h.tenant('Off Shop 2');
    const res = await h.submitAnalysis(t).expect(503);
    expect(res.body.code ?? res.body.error?.code).toBe('AI_NOT_CONFIGURED');
    expect(await prisma.aIGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
