import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { aiHelpers, as } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * The real OpenAI provider is configured with a CANARY key and pointed at a closed local port, so no request can leave this machine.
 * The key must appear nowhere a browser, a log or the database could show it.
 */
const CANARY = 'sk-canary-DoNotLeak-0123456789abcdef';

describe('OpenAI key security (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v; };
  let app: INestApplication;
  let h: ReturnType<typeof aiHelpers>;
  const out: string[] = [];

  beforeAll(async () => {
    set('AI_PROVIDER', 'openai');
    set('OPENAI_API_KEY', CANARY);
    set('OPENAI_BASE_URL', 'http://127.0.0.1:9'); // closed port: nothing is sent anywhere
    set('AI_MAX_PROVIDER_RETRIES', '0');
    set('AI_JOB_ATTEMPTS', '1');
    await resetDb();
    app = await startApp();
    h = aiHelpers(app);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      (stream as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => { out.push(String(c)); return (write as (c: unknown, ...a: unknown[]) => boolean)(c, ...a); };
    }
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('never returns the key to the browser and never sends it to the web app', async () => {
    const t = await h.tenant('Key Shop');
    const status = (await request(h.http).get('/api/v1/ai/status').set(as(t)).expect(200)).body;
    expect(status).toMatchObject({ configured: true, provider: 'openai' });
    const bodies = [
      JSON.stringify(status),
      JSON.stringify((await request(h.http).get('/api/v1/features').set(as(t)).expect(200)).body),
      JSON.stringify((await request(h.http).get('/api/v1/businesses').set(as(t)).expect(200)).body),
      JSON.stringify((await request(h.http).get('/api/v1/ai/generations').set(as(t)).expect(200)).body),
    ];
    for (const b of bodies) expect(b).not.toContain(CANARY);
    expect(JSON.stringify(status)).not.toMatch(/sk-|api[_-]?key|secret/i);
  });

  it('a failing provider call stores and logs no key, no prompt and no business data', async () => {
    const t = await h.tenant('Key Shop 2');
    const res = await h.submitAnalysis(t).expect(202);
    const done = (await h.settled(t, res.body.id)).body;
    expect(done.status).toBe('FAILED');
    expect(['AI_PROVIDER_ERROR', 'AI_PROVIDER_TIMEOUT']).toContain(done.errorCode);
    const rows = JSON.stringify(await prisma.aIGeneration.findMany({ where: { businessId: t.businessId } }));
    const usage = JSON.stringify(await prisma.aIUsage.findMany({ where: { businessId: t.businessId } }));
    for (const text of [JSON.stringify(done), rows, usage, out.join('')]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toMatch(/Bearer\s+sk-/);
    }
    expect(out.join('')).not.toContain('Key Shop 2'); // the business name is not written to the logs by the AI path
  });
});
