import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { fakeDefaultAnswer, type FakeTextProvider } from '@touma/ai-engine';
import type { BusinessRole } from '@touma/database';
import { prisma, register } from './helpers';

export type Ctx = { token: string; businessId: string };
export const as = (c: Ctx) => ({ Authorization: `Bearer ${c.token}`, 'X-Business-Id': c.businessId });

/** Test fixtures and polling helpers for the AI suites (real PostgreSQL, Redis and BullMQ; test-only provider). */
export function aiHelpers(app: INestApplication) {
  const http = app.getHttpServer();

  async function tenant(name = 'Café Awa') {
    const u = await register(app);
    const b = await request(http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name, type: 'RESTAURANT', currency: 'XAF', city: "N'Djamena", country: 'TD' }).expect(201);
    const c: Ctx = { token: u.accessToken, businessId: b.body.id as string };
    const p = await request(http).post('/api/v1/products').set(as(c)).send({ name: `${name} Bissap juice`, price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers', 'Served cold'], benefits: ['Refreshing'] }).expect(201);
    const s = await request(http).post('/api/v1/services').set(as(c)).send({ name: `${name} Catering`, status: 'ACTIVE', durationMinutes: 180 }).expect(201);
    return { ...c, productId: p.body.id as string, serviceId: s.body.id as string, userEmail: u.email };
  }

  async function member(owner: Ctx, role: BusinessRole): Promise<Ctx & { userId: string }> {
    const u = await register(app);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } });
    await prisma.membership.create({ data: { userId: user.id, businessId: owner.businessId, role, status: 'ACTIVE' } });
    return { token: u.accessToken, businessId: owner.businessId, userId: user.id };
  }

  /** Polls the job status until the generation is final, then returns the full generation response. */
  async function settled(c: Ctx, id: string, timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const st = await request(http).get(`/api/v1/ai/generations/${id}/status`).set(as(c)).expect(200);
      if (st.body.final) break;
      if (Date.now() > until) throw new Error(`generation ${id} still ${st.body.status} after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
    // The generation turns final before its quota reservation is settled; wait for both.
    await waitFor(async () => {
      const r = await prisma.aIReservation.findUnique({ where: { generationId: id } });
      return !r || r.status !== 'RESERVED';
    });
    return request(http).get(`/api/v1/ai/generations/${id}`).set(as(c)).expect(200);
  }

  const submitContent = (c: Ctx, body: Record<string, unknown> = {}) =>
    request(http).post('/api/v1/ai/content').set(as(c)).send({ format: 'INSTAGRAM_CAPTION', purpose: 'PROMOTIONAL', tone: 'FRIENDLY', language: 'en', ...body });
  const submitAnalysis = (c: Ctx, language = 'en') => request(http).post('/api/v1/ai/business-analysis').set(as(c)).send({ language });

  const gates: Array<() => void> = [];
  /** Opens every gate still closed; call after each test so a held provider call can never block the worker. */
  const releaseAll = () => gates.splice(0).forEach((g) => g());

  /** Holds the next `n` provider calls until release() is called, keeping jobs in flight on demand. */
  function gate(fake: FakeTextProvider, n: number) {
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    gates.push(() => release());
    for (let i = 0; i < n; i++) {
      fake.enqueue(async (req) => {
        await open;
        return JSON.stringify(fakeDefaultAnswer(req));
      });
    }
    return release;
  }

  async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Waits until no job of this business is queued or running. */
  const idle = (businessId: string) => waitFor(async () => (await prisma.aIGeneration.count({ where: { businessId, status: { in: ['QUEUED', 'RUNNING'] } } })) === 0);

  const period = (businessId: string) => prisma.aIUsagePeriod.findFirst({ where: { businessId }, orderBy: { periodStart: 'desc' } });

  return { http, tenant, member, settled, submitContent, submitAnalysis, gate, releaseAll, waitFor, idle, period };
}
