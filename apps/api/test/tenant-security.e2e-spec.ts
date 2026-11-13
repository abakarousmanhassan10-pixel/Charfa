import { readFileSync } from 'fs';
import { join } from 'path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { creativeHelpers } from './creative-helpers';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Phase N10: (A) the customer chat secret never travels in a URL, expires and can be revoked; (B) per-tenant limits on
 * queued/running work are atomic, refuse safely, and free their slot on failure or cancellation; (C) isolation checks.
 */
describe('Chat token and tenant quotas (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function shop() {
    const t = await h.tenant(`Shop ${++n}`);
    const admin = await h.member(t, 'ADMIN');
    const editor = await h.member(t, 'EDITOR');
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
    await request(http).put('/api/v1/sales/agent').set(as(admin)).send({ enabled: true, replyMode: 'AUTO', languages: ['en'], defaultLanguage: 'en' }).expect(200);
    return { t, admin, editor, slug };
  }
  const chat = (slug: string) => ({
    start: (message = 'How much is the Bissap juice?') => request(http).post(`/api/v1/public/chat/${slug}/messages`).send({ message }),
    send: (token: string, message = 'And delivery?') => request(http).post(`/api/v1/public/chat/${slug}/messages`).send({ message, token }),
    poll: (token?: string) => { const r = request(http).get(`/api/v1/public/chat/${slug}/messages`); return token ? r.set('x-chat-token', token) : r; },
    erase: (token: string) => request(http).delete(`/api/v1/public/chat/${slug}/data`).set('x-chat-token', token),
  });

  describe('A. client chat token', () => {
    it('works from a header, is refused in a URL, and is never echoed back', async () => {
      const s = await shop();
      const first = await chat(s.slug).start().expect(200);
      const token = first.body.token as string;
      const ok = await chat(s.slug).poll(token).expect(200);
      expect(JSON.stringify(ok.body)).not.toContain(token); // only the first answer carries it, once
      await request(http).get(`/api/v1/public/chat/${s.slug}/messages`).query({ token }).expect(404); // a URL token is ignored
      await request(http).delete(`/api/v1/public/chat/${s.slug}/data`).query({ token }).expect(404);
      await chat(s.slug).poll().expect(404); // missing
      await chat(s.slug).poll('short').expect(404); // malformed: same answer as unknown, nothing to probe
      await chat(s.slug).poll('A'.repeat(48)).expect(404);
      await chat(s.slug).send(token).expect(200); // POST keeps the token in the body
      // The shipped web client uses the header too.
      const page = readFileSync(join(__dirname, '../../web/app/chat/[slug]/page.tsx'), 'utf8');
      expect(page).not.toMatch(/token=/);
      expect(page).toContain("'x-chat-token'");
    });

    it('expires after the idle lifetime and a new message renews it', async () => {
      const s = await shop();
      const token = (await chat(s.slug).start().expect(200)).body.token as string;
      const conv = await prisma.conversation.findFirstOrThrow({ where: { businessId: s.t.businessId } });
      await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(Date.now() - 8 * 86_400_000) } }); // idle lifetime: 7 days
      await chat(s.slug).poll(token).expect(404);
      await chat(s.slug).send(token).expect(404); // cannot be used to continue either
      await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(Date.now() - 6 * 86_400_000) } });
      await chat(s.slug).send(token).expect(200); // still valid: a message renews it
      await chat(s.slug).poll(token).expect(200);
    });

    it('is revoked by the customer\'s erasure, and cannot be used in another shop', async () => {
      const a = await shop();
      const b = await shop();
      const token = (await chat(a.slug).start().expect(200)).body.token as string;
      await chat(b.slug).poll(token).expect(404);
      await chat(b.slug).erase(token).expect(404);
      await chat(a.slug).poll(token).expect(200);
      await chat(a.slug).erase(token).expect(200);
      await chat(a.slug).poll(token).expect(404);
      await chat(a.slug).send(token).expect(404);
    });
  });

  describe('B. tenant quotas', () => {
    const wfDef = { triggers: [{ type: 'manual' }], steps: [{ key: 'draft', adapter: 'simulated.content-draft' }, { key: 'act', adapter: 'simulated.calendar-schedule', dependsOn: ['draft'], requiresApproval: true }] };
    async function workflow(s: Awaited<ReturnType<typeof shop>>) {
      const wf = (await request(http).post('/api/v1/workflows').set(as(s.admin)).send({ name: `WF ${n}`, definition: wfDef }).expect(201)).body;
      await request(http).post(`/api/v1/workflows/${wf.id}/activate`).set(as(s.admin)).expect(200);
      return wf as { id: string };
    }
    const startRun = (s: { editor: Ctx }, wfId: string, i: number) => request(http).post(`/api/v1/workflows/${wfId}/executions`).set(as(s.editor)).set('Idempotency-Key', `n10-${wfId}-${i}-${'k'.repeat(10)}`).send({ input: {} });

    it('runs: concurrent submissions never exceed the limit, a cancelled run frees its slot, other tenants are unaffected', async () => {
      const a = await shop();
      const b = await shop();
      const wa = await workflow(a);
      const wb = await workflow(b);
      const limit = 5; // ORCHESTRATOR_MAX_ACTIVE_RUNS_PER_BUSINESS default
      const results = await Promise.all(Array.from({ length: 14 }, (_, i) => startRun(a, wa.id, i)));
      const accepted = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(limit);
      expect(refused).toHaveLength(14 - limit);
      expect(refused[0]!.body.code).toBe('RUN_LIMIT_REACHED');
      expect(await prisma.agentRun.count({ where: { businessId: a.t.businessId } })).toBe(limit);
      expect((await startRun(b, wb.id, 0)).status).toBe(201); // another tenant has its own budget
      // Idempotent replays are not refused and do not consume a slot.
      expect((await startRun(a, wa.id, 0)).body.id).toBe(accepted[0]!.body.id);
      // Cancelling frees a slot at once.
      await request(http).post(`/api/v1/runs/${accepted[0]!.body.id}/cancel`).set(as(a.admin)).expect(200);
      expect((await startRun(a, wa.id, 100)).status).toBe(201);
      expect((await startRun(a, wa.id, 101)).status).toBe(429);
    });

    it('text AI: refuses beyond the in-flight limit before charging anything, frees the slot when a generation fails, never touches another tenant', async () => {
      const a = await shop();
      const b = await shop();
      const plant = (businessId: string) => prisma.aIGeneration.create({ data: { businessId, task: 'BUSINESS_ANALYSIS', status: 'QUEUED', language: 'en', params: {}, provider: 'fake', model: 'm', promptVersion: 'v', contextHash: 'h' } });
      const rows = await Promise.all(Array.from({ length: 8 }, () => plant(a.t.businessId))); // AI_MAX_INFLIGHT_PER_BUSINESS = 8 in tests
      const reservations = () => prisma.aIReservation.count({ where: { businessId: a.t.businessId } });
      const before = await reservations();
      const res = await request(http).post('/api/v1/ai/business-analysis').set(as(a.editor)).send({ language: 'en' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('AI_QUEUE_LIMIT');
      expect(await reservations()).toBe(before); // nothing was reserved or charged
      await request(http).post('/api/v1/ai/business-analysis').set(as(b.editor)).send({ language: 'en' }).expect(202); // other tenant unaffected
      await prisma.aIGeneration.update({ where: { id: rows[0]!.id }, data: { status: 'FAILED', completedAt: new Date() } }); // a failure frees the slot
      await request(http).post('/api/v1/ai/business-analysis').set(as(a.editor)).send({ language: 'en' }).expect(202);
    });

    it('creative: refuses beyond the in-flight limit without reserving quota, and a finished job frees the slot', async () => {
      const a = await shop();
      const b = await shop();
      const body = { type: 'LIFESTYLE', aspectRatio: '1:1' };
      const plant = (businessId: string) => prisma.creativeGeneration.create({ data: { businessId, kind: 'IMAGE', status: 'QUEUED', provider: 'fake', model: 'm', prompt: 'p', params: {}, requestedUnits: 1, reservedUnits: 0, unitKind: 'IMAGE', periodStart: new Date() } });
      const rows = await Promise.all(Array.from({ length: 25 }, () => plant(a.t.businessId))); // CREATIVE_MAX_INFLIGHT_PER_BUSINESS = 25 in tests
      const res = await h.submitImage(a.editor, body);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('CREATIVE_QUEUE_LIMIT');
      expect((await h.period(a.t.businessId))?.reservedImages ?? 0).toBe(0);
      await prisma.creativeGeneration.update({ where: { id: rows[0]!.id }, data: { status: 'FAILED', completedAt: new Date() } });
      const ok = await h.submitImage(a.editor, body);
      expect(ok.status).not.toBe(429);
      const other = await h.submitImage(b.editor, body);
      expect(other.status).not.toBe(429);
    });
  });

  describe('C. authorization across modules', () => {
    it('keeps conversations, workflow runs, calendar entries, AI jobs and ops endpoints inside their tenant', async () => {
      const a = await shop();
      const b = await shop();
      const token = (await chat(a.slug).start().expect(200)).body.token as string;
      const conv = await prisma.conversation.findFirstOrThrow({ where: { businessId: a.t.businessId } });
      await request(http).get(`/api/v1/sales/conversations/${conv.id}`).set(as(b.admin)).expect(404);
      await request(http).post(`/api/v1/sales/conversations/${conv.id}/takeover`).set(as(b.admin)).expect(404);
      await chat(b.slug).poll(token).expect(404);

      const ev = await prisma.calendarEvent.create({ data: { businessId: a.t.businessId, title: 'x', scheduledAt: new Date(Date.now() + 5 * 86_400_000), timezone: 'UTC', platform: 'INSTAGRAM' } });
      await request(http).get(`/api/v1/calendar/entries/${ev.id}`).set(as(b.admin)).expect(404);
      const gen = await prisma.aIGeneration.create({ data: { businessId: a.t.businessId, task: 'BUSINESS_ANALYSIS', status: 'SUCCEEDED', language: 'en', params: {}, provider: 'fake', model: 'm', promptVersion: 'v', contextHash: 'h' } });
      await request(http).get(`/api/v1/ai/generations/${gen.id}`).set(as(b.admin)).expect(404);
      await request(http).get(`/api/v1/ai/generations/${gen.id}/status`).set(as(b.admin)).expect(404);

      const wfRes = await request(http).post('/api/v1/workflows').set(as(a.admin)).send({ name: 'iso', definition: { triggers: [{ type: 'manual' }], steps: [{ key: 'd', adapter: 'simulated.content-draft' }] } }).expect(201);
      await request(http).post(`/api/v1/workflows/${wfRes.body.id}/activate`).set(as(a.admin)).expect(200);
      const run = (await request(http).post(`/api/v1/workflows/${wfRes.body.id}/executions`).set(as(a.editor)).set('Idempotency-Key', 'n10-iso-key-0000001').send({ input: {} }).expect(201)).body;
      await request(http).get(`/api/v1/runs/${run.id}`).set(as(b.admin)).expect(404);
      await request(http).post(`/api/v1/workflows/${wfRes.body.id}/executions`).set(as(b.editor)).set('Idempotency-Key', 'n10-iso-key-0000002').send({ input: {} }).expect(404);

      // Tenant roles, even OWNER, are not platform administrators.
      for (const path of ['/overview', '/alerts', '/queues/history']) await request(http).get(`/api/v1/admin/ops${path}`).set(as(a.t)).expect(403);
    });
  });
});
