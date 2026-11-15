import type { INestApplication } from '@nestjs/common';
import https from 'https';
import request from 'supertest';
import { IMAGE_PROVIDER, VIDEO_PROVIDER, SCRIPT_PROVIDER } from '../src/creative/creative-providers';
import { CreativeUsageService } from '../src/creative/creative-usage.service';
import { as, type Ctx } from './ai-helpers';
import { creativeHelpers } from './creative-helpers';
import { prisma, resetDb, startApp } from './helpers';

/** N28: the free Creative Studio test mode (CREATIVE_STUDIO_MODE=mock). Local demo media only, never presented as real AI, zero paid calls. */
const ENV: Record<string, string> = { CREATIVE_STUDIO_MODE: 'mock', CREATIVE_DAILY_IMAGES_PER_BUSINESS: '5', CREATIVE_DAILY_VIDEOS_PER_BUSINESS: '5', CREATIVE_RATE_LIMIT_PER_MINUTE: '1000', CREATIVE_MAX_INFLIGHT_PER_BUSINESS: '50' };
const brief = (over: Record<string, unknown> = {}) => ({ kind: 'IMAGE', description: 'Fresh bissap juice for the weekend', aspectRatio: '1:1', style: 'MINIMAL', platform: 'INSTAGRAM', language: 'en', ...over });

describe('Creative Studio: free test mode (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let usage: CreativeUsageService;
  let outbound = 0;
  let httpsSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;
  let n = 0;
  const tenant = () => h.tenant(`Studio ${++n}`);
  const api = (c: Ctx) => ({
    get: (u: string) => request(h.http).get(`/api/v1/creative${u}`).set(as(c)),
    post: (u: string, b?: object) => request(h.http).post(`/api/v1/creative${u}`).set(as(c)).send(b ?? {}),
    patch: (u: string, b: object) => request(h.http).patch(`/api/v1/creative${u}`).set(as(c)).send(b),
    del: (u: string) => request(h.http).delete(`/api/v1/creative${u}`).set(as(c)),
  });
  const quota = async (c: Ctx) => (await api(c).get('/quota').expect(200)).body;
  const project = async (c: Ctx, over: Record<string, unknown> = {}) => (await api(c).post('/projects', { name: 'Weekend promo', brief: brief(over) }).expect(201)).body;
  const gen = async (c: Ctx, body: Record<string, unknown> = {}) => h.finished(c, (await h.submitImage(c, body).expect(202)).body.id);
  const vid = async (c: Ctx, body: Record<string, unknown> = {}) => h.finished(c, (await h.submitVideo(c, body).expect(202)).body.id);

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    saved.IMAGE_PROVIDER = process.env.IMAGE_PROVIDER; saved.VIDEO_PROVIDER = process.env.VIDEO_PROVIDER;
    process.env.IMAGE_PROVIDER = 'openai'; process.env.VIDEO_PROVIDER = 'openai'; // the mode must override whatever is configured
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
    usage = app.get(CreativeUsageService);
    // Count every outbound HTTPS request and fetch made from now on: a free test mode must make none.
    httpsSpy = jest.spyOn(https, 'request').mockImplementation(((...a: unknown[]) => { outbound++; throw new Error(`unexpected outbound https ${String(a[0])}`); }) as never);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (u: unknown) => { outbound++; throw new Error(`unexpected outbound fetch ${String(u)}`); }) as never);
  });
  afterAll(async () => {
    httpsSpy.mockRestore(); fetchSpy.mockRestore();
    await app.close(); await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('runs on the simulators whatever providers are configured, and says so', async () => {
    expect(app.get(IMAGE_PROVIDER).name).toBe('mock');
    expect(app.get(VIDEO_PROVIDER).name).toBe('mock');
    expect(app.get(SCRIPT_PROVIDER)).toMatchObject({ name: 'mock' });
    const t = await tenant();
    const s = (await api(t).get('/status').expect(200)).body;
    expect(s).toMatchObject({ mode: 'mock', freeTestMode: true, simulated: { image: true, video: true } });
  });

  it('generates a fictitious image that is marked simulated and downloads without a bearer token', async () => {
    const t = await tenant();
    const g = await gen(t);
    expect(g).toMatchObject({ status: 'SUCCEEDED', provider: 'mock', simulated: true, usage: { costUsd: 0 } });
    const file = await h.download(g.outputs[0].media.url).expect(200);
    expect(file.headers['content-type']).toMatch(/image\//);
    expect(file.body.length).toBeGreaterThan(500);
  });

  it('generates a real playable 8-second demo video in every format, including 4:5, and downloads it', async () => {
    const t = await tenant();
    for (const format of ['SHORT_VERTICAL', 'SQUARE', 'PORTRAIT', 'LANDSCAPE']) {
      const g = await vid(t, { format, seconds: 8 });
      expect(g).toMatchObject({ status: 'SUCCEEDED', provider: 'mock', simulated: true });
      const file = await h.download(g.outputs[0].media.url).expect(200);
      expect(file.headers['content-type']).toMatch(/video\/mp4/);
      expect((file.body as Buffer).subarray(4, 8).toString()).toBe('ftyp');
    }
    expect((await quota(t)).videos.used).toBe(4);
  });

  it('saves, reads, updates and deletes a project; deleting it keeps the media in the library', async () => {
    const t = await tenant();
    const p = await project(t);
    expect(p).toMatchObject({ name: 'Weekend promo', status: 'DRAFT' });
    expect((await api(t).patch(`/projects/${p.id}`, { name: 'Renamed', caption: 'My caption' }).expect(200)).body).toMatchObject({ name: 'Renamed', caption: 'My caption' });
    const g = await gen(t, { projectId: p.id });
    const full = (await api(t).get(`/projects/${p.id}`).expect(200)).body;
    expect(full.generations).toHaveLength(1);
    expect(full.generations[0]).toMatchObject({ id: g.id, simulated: true });
    expect((await api(t).get('/projects').expect(200)).body[0]).toMatchObject({ id: p.id, creations: 1 });
    await api(t).del(`/projects/${p.id}`).expect(200);
    await api(t).get(`/projects/${p.id}`).expect(404);
    expect((await api(t).get('/library').expect(200)).body.total).toBe(1);
    await h.submitImage(t, { projectId: p.id }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
  });

  it('prepares a simulated script, caption and hashtags from the brief without inventing claims', async () => {
    const t = await tenant();
    const p = await project(t, { kind: 'VIDEO', aspectRatio: '9:16' });
    const r = (await api(t).post(`/projects/${p.id}/script`).expect(200)).body;
    expect(r.status).toBe('SCRIPTED');
    expect(r.script).toMatchObject({ simulated: true });
    expect(r.script.scenes.reduce((s: number, x: { seconds: number }) => s + x.seconds, 0)).toBe(8);
    expect(r.caption).toContain('Fresh bissap juice');
    expect(JSON.stringify(r.script)).not.toMatch(/guarantee|best in|100%/i);
  });

  it('the library lists delivered images and videos, filters by type and project, and deletes', async () => {
    const t = await tenant();
    const p = await project(t);
    const img = await gen(t, { projectId: p.id });
    await gen(t);
    const v = await vid(t, { projectId: p.id });
    const all = (await api(t).get('/library').expect(200)).body;
    expect(all.total).toBe(3);
    expect(all.items.every((i: { simulated: boolean }) => i.simulated)).toBe(true);
    expect((await api(t).get('/library?type=VIDEO').expect(200)).body.items.map((i: { generationId: string }) => i.generationId)).toEqual([v.id]);
    expect((await api(t).get(`/library?projectId=${p.id}`).expect(200)).body.total).toBe(2);
    expect((await api(t).get(`/library?projectId=${p.id}&type=IMAGE`).expect(200)).body.items[0].generationId).toBe(img.id);
    await api(t).del(`/generations/${img.id}`).expect(204);
    expect((await api(t).get('/library').expect(200)).body.total).toBe(2);
  });

  it('goes back to a previous creation of a project without using any quota', async () => {
    const t = await tenant();
    const p = await project(t);
    const first = await gen(t, { projectId: p.id });
    const second = await gen(t, { projectId: p.id });
    const used = (await quota(t)).images.used;
    const r = (await api(t).post(`/projects/${p.id}/restore`, { generationId: first.id }).expect(200)).body;
    expect(r).toMatchObject({ activeGenerationId: first.id, status: 'READY' });
    expect((await quota(t)).images.used).toBe(used);
    expect(second.id).not.toBe(first.id);
    await api(t).post(`/projects/${p.id}/restore`, { generationId: 'nope' }).expect(404);
    const other = await project(t);
    await api(t).post(`/projects/${other.id}/restore`, { generationId: first.id }).expect(404); // a creation of another project
  });

  it('daily quotas: 5 images and 5 videos, shared by agents, only delivered creations count, a simulated failure costs nothing, and the day resets', async () => {
    const t = await tenant();
    await api(t).post('/images', { type: 'PRODUCT_AD', aspectRatio: '1:1', instructions: 'simulate-failure' }).expect(202).then(async (r) => {
      const f = await h.finished(t, r.body.id);
      expect(f.status).toBe('FAILED');
    });
    expect((await quota(t)).images.used).toBe(0);
    for (let i = 0; i < 5; i++) await gen(t);
    const blocked = await h.submitImage(t).expect(429);
    expect(blocked.body).toMatchObject({ code: 'CREATIVE_DAILY_LIMIT', usage: { kind: 'IMAGE', limit: 5, used: 5 } });
    await h.submitImage(await h.member(t, 'EDITOR')).expect(429); // shared with the other users and agents of the business
    for (let i = 0; i < 5; i++) await vid(t);
    await h.submitVideo(t).expect(429);
    const today = await usage.dailyStatus(t.businessId, new Date());
    const tomorrow = await usage.dailyStatus(t.businessId, new Date(new Date(today.resetsAt).getTime() + 60_000));
    expect(tomorrow).toMatchObject({ images: { used: 0, remaining: 5 }, videos: { used: 0, remaining: 5 } });
  });

  it('a queued creation can be cancelled and gives its credit back', async () => {
    const t = await tenant();
    const g = (await h.submitImage(t).expect(202)).body;
    const r = await api(t).post(`/generations/${g.id}/cancel`);
    expect([200, 202, 409]).toContain(r.status); // QUEUED only; a job already running finishes normally
    await h.finished(t, g.id);
    const q = await quota(t);
    expect(q.images.reserved).toBe(0);
    expect(q.images.used).toBe(r.status === 409 ? 1 : 0);
  });

  it('keeps every project, creation and library item private to its business', async () => {
    const a = await tenant();
    const b = await tenant();
    const p = await project(a);
    const g = await gen(a, { projectId: p.id });
    await api(b).get(`/projects/${p.id}`).expect(404);
    await api(b).patch(`/projects/${p.id}`, { name: 'hijack' }).expect(404);
    await api(b).del(`/projects/${p.id}`).expect(404);
    await api(b).post(`/projects/${p.id}/script`).expect(404);
    await api(b).post(`/projects/${p.id}/schedule-simulation`, { platform: 'INSTAGRAM', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(404);
    await api(b).get(`/generations/${g.id}`).expect(404);
    await api(b).del(`/generations/${g.id}`).expect(404);
    await h.submitImage(b, { projectId: p.id }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400)); // a project of another business is refused
    expect((await api(b).get('/library').expect(200)).body.total).toBe(0);
    expect((await api(b).get('/projects').expect(200)).body).toEqual([]);
    const restoreOther = await project(b);
    await api(b).post(`/projects/${restoreOther.id}/restore`, { generationId: g.id }).expect(404);
  });

  it('fictitious scheduling: needs the right role, a creation and a caption, never goes looser than the account policy, and creates nothing real', async () => {
    const t = await tenant();
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const p = await project(t);
    const sim = (c: Ctx, body: Record<string, unknown> = {}) => api(c).post(`/projects/${p.id}/schedule-simulation`, { platform: 'INSTAGRAM', scheduledAt: when, ...body });
    // Not ready: no creation, no caption.
    expect((await sim(t).expect(200)).body.scheduleSim).toMatchObject({ simulated: true, publication: 'NONE', outcome: 'BLOCKED' });
    await api(t).post(`/projects/${p.id}/script`).expect(200);
    const g = await gen(t, { projectId: p.id });
    await api(t).post(`/projects/${p.id}/restore`, { generationId: g.id }).expect(200);
    // An editor can create but may not schedule.
    await sim(await h.member(t, 'EDITOR')).expect(403);
    await sim(t, { scheduledAt: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    // Without an account that consented to automation, every mode degrades to MANUAL: nothing is looser than the account policy.
    const hybrid = (await sim(t).expect(200)).body;
    expect(hybrid.scheduleSim).toMatchObject({ simulated: true, publication: 'NONE', outcome: 'WOULD_WAIT_FOR_APPROVAL', effectiveMode: 'MANUAL' }); // no consent: a person decides
    expect(hybrid.status).toBe('SCHEDULED_SIMULATED');
    const auto = (await sim(t, { mode: 'AUTO' }).expect(200)).body.scheduleSim;
    expect(auto).toMatchObject({ requestedMode: 'AUTO', effectiveMode: 'MANUAL', outcome: 'WOULD_WAIT_FOR_APPROVAL' });
    // With an account whose owner consented to automation, AUTO is honoured, still without publishing anything.
    const acc = await prisma.socialAccount.create({ data: { businessId: t.businessId, platform: 'INSTAGRAM', externalAccountId: 'sim-acc', accessTokenEnc: 'x', status: 'CONNECTED' } });
    await prisma.publishingPolicy.create({ data: { businessId: t.businessId, socialAccountId: acc.id, platform: 'INSTAGRAM', mode: 'AUTO', consentVersion: '1', consentGrantedAt: new Date(), authorizedScopes: [], allowedContentTypes: ['IMAGE', 'VIDEO'], timezone: 'UTC', allowedPublishingHours: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' }], automationEnabled: true } });
    const okAuto = (await sim(t, { mode: 'AUTO' }).expect(200)).body.scheduleSim;
    expect(okAuto).toMatchObject({ simulated: true, publication: 'NONE', effectiveMode: 'AUTO' });
    expect(['WOULD_AUTO_SCHEDULE', 'WOULD_WAIT_FOR_APPROVAL']).toContain(okAuto.outcome);
    // Nothing real was created, whatever the outcome.
    expect(await prisma.publication.count({ where: { businessId: t.businessId } })).toBe(0);
    expect(await prisma.calendarEvent.count({ where: { businessId: t.businessId } })).toBe(0);
  });

  it('never called a paid external service during the whole suite', () => {
    expect(outbound).toBe(0);
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
