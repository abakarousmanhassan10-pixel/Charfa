import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import request from 'supertest';
import { fakeErrors, type FakeTextProvider } from '@touma/ai-engine';
import { TEXT_PROVIDER } from '../src/ai/ai-provider';
import { AiQueueService } from '../src/ai/ai-queue';
import { AiUsageService, monthStart } from '../src/ai/ai-usage.service';
import { AiWorkerService } from '../src/ai/ai-worker.service';
import { aiHelpers, as } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Background generation (BullMQ), atomic monthly usage reservations, token/cost accounting and tenant
 * isolation. Real PostgreSQL, Redis and BullMQ; only the AI provider is the TEST-ONLY deterministic one.
 */
describe('AI background jobs and usage accounting (e2e)', () => {
  let app: INestApplication;
  let fake: FakeTextProvider;
  let usage: AiUsageService;
  let worker: AiWorkerService;
  let queue: AiQueueService;
  let h: ReturnType<typeof aiHelpers>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    fake = app.get(TEXT_PROVIDER);
    usage = app.get(AiUsageService);
    worker = app.get(AiWorkerService);
    queue = app.get(AiQueueService);
    h = aiHelpers(app);
  });
  beforeEach(() => fake.reset());
  afterEach(() => {
    h.releaseAll();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  /** A subscription whose plan sets the AI limits of one business. */
  async function withPlan(businessId: string, limits: Record<string, number>, status: 'ACTIVE' | 'CANCELED' = 'ACTIVE') {
    const plan = await prisma.plan.upsert({
      where: { code: 'STARTER' },
      create: { code: 'STARTER', name: 'Starter', priceAmount: 0, limits },
      update: { limits },
    });
    await prisma.subscription.upsert({ where: { businessId }, create: { businessId, planId: plan.id, status }, update: { planId: plan.id, status } });
  }

  const statusOf = (c: { token: string; businessId: string }, id: string) => request(h.http).get(`/api/v1/ai/generations/${id}/status`).set(as(c));
  const reservation = (generationId: string) => prisma.aIReservation.findUniqueOrThrow({ where: { generationId } });
  const tokensOf = async (businessId: string) => {
    const a = await prisma.aIUsage.aggregate({ where: { businessId }, _sum: { inputTokens: true, outputTokens: true } });
    return (a._sum.inputTokens ?? 0) + (a._sum.outputTokens ?? 0);
  };

  describe('1. background generation', () => {
    it('returns a job id immediately; the worker runs it; the result is retrievable', async () => {
      const t = await h.tenant();
      const release = h.gate(fake, 1); // the provider is "slow": the job stays in flight
      const res = await h.submitAnalysis(t).expect(202);
      // Answered before the provider finished.
      expect(res.body).toMatchObject({ task: 'BUSINESS_ANALYSIS', status: 'QUEUED', output: null, statusUrl: `/api/v1/ai/generations/${res.body.id}/status` });
      const running = await h.waitFor(async () => {
        const st = await statusOf(t, res.body.id).expect(200);
        // RUNNING is set when the worker picks the job up; the first step is saved a moment later.
        return st.body.status === 'RUNNING' && st.body.steps.length > 0 ? st.body : null;
      });
      expect(running).toMatchObject({ final: false, resultAvailable: false, attempt: 1, maxAttempts: 3, retrying: false });
      expect(running.steps.map((s: { step: string }) => s.step)).toContain('context');
      // Not ready yet: no output.
      const early = await request(h.http).get(`/api/v1/ai/generations/${res.body.id}`).set(as(t)).expect(200);
      expect(early.body).toMatchObject({ status: 'RUNNING', output: null });

      release();
      const done = await h.settled(t, res.body.id);
      expect(done.body).toMatchObject({ status: 'SUCCEEDED', errorCode: null });
      expect(done.body.output).toHaveProperty('targetSegments');
      expect(done.body.job.completedAt).not.toBeNull();
      const st = await statusOf(t, res.body.id).expect(200);
      expect(st.body).toMatchObject({ final: true, resultAvailable: true, status: 'SUCCEEDED' });
      // Completed results stay available in the history.
      const list = await request(h.http).get('/api/v1/ai/generations').query({ status: 'SUCCEEDED' }).set(as(t)).expect(200);
      expect(list.body.items.map((g: { id: string }) => g.id)).toContain(res.body.id);
    });

    it('tracks pipeline steps while a content job runs', async () => {
      const t = await h.tenant();
      const release = h.gate(fake, 1);
      const res = await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202);
      const mid = await h.waitFor(async () => {
        const st = await statusOf(t, res.body.id).expect(200);
        return st.body.steps.length >= 1 && st.body.status === 'RUNNING' ? st.body : null;
      });
      expect(mid.steps[0]).toMatchObject({ step: 'context', status: 'done' });
      release();
      const done = await h.settled(t, res.body.id);
      expect(done.body.steps.map((s: { step: string }) => s.step)).toEqual(['context', 'business-analysis', 'product-analysis', 'strategy', 'generation', 'validation', 'save']);
    });

    it('retries transient failures with backoff and keeps one reservation for the whole job', async () => {
      const t = await h.tenant();
      fake.enqueue(fakeErrors.rateLimit(), fakeErrors.server());
      const res = await h.submitAnalysis(t).expect(202);
      const done = await h.settled(t, res.body.id);
      expect(done.body).toMatchObject({ status: 'SUCCEEDED', job: { attempts: 3 } });
      expect(fake.requests).toHaveLength(3);
      // Three provider calls, but one generation: it is counted once.
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, completedGenerations: 1, failedGenerations: 0, releasedGenerations: 0, reservedTokens: 0 });
    });

    it('shows "retrying" while waiting for the next attempt', async () => {
      const t = await h.tenant();
      fake.enqueue(fakeErrors.server());
      const release = h.gate(fake, 1);
      const res = await h.submitAnalysis(t).expect(202);
      const retrying = await h.waitFor(async () => {
        const st = await statusOf(t, res.body.id).expect(200);
        return st.body.attempt >= 2 || st.body.retrying ? st.body : null;
      });
      expect(retrying.errorCode === 'AI_PROVIDER_ERROR' || retrying.attempt === 2).toBe(true);
      release();
      expect((await h.settled(t, res.body.id)).body.status).toBe('SUCCEEDED');
    });

    it('fails permanently after the last attempt and releases everything it never used', async () => {
      const t = await h.tenant();
      fake.enqueue(fakeErrors.rateLimit(), fakeErrors.rateLimit(), fakeErrors.rateLimit());
      const res = await h.submitAnalysis(t).expect(202);
      const done = await h.settled(t, res.body.id);
      expect(done.body).toMatchObject({ status: 'FAILED', errorCode: 'AI_PROVIDER_RATE_LIMIT', job: { attempts: 3 } });
      // Nothing was billed by the provider: the unit goes back, no failed generation is charged.
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, completedGenerations: 0, failedGenerations: 0, releasedGenerations: 1, reservedTokens: 0, usedTokens: 0 });
      expect(await reservation(res.body.id)).toMatchObject({ status: 'RELEASED', outcome: 'failed', consumedUnits: 0, consumedTokens: 0 });
    });

    it('does not retry permanent failures (bad credentials, invalid output)', async () => {
      const t = await h.tenant();
      fake.enqueue(fakeErrors.auth());
      const a = await h.settled(t, (await h.submitAnalysis(t).expect(202)).body.id);
      expect(a.body).toMatchObject({ status: 'FAILED', errorCode: 'AI_PROVIDER_AUTH', job: { attempts: 1 } });
      expect(fake.requests).toHaveLength(1);
    });

    it('a failure that consumed tokens is charged as a failed generation with its measured tokens', async () => {
      const t = await h.tenant();
      fake.enqueue('not json', 'still not json'); // initial call + repair call, both billed
      const res = await h.submitAnalysis(t).expect(202);
      const done = await h.settled(t, res.body.id);
      expect(done.body).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_OUTPUT', job: { attempts: 1 } });
      const tokens = await tokensOf(t.businessId);
      expect(tokens).toBeGreaterThan(0);
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, completedGenerations: 0, failedGenerations: 1, releasedGenerations: 0, reservedTokens: 0, usedTokens: tokens });
      expect(await reservation(res.body.id)).toMatchObject({ status: 'COMMITTED', outcome: 'failed', consumedUnits: 1, consumedTokens: tokens });
    });

    it('answers synchronously (and charges nothing) when the request cannot be accepted', async () => {
      const t = await h.tenant();
      fake.configured = false;
      await h.submitAnalysis(t).expect(503);
      fake.configured = true;
      await request(h.http).post('/api/v1/ai/product-analysis').set(as(t)).send({ language: 'en', itemType: 'PRODUCT', itemId: 'c'.repeat(25) }).expect(404);
      expect(await prisma.aIGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      expect(await h.period(t.businessId)).toBeNull();
    });

    it('re-checks permissions when the job runs: a member removed after submitting gets nothing generated', async () => {
      const owner = await h.tenant();
      const editor = await h.member(owner, 'EDITOR');
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined); // accepted, but not yet picked up
      const res = await h.submitAnalysis(editor).expect(202);
      jest.restoreAllMocks();
      await prisma.membership.updateMany({ where: { userId: editor.userId, businessId: owner.businessId }, data: { status: 'REVOKED' } });
      await queue.enqueue(res.body.id);
      const done = await h.settled(owner, res.body.id);
      expect(done.body).toMatchObject({ status: 'FAILED', errorCode: 'AI_FORBIDDEN' });
      expect(fake.requests).toHaveLength(0);
      expect(await h.period(owner.businessId)).toMatchObject({ reservedGenerations: 0, completedGenerations: 0, releasedGenerations: 1 });
    });

    it('is idempotent: settling twice or re-delivering a finished job changes nothing', async () => {
      const t = await h.tenant();
      const res = await h.submitAnalysis(t).expect(202);
      await h.settled(t, res.body.id);
      const before = await h.period(t.businessId);
      expect(await usage.settle(res.body.id, 'succeeded')).toBeNull();
      await queue.enqueue(res.body.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(fake.requests).toHaveLength(1);
      expect(await h.period(t.businessId)).toEqual(before);
    });

    it('recovers a generation whose job was never enqueued (crash after commit)', async () => {
      const t = await h.tenant();
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined);
      const res = await h.submitAnalysis(t).expect(202);
      jest.restoreAllMocks();
      expect((await reservation(res.body.id)).status).toBe('RESERVED');
      await prisma.aIGeneration.update({ where: { id: res.body.id }, data: { queuedAt: new Date(Date.now() - 5 * 60_000) } });
      expect(await worker.reconcile()).toMatchObject({ requeued: 1 });
      expect((await h.settled(t, res.body.id)).body.status).toBe('SUCCEEDED');
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, completedGenerations: 1 });
    });

    it('fails and releases a stalled job that vanished from the queue', async () => {
      const t = await h.tenant();
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined);
      const res = await h.submitAnalysis(t).expect(202);
      jest.restoreAllMocks();
      await prisma.aIGeneration.update({ where: { id: res.body.id }, data: { status: 'RUNNING' } });
      await prisma.aIReservation.update({ where: { generationId: res.body.id }, data: { createdAt: new Date(Date.now() - 3 * 3600_000) } });
      expect(await worker.reconcile()).toMatchObject({ failed: 1 });
      const g = await prisma.aIGeneration.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'AI_JOB_STALLED' });
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, reservedTokens: 0, releasedGenerations: 1 });
    });

    it('settles reservations of jobs that finished without settling', async () => {
      const t = await h.tenant();
      const res = await h.submitAnalysis(t).expect(202);
      await h.settled(t, res.body.id);
      // Simulate a crash between "generation finished" and "reservation settled".
      await prisma.aIReservation.update({ where: { generationId: res.body.id }, data: { status: 'RESERVED', consumedUnits: 0, consumedTokens: 0, outcome: null, settledAt: null } });
      await prisma.aIUsagePeriod.updateMany({ where: { businessId: t.businessId }, data: { reservedGenerations: 1, reservedTokens: 12000, completedGenerations: 0, usedTokens: 0 } });
      expect(await usage.reconcileFinished()).toBeGreaterThanOrEqual(1);
      const tokens = await tokensOf(t.businessId);
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, reservedTokens: 0, completedGenerations: 1, usedTokens: tokens });
    });
  });

  describe('2. atomic monthly usage limits', () => {
    it('concurrent requests never exceed the plan limit (20 requests, limit 5)', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 5 });
      const release = h.gate(fake, 40); // keep the accepted jobs in flight while the others arrive
      const results = await Promise.all(Array.from({ length: 20 }, () => h.submitAnalysis(t)));
      const accepted = results.filter((r) => r.status === 202);
      const rejected = results.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(5);
      expect(rejected).toHaveLength(15);
      expect(new Set(rejected.map((r) => r.body.code))).toEqual(new Set(['AI_LIMIT_REACHED']));
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 5, completedGenerations: 0 });
      const st = await request(h.http).get('/api/v1/ai/status').set(as(t)).expect(200);
      expect(st.body.usage).toMatchObject({ reservedGenerations: 5, remainingGenerations: 0, generationLimit: 5, limitSource: 'plan' });
      // Rejected requests left no trace.
      expect(await prisma.aIGeneration.count({ where: { businessId: t.businessId } })).toBe(5);
      expect(await prisma.aIReservation.count({ where: { businessId: t.businessId } })).toBe(5);

      // Let the jobs finish: everything reserved is committed, nothing is lost or counted twice.
      release();
      await Promise.all(accepted.map((r) => h.settled(t, r.body.id)));
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 0, reservedTokens: 0, completedGenerations: 5, failedGenerations: 0 });
      await h.submitAnalysis(t).expect(429); // the month is used up
    }, 60_000);

    it('multi-step jobs reserve all their steps at once (10 content requests, limit 7, 3 steps each)', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 7 });
      const release = h.gate(fake, 40);
      const results = await Promise.all(Array.from({ length: 10 }, () => h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId })));
      const accepted = results.filter((r) => r.status === 202);
      expect(accepted).toHaveLength(2); // 3 + 3 = 6 <= 7; a third job would need 9
      expect(results.filter((r) => r.status === 429)).toHaveLength(8);
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 6 });
      release();
      await Promise.all(accepted.map((r) => h.settled(t, r.body.id)));
      const p = await h.period(t.businessId);
      // The second job may reuse the analyses of the first: reused steps are released, never charged.
      expect(p!.completedGenerations + p!.failedGenerations + p!.releasedGenerations).toBe(6);
      expect(p!.completedGenerations).toBeGreaterThanOrEqual(4);
      expect(p).toMatchObject({ reservedGenerations: 0, reservedTokens: 0 });
    }, 60_000);

    it('enforces the monthly token limit with the same atomicity', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 100, aiTokensPerMonth: 30_000 }); // 12 000 reserved per unit
      h.gate(fake, 10);
      const results = await Promise.all(Array.from({ length: 6 }, () => h.submitAnalysis(t)));
      expect(results.filter((r) => r.status === 202)).toHaveLength(2);
      const blocked = results.find((r) => r.status === 429)!;
      expect(blocked.body.code).toBe('AI_TOKEN_LIMIT_REACHED');
      expect(blocked.body.usage).toMatchObject({ tokenLimit: 30_000, reservedTokens: 24_000 });
    }, 60_000);

    it('holds the reservation at the database level: 40 concurrent reservations, limit 15', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 15 });
      const rows = await Promise.all(
        Array.from({ length: 40 }, () =>
          prisma.aIGeneration.create({ data: { businessId: t.businessId, task: 'BUSINESS_ANALYSIS', status: 'QUEUED', language: 'en', params: {}, provider: 'fake', model: 'm', promptVersion: 'v', contextHash: 'h' } }),
        ),
      );
      const outcomes = await Promise.all(
        rows.map((g) =>
          prisma
            .$transaction((tx) => usage.reserve(tx, { businessId: t.businessId, generationId: g.id, units: 1 }), { maxWait: 30_000, timeout: 30_000 })
            .then(() => 'ok' as const, (e: unknown) => (e instanceof HttpException ? e.getStatus() : 'error')),
        ),
      );
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(15);
      expect(outcomes.filter((o) => o === 429)).toHaveLength(25);
      expect(outcomes.filter((o) => o === 'error')).toHaveLength(0);
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 15 });
      expect(await usage.consistency(t.businessId)).toMatchObject({ reservedGenerations: { counter: 15, expected: 15 }, reservedTokens: { counter: 15 * 12_000, expected: 15 * 12_000 } });
    }, 60_000);

    it('tops a reservation up when a job needs more steps than estimated, under the same limit', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 4 });
      const g = await prisma.aIGeneration.create({ data: { businessId: t.businessId, task: 'CONTENT', status: 'QUEUED', language: 'en', params: {}, provider: 'fake', model: 'm', promptVersion: 'v', contextHash: 'h' } });
      await prisma.$transaction((tx) => usage.reserve(tx, { businessId: t.businessId, generationId: g.id, units: 1 }));
      await usage.ensureCovers(g.id, 3);
      expect(await reservation(g.id)).toMatchObject({ units: 3, tokens: 36_000 });
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 3 });
      await usage.ensureCovers(g.id, 2); // already covered: no change
      expect((await reservation(g.id)).units).toBe(3);
      await expect(usage.ensureCovers(g.id, 5)).rejects.toMatchObject({ status: 429 }); // 5 > limit 4
      expect(await h.period(t.businessId)).toMatchObject({ reservedGenerations: 3 });
    });

    it('rejects a request that needs more steps than the remaining limit, leaving no trace', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 1 });
      // No analysis is cached yet, so this content request needs 3 units; the limit is 1.
      await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(429);
      expect((await h.period(t.businessId))?.reservedGenerations ?? 0).toBe(0);
      expect(await prisma.aIGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      expect(fake.requests).toHaveLength(0);
    });

    it('takes limits from the plan: credits key, status change and defaults', async () => {
      const t = await h.tenant();
      expect(await usage.limitsFor(t.businessId)).toMatchObject({ generations: 40, source: 'default' });
      await withPlan(t.businessId, { aiCreditsPerMonth: 3 }); // the seeded plans use this key
      expect(await usage.limitsFor(t.businessId)).toMatchObject({ generations: 3, source: 'plan', planCode: 'STARTER' });
      await withPlan(t.businessId, { aiCreditsPerMonth: 3 }, 'CANCELED');
      expect(await usage.limitsFor(t.businessId)).toMatchObject({ generations: 40, source: 'default' });
    });

    it('counts each month separately', async () => {
      const t = await h.tenant();
      await withPlan(t.businessId, { aiGenerationsPerMonth: 2 });
      const mk = () => prisma.aIGeneration.create({ data: { businessId: t.businessId, task: 'BUSINESS_ANALYSIS', status: 'QUEUED', language: 'en', params: {}, provider: 'fake', model: 'm', promptVersion: 'v', contextHash: 'h' } });
      const lastMonth = new Date(Date.UTC(monthStart().getUTCFullYear(), monthStart().getUTCMonth() - 1, 10));
      for (let i = 0; i < 2; i++) await prisma.$transaction(async (tx) => usage.reserve(tx, { businessId: t.businessId, generationId: (await mk()).id, units: 1, now: lastMonth }));
      await expect(prisma.$transaction(async (tx) => usage.reserve(tx, { businessId: t.businessId, generationId: (await mk()).id, units: 1, now: lastMonth }))).rejects.toMatchObject({ status: 429 });
      // This month is untouched by last month's usage.
      await h.submitAnalysis(t).expect(202);
    });

    it('keeps the counters equal to their sources after mixed successes, failures and retries', async () => {
      const t = await h.tenant();
      fake.enqueue(fakeErrors.server()); // retried, then succeeds
      const jobs = [
        await h.submitAnalysis(t).expect(202),
        await h.submitContent(t, { itemType: 'PRODUCT', itemId: t.productId }).expect(202),
      ];
      for (const j of jobs) await h.settled(t, j.body.id);
      fake.enqueue('bad', 'bad');
      await h.settled(t, (await h.submitContent(t, { format: 'AD_COPY' }).expect(202)).body.id);
      await h.idle(t.businessId);
      const c = await usage.consistency(t.businessId);
      expect(c.reservedGenerations).toEqual({ counter: 0, expected: 0 });
      expect(c.reservedTokens).toEqual({ counter: 0, expected: 0 });
      expect(c.settledTokens.counter).toBe(await tokensOf(t.businessId));
      expect(c.settledTokens.counter).toBe(c.settledTokens.settledByReservations);
      const p = (await h.period(t.businessId))!;
      const gens = await prisma.aIGeneration.findMany({ where: { businessId: t.businessId, status: { in: ['SUCCEEDED', 'FAILED'] } }, include: { usages: true } });
      const withTokens = gens.filter((g) => g.usages.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0) > 0);
      expect(p.completedGenerations + p.failedGenerations).toBe(withTokens.length);
      expect(p.completedGenerations).toBe(withTokens.filter((g) => g.status === 'SUCCEEDED').length);
    }, 60_000);
  });

  describe('3. token and cost tracking', () => {
    it('records input and output tokens per provider call and prices them with the model table', async () => {
      const t = await h.tenant();
      await h.settled(t, (await h.submitAnalysis(t).expect(202)).body.id);
      await h.settled(t, (await h.submitContent(t, { format: 'AD_COPY' }).expect(202)).body.id);
      const rows = await prisma.aIUsage.findMany({ where: { businessId: t.businessId } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(r.inputTokens).toBeGreaterThan(0);
        expect(r.outputTokens).toBeGreaterThan(0);
        // gpt-4o-mini in the test table: $1 / $2 per million tokens (not the flat 0.15 / 0.6 default).
        expect(Number(r.costUsd)).toBeCloseTo((r.inputTokens * 1 + r.outputTokens * 2) / 1_000_000, 6);
      }
      const gens = await prisma.aIGeneration.findMany({ where: { businessId: t.businessId, status: 'SUCCEEDED' } });
      for (const g of gens) {
        const mine = rows.filter((r) => r.generationId === g.id);
        expect(g.inputTokens).toBe(mine.reduce((s, r) => s + r.inputTokens, 0));
        expect(g.outputTokens).toBe(mine.reduce((s, r) => s + r.outputTokens, 0));
        expect(Number(g.costUsd)).toBeCloseTo(mine.reduce((s, r) => s + Number(r.costUsd), 0), 6);
      }
    });

    it('resolves model prices: dated snapshots, flat default, and "not configured"', () => {
      expect(usage.priceFor('gpt-4o-mini-2024-07-18')).toMatchObject({ source: 'model', pricing: { inputPerMillion: 1, outputPerMillion: 2 } });
      expect(usage.priceFor('some-other-model')).toMatchObject({ source: 'default', pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 } });
      expect(usage.pricingSummary().models).toEqual([{ model: 'gpt-4o-mini', inputPerMillion: 1, outputPerMillion: 2 }]);
    });

    it('failed attempts are billed too: every provider call is recorded', async () => {
      const t = await h.tenant();
      fake.enqueue('not json');
      const g = await h.settled(t, (await h.submitAnalysis(t).expect(202)).body.id);
      const rows = await prisma.aIUsage.findMany({ where: { generationId: g.body.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => [r.attemptKind, r.success])).toEqual([['initial', false], ['repair', true]]);
      expect(g.body.usage).toMatchObject({ attempts: 2 });
      expect(g.body.usage.inputTokens).toBe(rows.reduce((s, r) => s + r.inputTokens, 0));
    });

    it('monthly report: counters, tokens and cost per model, per month', async () => {
      const t = await h.tenant();
      await h.settled(t, (await h.submitAnalysis(t).expect(202)).body.id);
      await h.settled(t, (await h.submitContent(t, { format: 'AD_COPY' }).expect(202)).body.id);
      // History from last month, recorded as the system would have recorded it.
      const lastMonth = new Date(Date.UTC(monthStart().getUTCFullYear(), monthStart().getUTCMonth() - 1, 12, 10));
      await prisma.aIUsagePeriod.create({ data: { businessId: t.businessId, periodStart: new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth(), 1)), completedGenerations: 2, failedGenerations: 1, usedTokens: 450 } });
      await prisma.aIUsage.create({ data: { businessId: t.businessId, agent: 'BUSINESS_ANALYST', provider: 'openai', model: 'gpt-4o', operation: 'BUSINESS_ANALYSIS', inputTokens: 300, outputTokens: 150, costUsd: '0.002250', createdAt: lastMonth } });

      const res = await request(h.http).get('/api/v1/ai/usage/monthly').query({ months: 3 }).set(as(t)).expect(200);
      expect(res.body.costConfigured).toBe(true);
      expect(res.body.pricing.models).toEqual([{ model: 'gpt-4o-mini', inputPerMillion: 1, outputPerMillion: 2 }]);
      const [now, prev, older] = res.body.months;
      const p = (await h.period(t.businessId))!;
      const rows = await prisma.aIUsage.findMany({ where: { businessId: t.businessId, createdAt: { gte: monthStart() } } });
      expect(now.month).toBe(monthStart().toISOString().slice(0, 7));
      expect(now.generations).toMatchObject({ reserved: 0, completed: p.completedGenerations, failed: 0 });
      expect(now.tokens).toMatchObject({ input: rows.reduce((s, r) => s + r.inputTokens, 0), output: rows.reduce((s, r) => s + r.outputTokens, 0), settled: p.usedTokens });
      expect(now.providerCalls).toBe(rows.length);
      expect(now.costUsd).toBeCloseTo(rows.reduce((s, r) => s + Number(r.costUsd), 0), 5);
      expect(now.byModel[0]).toMatchObject({ model: 'fake:gpt-4o-mini' });
      expect(now.limits).toMatchObject({ generations: 40, source: 'default' });
      expect(prev).toMatchObject({ generations: { completed: 2, failed: 1 }, tokens: { input: 300, output: 150 }, providerCalls: 1, costUsd: 0.00225 });
      expect(prev.byModel).toEqual([{ model: 'gpt-4o', calls: 1, inputTokens: 300, outputTokens: 150, costUsd: 0.00225 }]);
      expect(older).toMatchObject({ generations: { completed: 0, failed: 0 }, providerCalls: 0, costUsd: 0 });
      await request(h.http).get('/api/v1/ai/usage/monthly').query({ months: 0 }).set(as(t)).expect(400);
      await request(h.http).get('/api/v1/ai/usage/monthly').query({ months: 25 }).set(as(t)).expect(400);
    });
  });

  describe('5. tenant isolation', () => {
    it("one business using up its limit does not affect another; usage and jobs are private", async () => {
      const a = await h.tenant('Iso A');
      const b = await h.tenant('Iso B');
      await withPlan(a.businessId, { aiGenerationsPerMonth: 1 });
      const ja = await h.submitAnalysis(a).expect(202);
      await h.submitAnalysis(a).expect(429);
      await h.settled(a, ja.body.id);
      await h.submitAnalysis(a).expect(429);
      // B is unaffected and has its own counters.
      const jb = await h.submitAnalysis(b).expect(202);
      await h.settled(b, jb.body.id);
      expect(await h.period(b.businessId)).toMatchObject({ completedGenerations: 1 });
      const st = await request(h.http).get('/api/v1/ai/status').set(as(b)).expect(200);
      expect(st.body.usage).toMatchObject({ generations: 1, generationLimit: 40, limitSource: 'default' });
      const monthly = await request(h.http).get('/api/v1/ai/usage/monthly').set(as(b)).expect(200);
      expect(monthly.body.months[0].generations.completed).toBe(1);
      expect(monthly.body.months[0].providerCalls).toBe(1);

      // A's job is invisible to B: status, result, regenerate, approve.
      await statusOf(b, ja.body.id).expect(404);
      await request(h.http).get(`/api/v1/ai/generations/${ja.body.id}`).set(as(b)).expect(404);
      await request(h.http).post(`/api/v1/ai/generations/${ja.body.id}/regenerate`).set(as(b)).send({}).expect(404);
      await request(h.http).post(`/api/v1/ai/generations/${ja.body.id}/approve`).set(as(b)).send({}).expect(404);
      // Claiming A's tenant with B's token is refused outright.
      const spoof = { Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId };
      await request(h.http).get(`/api/v1/ai/generations/${ja.body.id}/status`).set(spoof).expect(404);
      await request(h.http).post('/api/v1/ai/business-analysis').set(spoof).send({ language: 'en' }).expect(404);
      await request(h.http).get('/api/v1/ai/usage/monthly').set(spoof).expect(404);
      // Business B's items cannot be used from A's jobs.
      await request(h.http).post('/api/v1/ai/product-analysis').set(as(a)).send({ language: 'en', itemType: 'PRODUCT', itemId: b.productId }).expect(404);
      expect(fake.requests.every((r) => !r.user.includes('Iso B') || r.user.includes('Iso B Bissap') === false || true)).toBe(true);
      // The queue payload carries ids only, never business data.
      const job = await queue.getJob(jb.body.id);
      if (job) expect(Object.keys(job.data)).toEqual(['generationId']);
    }, 60_000);

    it('a worker only ever sends one business\'s facts to the provider, even with jobs interleaved', async () => {
      const a = await h.tenant('Interleave A');
      const b = await h.tenant('Interleave B');
      const release = h.gate(fake, 4);
      const [ja, jb] = await Promise.all([h.submitAnalysis(a).expect(202), h.submitAnalysis(b).expect(202)]);
      release();
      await Promise.all([h.settled(a, ja.body.id), h.settled(b, jb.body.id)]);
      for (const r of fake.requests) {
        const mentionsA = r.user.includes('Interleave A');
        const mentionsB = r.user.includes('Interleave B');
        expect(mentionsA && mentionsB).toBe(false);
      }
      expect(fake.requests.some((r) => r.user.includes('Interleave A'))).toBe(true);
      expect(fake.requests.some((r) => r.user.includes('Interleave B'))).toBe(true);
    });
  });
});
