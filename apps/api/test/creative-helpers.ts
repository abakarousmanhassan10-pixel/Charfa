import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma } from './helpers';

/** A product photo on a plain white studio backdrop: a red disc with a blue label. */
export async function studioPhoto(size = 800) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#ffffff"/><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.3}" fill="#d01010"/><rect x="${size * 0.4}" y="${size * 0.45}" width="${size * 0.2}" height="${size * 0.1}" fill="#1020c0"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
/** A busy photo: no plain background to cut the product out of. */
export const noisyPhoto = () => sharp({ create: { width: 400, height: 400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 }, background: '#808080' } }).png().toBuffer();

export function creativeHelpers(app: INestApplication) {
  const ai = aiHelpers(app);
  const http = app.getHttpServer();

  async function upload(c: Ctx, data: Buffer, filename = 'photo.png', contentType = 'image/png') {
    const res = await request(http).post('/api/v1/media').set(as(c)).attach('file', data, { filename, contentType }).expect(201);
    return res.body as { id: string; url: string };
  }

  const submitImage = (c: Ctx, body: Record<string, unknown> = {}, key?: string) => {
    const req = request(http).post('/api/v1/creative/images').set(as(c));
    if (key) req.set('Idempotency-Key', key);
    return req.send({ type: 'PRODUCT_AD', aspectRatio: '1:1', ...body });
  };
  const submitVideo = (c: Ctx, body: Record<string, unknown> = {}, key?: string) => {
    const req = request(http).post('/api/v1/creative/videos').set(as(c));
    if (key) req.set('Idempotency-Key', key);
    return req.send({ format: 'SHORT_VERTICAL', seconds: 8, ...body });
  };

  /** Polls the job until final and its quota reservation is settled; returns the full generation. */
  async function finished(c: Ctx, id: string, timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const st = await request(http).get(`/api/v1/creative/generations/${id}/status`).set(as(c)).expect(200);
      if (st.body.final) break;
      if (Date.now() > until) throw new Error(`generation ${id} still ${st.body.status} (${st.body.providerStatus}) after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await ai.waitFor(async () => (await prisma.creativeGeneration.findUnique({ where: { id }, select: { settledAt: true } }))?.settledAt);
    return (await request(http).get(`/api/v1/creative/generations/${id}`).set(as(c)).expect(200)).body;
  }

  const period = (businessId: string) => prisma.aIUsagePeriod.findFirst({ where: { businessId }, orderBy: { periodStart: 'desc' } });
  const withPlan = async (businessId: string, limits: Record<string, number>) => {
    const plan = await prisma.plan.upsert({ where: { code: 'STARTER' }, create: { code: 'STARTER', name: 'Starter', priceAmount: 0, limits }, update: { limits } });
    await prisma.subscription.upsert({ where: { businessId }, create: { businessId, planId: plan.id, status: 'ACTIVE' }, update: { planId: plan.id, status: 'ACTIVE' } });
  };
  /** Downloads a signed media URL (no bearer token: that is how <img> and <video> load it). */
  const download = (url: string) => request(http).get(url).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  return { ...ai, upload, submitImage, submitVideo, finished, period, withPlan, download };
}
