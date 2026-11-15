import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as } from './ai-helpers';
import { creativeHelpers } from './creative-helpers';
import { prisma, resetDb, startApp } from './helpers';

/** N25 MVP additions to the existing Creative Studio: responsible-content gate, daily caps, spend history, honest provider registry, labelled simulators. */
const ENV: Record<string, string> = { CREATIVE_DAILY_IMAGES_PER_BUSINESS: '3', CREATIVE_DAILY_VIDEO_SECONDS_PER_BUSINESS: '12', CREATIVE_MONTHLY_IMAGES_PER_BUSINESS: '100' };

describe('Creative Studio: responsible content, caps and spend (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let n = 0;
  const tenant = () => h.tenant(`Studio ${++n}`);

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const photo = async (t: Awaited<ReturnType<typeof tenant>>) => {
    const sharp = (await import('sharp')).default;
    const data = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#ffffff' } }).png().toBuffer();
    return h.upload(t, data, 'product.png', 'image/png');
  };

  it('a reference photo needs the rights declaration, a real person needs consent; nothing is queued or reserved when refused', async () => {
    const t = await tenant();
    const p = await photo(t);
    const r1 = await h.submitImage(t, { sourceMediaId: p.id, rightsConfirmed: false }).expect(422);
    expect(r1.body.code).toBe('RIGHTS_CONFIRMATION_REQUIRED');
    const r2 = await h.submitImage(t, { sourceMediaId: p.id, rightsConfirmed: true, containsPerson: true }).expect(422);
    expect(r2.body.code).toBe('PERSON_CONSENT_REQUIRED');
    const r3 = await h.submitVideo(t, { sourceMediaId: p.id, rightsConfirmed: false }).expect(422);
    expect(r3.body.code).toBe('RIGHTS_CONFIRMATION_REQUIRED');
    expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
    const ok = await h.submitImage(t, { sourceMediaId: p.id, rightsConfirmed: true, containsPerson: true, personConsent: true, preservation: 'GUIDED' }).expect(202);
    await h.finished(t, ok.body.id);
    const row = await prisma.creativeGeneration.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect((row.params as { responsible: object }).responsible).toEqual({ rightsConfirmed: true, containsPerson: true, personConsent: true, aiDisclosure: true });
  });

  it('prohibited or misleading requests are refused before any work or cost', async () => {
    const t = await tenant();
    for (const instructions of ['Make a fake review from a happy customer', 'Add a deepfake of the mayor praising it', 'Show that this juice cures diabetes with guaranteed results']) {
      const r = await h.submitImage(t, { instructions }).expect(422);
      expect(r.body.code).toBe('CONTENT_NOT_ALLOWED');
    }
    await h.submitImage(t, { overlayText: 'Miracle cure!' }).expect(422);
    expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
    await h.submitImage(t, { instructions: 'A bright, friendly product scene' }).expect(202);
  });

  it('the daily cap stops further generations (images and video seconds) and does not touch other businesses', async () => {
    const t = await tenant();
    const other = await tenant();
    await h.finished(t, (await h.submitImage(t, { count: 2 }).expect(202)).body.id);
    await h.finished(t, (await h.submitImage(t, { count: 1 }).expect(202)).body.id);
    const r = await h.submitImage(t, { count: 1 }).expect(429);
    expect(r.body.code).toBe('CREATIVE_DAILY_LIMIT');
    await h.submitVideo(t, { seconds: 12 }).expect(202);
    expect((await h.submitVideo(t, { seconds: 4 }).expect(429)).body.code).toBe('CREATIVE_DAILY_LIMIT');
    await h.submitImage(other, { count: 3 }).expect(202); // the cap is per business
  });

  it('spend history: units per day with estimated cost, simulated generations flagged, isolated per business', async () => {
    const t = await tenant();
    const other = await tenant();
    await h.finished(t, (await h.submitImage(t, { count: 2 }).expect(202)).body.id);
    const s = (await request(h.http).get('/api/v1/creative/spend?days=7').set(as(t)).expect(200)).body;
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ images: 2, generations: 1, failed: 0, simulated: 1 });
    expect(s.note).toMatch(/not an invoice/);
    const o = (await request(h.http).get('/api/v1/creative/spend').set(as(other)).expect(200)).body;
    expect(o.items).toEqual([]);
    await request(h.http).get('/api/v1/creative/spend').expect(401);
  });

  it('the status lists providers honestly: simulators labelled, OpenAI unverified, Higgsfield and Kling not implemented, no Sora default', async () => {
    const t = await tenant();
    const st = (await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200)).body;
    const reg = st.providers as Array<{ id: string; kind: string; status: string; note: string }>;
    expect(reg.find((p) => p.id === 'higgsfield')!.status).toBe('NOT_IMPLEMENTED');
    expect(reg.find((p) => p.id === 'kling')!.status).toBe('NOT_IMPLEMENTED');
    expect(reg.find((p) => p.id === 'openai' && p.kind === 'video')!.status).toBe('IMPLEMENTED_UNVERIFIED');
    expect(reg.find((p) => p.id === 'mock')!.status).toBe('SIMULATED');
    expect(st.simulated).toEqual({ image: true, video: true }); // the test environment uses the fake simulators
    expect(st.disclosure).toMatch(/AI-generated/);
    expect(JSON.stringify(st)).not.toMatch(/sk-|apiKey|OPENAI_API_KEY/);
    expect(st.video.model).toBe('test-video-model'); // configured explicitly: no model is assumed
  });
});
