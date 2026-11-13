import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CalendarService } from '../src/calendar/calendar.service';
import { RUN_ADAPTER_REGISTRY, type RunAdapterRegistry } from '../src/runs/run-adapters';
import { aiHelpers, as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Phase N9: a workflow step creates a real calendar entry after a person approves it. Local PostgreSQL and Redis, the real
 * calendar services, nothing is published or sent.
 */
describe('Workflow → calendar (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let h: ReturnType<typeof aiHelpers>;
  let n = 0;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
    h = aiHelpers(app);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000 + 3_600_000).toISOString();
  const DEF = {
    triggers: [{ type: 'manual' }],
    input: { title: { type: 'string', required: true, maxLength: 200 }, platform: { type: 'string', required: true, maxLength: 30 }, scheduled_at: { type: 'string', required: true, maxLength: 40 }, caption: { type: 'string', maxLength: 500 } },
    steps: [
      { key: 'product_analysis', adapter: 'simulated.product-analysis' },
      { key: 'content_draft', adapter: 'simulated.content-draft', dependsOn: ['product_analysis'] },
      { key: 'calendar_entry', adapter: 'calendar.create-entry', dependsOn: ['content_draft'], requiresApproval: true },
    ],
  };
  async function shop() {
    const t = await h.tenant(`Shop ${++n}`);
    const admin = await h.member(t, 'ADMIN');
    const editor = await h.member(t, 'EDITOR');
    const wf = (await request(http).post('/api/v1/workflows').set(as(admin)).send({ name: `Plan ${n}`, definition: DEF }).expect(201)).body;
    await request(http).post(`/api/v1/workflows/${wf.id}/activate`).set(as(admin)).expect(200);
    return { t, admin, editor, wf };
  }
  type S = Awaited<ReturnType<typeof shop>>;
  const start = (s: S, input: Record<string, unknown>) =>
    request(http).post(`/api/v1/workflows/${s.wf.id}/executions`).set(as(s.editor)).set('Idempotency-Key', `n9-${n}-${Math.random().toString(36).slice(2)}`).send({ input }).expect(201).then((r) => r.body as { id: string });
  const input = (over: Record<string, unknown> = {}) => ({ title: 'Launch post', platform: 'INSTAGRAM', scheduled_at: inDays(3), caption: 'Hello', ...over });
  async function until(c: Ctx, id: string, status: string) {
    const end = Date.now() + 10_000;
    for (;;) {
      const r = (await request(http).get(`/api/v1/runs/${id}`).set(as(c)).expect(200)).body;
      if (r.status === status) return r;
      if (Date.now() > end) throw new Error(`run ${id} is ${r.status}, expected ${status}`);
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  const approve = (c: Ctx, runId: string) => request(http).post(`/api/v1/runs/${runId}/steps/calendar_entry/approve`).set(as(c));
  const events = (businessId: string) => prisma.calendarEvent.findMany({ where: { businessId } });
  const step = (r: { steps: Array<{ key: string }> }) => r.steps.find((x) => x.key === 'calendar_entry') as unknown as { status: string; errorCode?: string; output?: Record<string, unknown> };

  it('creates nothing before approval; after approval creates exactly one planned entry, shown by the calendar API, with a draft content and nothing published', async () => {
    const s = await shop();
    const when = inDays(3);
    const run = await start(s, input({ scheduled_at: when }));
    const waiting = await until(s.t, run.id, 'WAITING_APPROVAL');
    expect(step(waiting).status).toBe('WAITING_APPROVAL');
    expect(await events(s.t.businessId)).toHaveLength(0); // no approval → no event
    expect(await prisma.content.count({ where: { businessId: s.t.businessId, id: { startsWith: 'wfc' } } })).toBe(0);
    await approve(s.editor, run.id).expect(403); // creating is not approving

    await approve(s.admin, run.id).expect(200);
    const done = await until(s.t, run.id, 'COMPLETED');
    const ev = await events(s.t.businessId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ title: 'Launch post', platform: 'INSTAGRAM', status: 'PLANNED', authorizedAt: null, dispatchState: 'NONE', deletedAt: null });
    expect(ev[0]!.scheduledAt.toISOString()).toBe(new Date(when).toISOString());
    expect(step(done).output).toMatchObject({ eventId: ev[0]!.id, status: 'PLANNED', created: true, published: false, authorized: false });
    const content = await prisma.content.findUniqueOrThrow({ where: { id: ev[0]!.contentId! } });
    expect(content).toMatchObject({ status: 'DRAFT', caption: 'Hello', origin: 'AI_ASSISTED' });
    expect(await prisma.publication.count({ where: { businessId: s.t.businessId } })).toBe(0); // nothing published or queued
    // The existing calendar shows it.
    const day = when.slice(0, 10);
    const list = (await request(http).get(`/api/v1/calendar/entries?from=${day}&to=${new Date(new Date(when).getTime() + 2 * 86_400_000).toISOString().slice(0, 10)}`).set(as(s.t)).expect(200)).body;
    expect(JSON.stringify(list)).toContain(ev[0]!.id);
    expect((await prisma.auditLog.findMany({ where: { businessId: s.t.businessId, action: 'calendar.entry_created' } })).length).toBe(1);
  });

  it('never creates a duplicate: replays, a resumed step and concurrent attempts all return the same entry', async () => {
    const s = await shop();
    const run = await start(s, input());
    await until(s.t, run.id, 'WAITING_APPROVAL');
    await approve(s.admin, run.id).expect(200);
    await until(s.t, run.id, 'COMPLETED');
    const adapter = app.get<RunAdapterRegistry>(RUN_ADAPTER_REGISTRY).get('calendar.create-entry')!;
    const ctx = { runId: run.id, stepKey: 'calendar_entry', businessId: s.t.businessId, idempotencyKey: `${run.id}:calendar_entry`, input: input(), outputs: {} };
    const [a, b, c] = await Promise.all([adapter.execute(ctx), adapter.execute(ctx), adapter.execute(ctx)]);
    expect([a.created, b.created, c.created]).toEqual([false, false, false]);
    expect(new Set([a.eventId, b.eventId, c.eventId]).size).toBe(1);
    expect(await events(s.t.businessId)).toHaveLength(1);

    // A fresh key racing with itself still yields one entry.
    const key = `${run.id}:other-step`;
    const race = await Promise.all(Array.from({ length: 4 }, () => adapter.execute({ ...ctx, stepKey: 'other-step', idempotencyKey: key, input: input({ title: 'Race', scheduled_at: inDays(5) }) })));
    expect(new Set(race.map((r) => r.eventId)).size).toBe(1);
    expect(race.filter((r) => r.created).length).toBe(1);
    expect(await events(s.t.businessId)).toHaveLength(2);
  });

  it('a replay reports the real state: an entry cancelled by a person is not re-created', async () => {
    const s = await shop();
    const run = await start(s, input());
    await until(s.t, run.id, 'WAITING_APPROVAL');
    await approve(s.admin, run.id).expect(200);
    const done = await until(s.t, run.id, 'COMPLETED');
    const id = step(done).output!.eventId as string;
    const cancelled = await request(http).post(`/api/v1/calendar/entries/${id}/cancel`).set(as(s.admin)).send({});
    expect([200, 201]).toContain(cancelled.status);
    const adapter = app.get<RunAdapterRegistry>(RUN_ADAPTER_REGISTRY).get('calendar.create-entry')!;
    const again = await adapter.execute({ runId: run.id, stepKey: 'calendar_entry', businessId: s.t.businessId, idempotencyKey: `${run.id}:calendar_entry`, input: input(), outputs: {} });
    expect(again).toMatchObject({ eventId: id, status: 'CANCELLED', created: false });
    expect(await events(s.t.businessId)).toHaveLength(1);
  });

  it('isolates businesses: another business cannot approve, read or reach the entry, and a key cannot collide across businesses', async () => {
    const a = await shop();
    const b = await shop();
    const run = await start(a, input());
    await until(a.t, run.id, 'WAITING_APPROVAL');
    await approve(b.admin, run.id).expect(404);
    await approve(a.admin, run.id).expect(200);
    await until(a.t, run.id, 'COMPLETED');
    const [ev] = await events(a.t.businessId);
    await request(http).get(`/api/v1/calendar/entries/${ev!.id}`).set(as(b.t)).expect(404);
    await request(http).post(`/api/v1/calendar/entries/${ev!.id}/cancel`).set(as(b.admin)).send({}).expect(404);
    expect(await events(b.t.businessId)).toHaveLength(0);
    // The same step key in another business creates that business's own entry only.
    const adapter = app.get<RunAdapterRegistry>(RUN_ADAPTER_REGISTRY).get('calendar.create-entry')!;
    const other = await adapter.execute({ runId: run.id, stepKey: 'calendar_entry', businessId: b.t.businessId, idempotencyKey: `${run.id}:calendar_entry`, input: input({ title: 'Mine' }), outputs: {} }).catch((e: Error) => e);
    // The deterministic content id is global: the second business gets a clean failure, never A's entry.
    expect(other instanceof Error ? true : (other as { eventId: string }).eventId !== ev!.id).toBe(true);
    expect((await events(a.t.businessId)).map((e) => e.id)).toEqual([ev!.id]);
    expect((await events(b.t.businessId)).every((e) => e.businessId === b.t.businessId)).toBe(true);
  });

  it('keeps a consistent status on errors: invalid input and conflicts fail the step with no entry; a failure in the middle rolls back and a retry (with a new approval) completes once', async () => {
    const s = await shop();
    // Invalid platform and a time in the past: failed step, failed run, nothing created.
    for (const bad of [{ platform: 'NOPE' }, { scheduled_at: new Date(Date.now() - 86_400_000).toISOString() }, { scheduled_at: 'not-a-date' }]) {
      const run = await start(s, input(bad));
      await until(s.t, run.id, 'WAITING_APPROVAL');
      await approve(s.admin, run.id).expect(200);
      const failed = await until(s.t, run.id, 'FAILED');
      expect(step(failed).status).toBe('FAILED');
      expect(step(failed).errorCode).toMatch(/INVALID_INPUT|CALENDAR_CONFLICT|INVALID_TIME/);
    }
    expect(await events(s.t.businessId)).toHaveLength(0);
    expect(await prisma.content.count({ where: { businessId: s.t.businessId, id: { startsWith: 'wfc' } } })).toBe(0);

    // A creation error: the transaction rolls back (no entry, no orphan content), the step is FAILED with a clear code.
    jest.spyOn(app.get(CalendarService), 'insertEntry').mockRejectedValueOnce(new Error('db hiccup'));
    const run = await start(s, input());
    await until(s.t, run.id, 'WAITING_APPROVAL');
    await approve(s.admin, run.id).expect(200);
    const failed = await until(s.t, run.id, 'FAILED');
    expect(step(failed)).toMatchObject({ status: 'FAILED', errorCode: 'CALENDAR_FAILED' });
    expect(JSON.stringify(failed)).not.toContain('db hiccup');
    expect(await events(s.t.businessId)).toHaveLength(0);

    // Recovery: retry restarts the run and asks for a new approval; then exactly one entry exists.
    await request(http).post(`/api/v1/runs/${run.id}/retry`).set(as(s.admin)).expect(200);
    await until(s.t, run.id, 'WAITING_APPROVAL');
    expect(await events(s.t.businessId)).toHaveLength(0);
    await approve(s.admin, run.id).expect(200);
    await until(s.t, run.id, 'COMPLETED');
    expect(await events(s.t.businessId)).toHaveLength(1);
  });

  it('cannot be defined without a human approval step', async () => {
    const t = await h.tenant(`Shop ${++n}`);
    const admin = await h.member(t, 'ADMIN');
    const bad = { ...DEF, steps: [{ key: 'calendar_entry', adapter: 'calendar.create-entry' }] };
    const res = await request(http).post('/api/v1/workflows').set(as(admin)).send({ name: 'No approval', definition: bad });
    expect(res.status).toBe(400);
    expect(res.body.code).toMatch(/APPROVAL_REQUIRED|INVALID_WORKFLOW/);
  });
});
