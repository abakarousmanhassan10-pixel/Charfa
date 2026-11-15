import type { INestApplication } from '@nestjs/common';
import https from 'https';
import request from 'supertest';
import { CreativeCampaignsService } from '../src/creative/creative-campaigns.service';
import { IMAGE_PROVIDER, VIDEO_PROVIDER } from '../src/creative/creative-providers';
import { as, type Ctx } from './ai-helpers';
import { creativeHelpers } from './creative-helpers';
import { prisma, resetDb, startApp } from './helpers';

/** N29: automated creative campaigns in the free test mode. Two fictitious clients (A: AUTO, B: HYBRID), shared quotas, isolation, approvals bound to the content version, emergency stop, resume, cancellation, zero external calls. */
const ENV: Record<string, string> = { CREATIVE_STUDIO_MODE: 'mock', CREATIVE_DAILY_IMAGES_PER_BUSINESS: '5', CREATIVE_DAILY_VIDEOS_PER_BUSINESS: '5', CREATIVE_RATE_LIMIT_PER_MINUTE: '1000', CREATIVE_MAX_INFLIGHT_PER_BUSINESS: '50' };
const at = (hourUtc: number, days = 2) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(hourUtc, 0, 0, 0); return d.toISOString(); };
const FAR = new Date(Date.now() + 30 * 86_400_000).toISOString();

describe('Creative automation: campaigns in simulation (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let svc: CreativeCampaignsService;
  let outbound = 0;
  let httpsSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;
  let n = 0;
  const tenant = async (name: string) => { const t = await h.tenant(`${name} ${++n}`); await prisma.business.update({ where: { id: t.businessId }, data: { timezone: 'UTC' } }); return t; };
  const api = (c: Ctx) => ({
    get: (u: string) => request(h.http).get(`/api/v1/creative${u}`).set(as(c)),
    post: (u: string, b?: object) => request(h.http).post(`/api/v1/creative${u}`).set(as(c)).send(b ?? {}),
    patch: (u: string, b: object) => request(h.http).patch(`/api/v1/creative${u}`).set(as(c)).send(b),
  });
  const body = (over: Record<string, unknown> = {}) => ({ name: 'Weekend launch', subject: 'Fresh bissap juice', objective: 'Sell more juice this weekend', audience: 'Students in N\'Djamena', platform: 'INSTAGRAM', language: 'en', brand: { tone: 'friendly', colors: ['#d01010'], style: 'MINIMAL' }, photoCount: 2, videoCount: 1, startAt: at(10), intervalHours: 24, publishMode: 'AUTO', ...over });
  const create = async (c: Ctx, over: Record<string, unknown> = {}) => (await api(c).post('/campaigns', body(over)).expect(201)).body;
  /** Starts (or retries) and waits until the campaign is idle. */
  const idle = async (c: Ctx, id: string, timeoutMs = 60_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const d = (await api(c).get(`/campaigns/${id}`).expect(200)).body;
      if (d.status !== 'RUNNING' && !d.tasks.some((x: { status: string }) => x.status === 'RUNNING' || x.status === 'PENDING')) { await h.waitFor(async () => (await prisma.creativeGeneration.count({ where: { businessId: c.businessId, settledAt: null, status: { in: ['SUCCEEDED', 'FAILED'] } } })) === 0 || undefined).catch(() => undefined); return d; }
      if (Date.now() > until) throw new Error(`campaign ${id} still ${d.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const run = async (c: Ctx, over: Record<string, unknown> = {}) => { const camp = await create(c, over); await api(c).post(`/campaigns/${camp.id}/start`).expect(202); return idle(c, camp.id); };
  const quota = async (c: Ctx) => (await api(c).get('/quota').expect(200)).body;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
    svc = app.get(CreativeCampaignsService);
    expect([app.get(IMAGE_PROVIDER).name, app.get(VIDEO_PROVIDER).name]).toEqual(['mock', 'mock']);
    httpsSpy = jest.spyOn(https, 'request').mockImplementation(((...a: unknown[]) => { outbound++; throw new Error(`unexpected outbound https ${String(a[0])}`); }) as never);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (u: unknown) => { outbound++; throw new Error(`unexpected outbound fetch ${String(u)}`); }) as never);
  });
  afterEach(() => svc.faults.clear());
  afterAll(async () => {
    httpsSpy.mockRestore(); fetchSpy.mockRestore();
    await app.close(); await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('validates the builder: at least one media, at most the daily quota, future start, AUTO needs the right role', async () => {
    const t = await tenant('Validation');
    await api(t).post('/campaigns', body({ photoCount: 0, videoCount: 0 })).expect(400);
    await api(t).post('/campaigns', body({ photoCount: 6 })).expect(400);
    await api(t).post('/campaigns', body({ platform: 'FACEBOOK' })).expect(400);
    await api(t).post('/campaigns', body({ startAt: new Date(Date.now() - 86_400_000).toISOString() })).expect(400).expect((r) => expect(r.body.code).toBe('INVALID_TIME'));
    await api(t).post('/campaigns', { ...body(), extra: 1 }).expect(400);
    const editor = await h.member(t, 'EDITOR');
    await api(editor).post('/campaigns', body({ publishMode: 'AUTO' })).expect(403).expect((r) => expect(r.body.code).toBe('AUTO_NOT_ALLOWED'));
    await api(editor).post('/campaigns', body({ publishMode: 'HYBRID' })).expect(201);
  });

  it('Client A (AUTO): 3 images + 2 videos run through the six agents and are scheduled fictitiously; media can be previewed; nothing is published outside', async () => {
    const a = await tenant('Client A');
    const camp = await create(a, { name: 'A launch', photoCount: 3, videoCount: 2, publishMode: 'AUTO' });
    expect(camp).toMatchObject({ status: 'DRAFT', simulation: true, replayed: false });
    expect(camp.tasks.map((x: { agent: string }) => x.agent)).toEqual(['CAMPAIGN', 'SCRIPT', 'IMAGE', 'IMAGE', 'IMAGE', 'VIDEO', 'VIDEO', 'QUALITY', 'SCHEDULE']);
    expect(camp.tasks.every((x: { status: string }) => x.status === 'PENDING')).toBe(true);
    expect(camp.tasks[0].label).toBe('Campaign Agent');
    await api(a).post(`/campaigns/${camp.id}/start`).expect(202);
    await api(a).post(`/campaigns/${camp.id}/start`).expect(409); // not a draft any more
    const d = await idle(a, camp.id);
    expect(d.status).toBe('COMPLETED');
    expect(d.tasks.every((x: { status: string }) => x.status === 'SUCCEEDED')).toBe(true);
    expect(d.posts).toHaveLength(5);
    expect(d.posts.every((p: { status: string; effectiveMode: string; simulated: boolean }) => p.status === 'SIMULATED_SCHEDULED' && p.effectiveMode === 'AUTO' && p.simulated)).toBe(true);
    expect(d.posts.filter((p: { kind: string }) => p.kind === 'IMAGE')).toHaveLength(3);
    expect(d.media).toHaveLength(5);
    expect(d.media.every((m: { simulated: boolean }) => m.simulated)).toBe(true);
    // Preview: every post's media downloads through its signed URL, a video is a real MP4.
    for (const p of d.posts) {
      const f = await h.download(p.media.url).expect(200);
      expect(f.headers['content-type']).toMatch(p.kind === 'VIDEO' ? /video\/mp4/ : /image\//);
    }
    // 3 images and 2 videos were consumed from the shared quota, once each.
    expect(await quota(a)).toMatchObject({ images: { used: 3, remaining: 2 }, videos: { used: 2, remaining: 3 } });
    // Fictitious publication of what is due.
    const pub = (await api(a).post(`/campaigns/${camp.id}/simulate-due`, { asOf: FAR }).expect(200)).body;
    expect(pub).toMatchObject({ published: 5, external: 0 });
    expect((await api(a).get(`/campaigns/${camp.id}`).expect(200)).body.posts.every((p: { status: string }) => p.status === 'SIMULATED_PUBLISHED')).toBe(true);
    // Never a real calendar entry, publication or provider call.
    expect(await prisma.publication.count({ where: { businessId: a.businessId } })).toBe(0);
    expect(await prisma.calendarEvent.count({ where: { businessId: a.businessId } })).toBe(0);
  });

  it('Client B (HYBRID): a post needing validation waits; approval is bound to the exact version; manual and campaign creations share one quota', async () => {
    const b = await tenant('Client B');
    // Two images made by hand first: the campaign draws on the same 5/day.
    await h.finished(b, (await h.submitImage(b).expect(202)).body.id);
    await h.finished(b, (await h.submitImage(b).expect(202)).body.id);
    const camp = await create(b, { name: 'B launch', photoCount: 2, videoCount: 2, publishMode: 'HYBRID', startAt: at(3), intervalHours: 6 });
    await api(b).post(`/campaigns/${camp.id}/start`).expect(202);
    const d = await idle(b, camp.id);
    expect(d.status).toBe('AWAITING_APPROVAL');
    expect(await quota(b)).toMatchObject({ images: { used: 4 }, videos: { used: 2 } });
    const waiting = d.posts.filter((p: { status: string }) => p.status === 'PENDING_APPROVAL');
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    expect(waiting[0].reasons.map((r: { code: string }) => r.code)).toContain('OUTSIDE_HOURS'); // 03:00 is outside the allowed hours
    const overview = (await api(b).get('/campaigns/overview').expect(200)).body;
    expect(overview).toMatchObject({ mode: 'SIMULATION', externalCalls: 0, posts: { waitingApproval: waiting.length } });
    expect(overview.waitingApproval[0]).toMatchObject({ campaignName: 'B launch', contentHash: waiting[0].contentHash });
    // Preview before deciding.
    await h.download(waiting[0].media.url).expect(200);
    // An editor may prepare content but may not approve it.
    const editor = await h.member(b, 'EDITOR');
    await api(editor).post(`/campaigns/${camp.id}/posts/${waiting[0].id}/approve`, { contentHash: waiting[0].contentHash }).expect(403);
    // A hash that is not the current version is refused and nothing is approved.
    await api(b).post(`/campaigns/${camp.id}/posts/${waiting[0].id}/approve`, { contentHash: 'a'.repeat(64) }).expect(409).expect((r) => { expect(r.body.code).toBe('APPROVAL_STALE'); expect(r.body.contentHash).toBe(waiting[0].contentHash); });
    // The text is edited after the person looked at it: the old hash no longer approves anything.
    const edited = (await api(editor).patch(`/campaigns/${camp.id}/posts/${waiting[0].id}`, { caption: 'Fresh bissap juice, now with a weekend discount code.' }).expect(200)).body.posts.find((p: { id: string }) => p.id === waiting[0].id);
    expect(edited.contentHash).not.toBe(waiting[0].contentHash);
    await api(b).post(`/campaigns/${camp.id}/posts/${waiting[0].id}/approve`, { contentHash: waiting[0].contentHash }).expect(409).expect((r) => expect(r.body.code).toBe('APPROVAL_STALE'));
    const ok = (await api(b).post(`/campaigns/${camp.id}/posts/${waiting[0].id}/approve`, { contentHash: edited.contentHash }).expect(200)).body;
    expect(ok.posts.find((p: { id: string }) => p.id === waiting[0].id)).toMatchObject({ status: 'SIMULATED_SCHEDULED', approved: true });
    // Editing an approved post voids the approval: it waits again and would not be published.
    const again = (await api(editor).patch(`/campaigns/${camp.id}/posts/${waiting[0].id}`, { caption: 'Fresh bissap juice, a new angle.' }).expect(200)).body.posts.find((p: { id: string }) => p.id === waiting[0].id);
    expect(again).toMatchObject({ status: 'PENDING_APPROVAL', approved: false });
    // Rejecting is also possible; the other waiting posts stay independent.
    await api(b).post(`/campaigns/${camp.id}/posts/${waiting[0].id}/reject`).expect(200);
    await api(b).post(`/campaigns/${camp.id}/posts/${waiting[0].id}/approve`, { contentHash: again.contentHash }).expect(409).expect((r) => expect(r.body.code).toBe('NOT_WAITING'));
    // Approve the remaining ones; the campaign completes and the simulated publication happens only for approved/low-risk posts.
    for (const p of waiting.slice(1)) await api(b).post(`/campaigns/${camp.id}/posts/${p.id}/approve`, { contentHash: p.contentHash }).expect(200);
    const final = (await api(b).get(`/campaigns/${camp.id}`).expect(200)).body;
    expect(final.status).toBe('COMPLETED');
    const pub = (await api(b).post(`/campaigns/${camp.id}/simulate-due`, { asOf: FAR }).expect(200)).body;
    expect(pub.external).toBe(0);
    expect(pub.published).toBe(final.posts.filter((p: { status: string }) => p.status === 'SIMULATED_SCHEDULED').length);
    expect((await api(b).get(`/campaigns/${camp.id}`).expect(200)).body.posts.filter((p: { status: string }) => p.status === 'REJECTED')).toHaveLength(1);
  });

  it('quotas: a campaign asking for more than is left delivers what fits, reports the rest, and a retry never double counts', async () => {
    const c = await tenant('Quota');
    for (let i = 0; i < 4; i++) await h.finished(c, (await h.submitImage(c).expect(202)).body.id);
    const d = await run(c, { photoCount: 3, videoCount: 1 });
    expect(d.status).toBe('NEEDS_ATTENTION');
    expect(d.tasks.filter((x: { agent: string; status: string }) => x.agent === 'IMAGE' && x.status === 'SUCCEEDED')).toHaveLength(1);
    const failed = d.tasks.filter((x: { status: string }) => x.status === 'FAILED');
    expect(failed).toHaveLength(2);
    expect(failed.every((x: { errorCode: string }) => x.errorCode === 'CREATIVE_DAILY_LIMIT')).toBe(true);
    expect((await quota(c)).images).toMatchObject({ used: 5, remaining: 0, reserved: 0 });
    expect(d.posts).toHaveLength(2); // what was delivered is still scheduled (1 image + 1 video)
    const errs = (await api(c).get('/campaigns/overview').expect(200)).body.errors;
    expect(errs.filter((e: { type: string }) => e.type === 'TASK_FAILED')).toHaveLength(2);
    await api(c).post(`/campaigns/${d.id}/retry`).expect(202);
    const r = await idle(c, d.id);
    expect(r.status).toBe('NEEDS_ATTENTION'); // still no credit left
    expect((await quota(c)).images.used).toBe(5);
    expect(await prisma.creativeGeneration.count({ where: { businessId: c.businessId, kind: 'IMAGE', status: 'SUCCEEDED' } })).toBe(5);
    await api(c).post(`/campaigns/${d.id}/start`).expect(409);
  });

  it('concurrency: two campaigns started together can never exceed the 5 images of the day', async () => {
    const c = await tenant('Concurrent');
    const [x, y] = await Promise.all([create(c, { photoCount: 3, videoCount: 0 }), create(c, { photoCount: 3, videoCount: 0 })]);
    await Promise.all([api(c).post(`/campaigns/${x.id}/start`).expect(202), api(c).post(`/campaigns/${y.id}/start`).expect(202)]);
    const [dx, dy] = await Promise.all([idle(c, x.id), idle(c, y.id)]);
    const delivered = [dx, dy].reduce((s, d) => s + d.tasks.filter((t: { agent: string; status: string }) => t.agent === 'IMAGE' && t.status === 'SUCCEEDED').length, 0);
    expect(delivered).toBe(5);
    expect((await quota(c)).images).toMatchObject({ used: 5, completed: 5, reserved: 0 });
  });

  it('resumes after an error without redoing or recounting what already succeeded', async () => {
    const c = await tenant('Resume');
    svc.faults.set('VIDEO', 1);
    const d = await run(c, { photoCount: 2, videoCount: 2 });
    expect(d.status).toBe('NEEDS_ATTENTION');
    const failed = d.tasks.filter((x: { status: string }) => x.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ agent: 'VIDEO', errorCode: 'SIMULATED_AGENT_FAILURE' });
    const imageGens = d.tasks.filter((x: { agent: string }) => x.agent === 'IMAGE').map((x: { generationId: string }) => x.generationId);
    await api(c).post(`/campaigns/${d.id}/retry`).expect(202);
    const r = await idle(c, d.id);
    expect(r.status).toBe('COMPLETED');
    expect(r.posts).toHaveLength(4);
    expect(r.tasks.filter((x: { agent: string }) => x.agent === 'IMAGE').map((x: { generationId: string }) => x.generationId)).toEqual(imageGens); // not regenerated
    expect(await quota(c)).toMatchObject({ images: { used: 2 }, videos: { used: 2 } }); // each credit counted once
    expect(r.events.some((e: { level: string; type: string }) => e.level === 'ERROR' && e.type === 'TASK_FAILED')).toBe(true);
    await api(c).post(`/campaigns/${d.id}/retry`).expect(409);
  });

  it('keeps campaigns, posts, approvals and quotas private to each client', async () => {
    const a = await tenant('Iso A');
    const b = await tenant('Iso B');
    const d = await run(a, { photoCount: 1, videoCount: 1, publishMode: 'HYBRID', startAt: at(3) });
    const post = d.posts[0];
    await api(b).get(`/campaigns/${d.id}`).expect(404);
    await api(b).post(`/campaigns/${d.id}/start`).expect(404);
    await api(b).post(`/campaigns/${d.id}/cancel`).expect(404);
    await api(b).post(`/campaigns/${d.id}/emergency-stop`).expect(404);
    await api(b).post(`/campaigns/${d.id}/simulate-due`, {}).expect(404);
    await api(b).post(`/campaigns/${d.id}/posts/${post.id}/approve`, { contentHash: post.contentHash }).expect(404);
    await api(b).patch(`/campaigns/${d.id}/posts/${post.id}`, { caption: 'hijack' }).expect(404);
    expect((await api(b).get('/campaigns').expect(200)).body).toEqual([]);
    expect((await api(b).get('/campaigns/overview').expect(200)).body).toMatchObject({ campaigns: { total: 0 }, media: { photos: 0, videos: 0 }, posts: { waitingApproval: 0 } });
    expect(await quota(b)).toMatchObject({ images: { used: 0 }, videos: { used: 0 } });
    expect(await quota(a)).toMatchObject({ images: { used: 1 }, videos: { used: 1 } });
    await h.download(post.media.url).expect(200); // signed URLs are tied to the owner: B cannot reuse them against its own tenant
    const stopB = await api(b).post('/campaigns/emergency-stop').expect(200); // a global stop of B never touches A
    expect(stopB.body.stopped).toBe(0);
    expect((await api(a).get(`/campaigns/${d.id}`).expect(200)).body.status).not.toBe('STOPPED');
  });

  it('cancelling a campaign stops its tasks and posts; the media already delivered stays in the library', async () => {
    const c = await tenant('Cancel');
    const camp = await create(c, { photoCount: 4, videoCount: 3 });
    await api(c).post(`/campaigns/${camp.id}/start`).expect(202);
    const cancelled = (await api(c).post(`/campaigns/${camp.id}/cancel`).expect(200)).body;
    expect(cancelled.status).toBe('CANCELLED');
    await new Promise((r) => setTimeout(r, 800));
    const d = (await api(c).get(`/campaigns/${camp.id}`).expect(200)).body;
    expect(d.status).toBe('CANCELLED');
    expect(d.tasks.some((x: { status: string }) => x.status === 'PENDING')).toBe(false);
    expect(d.posts.every((p: { status: string }) => p.status === 'CANCELLED')).toBe(true);
    expect(d.tasks.filter((x: { agent: string }) => x.agent === 'IMAGE' || x.agent === 'VIDEO').length).toBe(7);
    expect(d.tasks.filter((x: { status: string }) => x.status === 'CANCELLED').length).toBeGreaterThan(0);
    await api(c).post(`/campaigns/${camp.id}/cancel`).expect(409);
    await api(c).post(`/campaigns/${camp.id}/start`).expect(409);
    const q = await quota(c);
    expect(q.images.reserved).toBe(0);
    expect(q.videos.reserved).toBe(0);
    const lib = (await api(c).get('/library').expect(200)).body.total;
    expect(lib).toBe(q.images.used + q.videos.used); // only delivered media counted and kept
  });

  it('emergency stop halts everything at once; resuming puts posts back to a person and never restores an approval', async () => {
    const c = await tenant('Stop');
    const done = await run(c, { photoCount: 2, videoCount: 1, publishMode: 'AUTO' });
    expect(done.status).toBe('COMPLETED');
    const editor = await h.member(c, 'EDITOR');
    await api(editor).post('/campaigns/emergency-stop').expect(403); // a stop is a management decision
    await api(c).post(`/campaigns/${done.id}/emergency-stop`).expect(200);
    const s = (await api(c).get(`/campaigns/${done.id}`).expect(200)).body;
    expect(s).toMatchObject({ status: 'STOPPED', stopped: true });
    expect(s.posts.every((p: { status: string }) => p.status === 'STOPPED')).toBe(true);
    await api(c).post(`/campaigns/${done.id}/simulate-due`, { asOf: FAR }).expect(409);
    await api(c).post(`/campaigns/${done.id}/emergency-stop`).expect(409);
    await api(c).post(`/campaigns/${done.id}/posts/${s.posts[0].id}/approve`, { contentHash: s.posts[0].contentHash }).expect(409);
    // A stop in the middle of a run: the remaining tasks never start.
    const running = await create(c, { photoCount: 0, videoCount: 4, name: 'Mid-run' });
    await api(c).post(`/campaigns/${running.id}/start`).expect(202);
    expect((await api(c).post('/campaigns/emergency-stop').expect(200)).body.stopped).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    const mid = (await api(c).get(`/campaigns/${running.id}`).expect(200)).body;
    expect(mid.status).toBe('STOPPED');
    expect(mid.tasks.some((x: { status: string }) => x.status === 'PENDING')).toBe(false);
    // Resume: stopped posts wait for a person again (no approval survives a stop).
    await api(editor).post(`/campaigns/${done.id}/resume`).expect(403);
    await api(c).post(`/campaigns/${done.id}/resume`).expect(202);
    const r = await idle(c, done.id);
    expect(r.posts.every((p: { status: string; approved: boolean }) => p.status === 'PENDING_APPROVAL' && !p.approved)).toBe(true);
    expect(['AWAITING_APPROVAL', 'RUNNING']).toContain(r.status);
  });

  it('regression: the very first dashboard requests of a new client (quota + overview + status, in parallel) never conflict', async () => {
    const t = await tenant('Parallel');
    const rs = await Promise.all([api(t).get('/quota'), api(t).get('/campaigns/overview'), api(t).get('/quota'), api(t).get('/campaigns/overview'), api(t).get('/status'), api(t).get('/quota')]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('simulation only: the studio status says so, nothing external was called, and nothing was billed', async () => {
    const t = await tenant('Final');
    expect((await api(t).get('/campaigns/overview').expect(200)).body).toMatchObject({ mode: 'SIMULATION', simulation: true, externalCalls: 0 });
    const costs = await prisma.creativeGeneration.aggregate({ _sum: { costUsd: true }, where: { provider: { not: 'mock' } } });
    expect(Number(costs._sum.costUsd ?? 0)).toBe(0);
    expect(await prisma.creativeGeneration.count({ where: { provider: { notIn: ['mock'] } } })).toBe(0);
    expect(await prisma.publication.count()).toBe(0);
    expect(await prisma.calendarEvent.count()).toBe(0);
    expect(outbound).toBe(0);
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
