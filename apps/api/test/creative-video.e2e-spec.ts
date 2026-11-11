import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { fakeDefaultAnswer, type FakeTextProvider } from '@touma/ai-engine';
import { CreativeProviderError, fakeMp4, FakeImageProvider, FakeVideoProvider } from '@touma/creative';
import { TEXT_PROVIDER } from '../src/ai/ai-provider';
import { CreativeQueueService } from '../src/creative/creative-queue';
import { IMAGE_PROVIDER, VIDEO_PROVIDER } from '../src/creative/creative-providers';
import { as } from './ai-helpers';
import { creativeHelpers, studioPhoto } from './creative-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Creative Studio: video jobs (a resumable submit-once / poll workflow), storyboards (the TOUMA AI text pipeline),
 * provider and file failures, limits, idempotency. Real PostgreSQL, Redis, BullMQ and storage; only the AI,
 * image and video PROVIDERS are the test-only fakes.
 */
describe('Creative Studio: videos and storyboards (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let video: FakeVideoProvider;
  let image: FakeImageProvider;
  let text: FakeTextProvider;
  let queue: CreativeQueueService;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
    video = app.get(VIDEO_PROVIDER);
    image = app.get(IMAGE_PROVIDER);
    text = app.get(TEXT_PROVIDER);
    queue = app.get(CreativeQueueService);
  });
  beforeEach(() => {
    video.reset();
    image.reset();
    text.reset();
  });
  afterEach(() => {
    h.releaseAll();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const videoGen = async (c: Parameters<typeof as>[0], body: Record<string, unknown> = {}) => h.finished(c, (await h.submitVideo(c, body).expect(202)).body.id);
  const post = (c: Parameters<typeof as>[0], path: string, body: Record<string, unknown> = {}) => request(h.http).post(`/api/v1${path}`).set(as(c)).send(body);
  const storyboard = async (c: Parameters<typeof as>[0], body: Record<string, unknown> = {}) => {
    const r = await post(c, '/creative/storyboards', { language: 'en', format: 'SHORT_VERTICAL', seconds: 8, ...body }).expect(202);
    return (await h.settled(c, r.body.id)).body;
  };

  describe('video workflow', () => {
    it('queues the job, submits to the provider once, polls until done, and stores the video with a poster', async () => {
      const t = await h.tenant();
      video.statusPlan = [{ state: 'queued' }, { state: 'in_progress', progress: 30 }, { state: 'in_progress', progress: 70 }, { state: 'completed', progress: 100 }];
      const res = await h.submitVideo(t, { seconds: 5, itemType: 'PRODUCT', itemId: t.productId, style: 'LUXURY' }).expect(202);
      // 5 seconds is not a length the provider offers: the shortest one that covers it (8) is requested, reserved and billed.
      expect(res.body).toMatchObject({ kind: 'VIDEO', status: 'QUEUED', outputs: [], params: { requestedSeconds: 5, seconds: 8, format: 'SHORT_VERTICAL', aspectRatio: '9:16', style: 'LUXURY' }, usage: { requestedUnits: 8, unitKind: 'VIDEO_SECOND' } });
      const seen = await h.waitFor(async () => {
        const st = await request(h.http).get(`/api/v1/creative/generations/${res.body.id}/status`).set(as(t)).expect(200);
        return st.body.providerStatus === 'in_progress' ? st.body : null;
      });
      expect(seen).toMatchObject({ status: 'RUNNING', final: false, requestedUnits: 8 });
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 8, completedVideoSeconds: 0 });
      const g = await h.finished(t, res.body.id);
      expect(g).toMatchObject({ status: 'SUCCEEDED', errorCode: null, usage: { producedUnits: 8, requestedUnits: 8, costKnown: true }, job: { providerStatus: 'completed' } });
      expect(g.job.pollCount).toBe(4);
      expect(g.usage.costUsd).toBeCloseTo(0.8, 6); // 8 seconds × $0.10
      // One provider submission, however many polls.
      expect(video.submits).toHaveLength(1);
      expect(video.polls).toHaveLength(4);
      expect(video.submits[0]).toMatchObject({ model: 'sora-2', seconds: 8, size: { width: 720, height: 1280 } });
      expect(video.submits[0]!.prompt).toContain('8-second');
      expect(video.submits[0]!.prompt).toContain('Bissap juice');
      expect(video.submits[0]!.prompt).toContain('Do not invent prices');
      // Stored as a video in the media library, with the provider's poster frame as its thumbnail.
      const o = g.outputs[0];
      expect(o).toMatchObject({ index: 0, width: 720, height: 1280 });
      expect(o.media).toMatchObject({ type: 'VIDEO', status: 'READY', mimeType: 'video/mp4' });
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: o.media.id } });
      expect(row).toMatchObject({ origin: 'AI_GENERATED', folder: 'ai-studio/videos', businessId: t.businessId });
      expect(row.storageKey).toMatch(new RegExp(`^businesses/${t.businessId}/media/[a-f0-9]{32}\\.mp4$`));
      expect(row.thumbnailKey).toBeTruthy();
      expect((await h.download(o.media.thumbnailUrl).expect(200)).headers['content-type']).toBe('image/webp');
      // Playable: the signed URL supports Range requests, and downloads as an attachment.
      const range = await request(h.http).get(o.media.url).set('Range', 'bytes=0-9').buffer(true).expect(206);
      expect(range.headers['content-range']).toMatch(/^bytes 0-9\//);
      expect((await h.download(`${o.media.url}&download=1`).expect(200)).headers['content-disposition']).toMatch(/^attachment/);
      // Usage.
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 8, reservedImages: 0 });
      const rows = await prisma.aIUsage.findMany({ where: { businessId: t.businessId, operation: 'VIDEO_GENERATION' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agent: 'VIDEO_CREATOR', success: true });
      expect(Number(rows[0]!.videoSeconds)).toBe(8);
      expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.8, 6);
    });

    it('history lists videos and deleting one removes the file', async () => {
      const t = await h.tenant();
      const g = await videoGen(t, {});
      const list = await request(h.http).get('/api/v1/creative/generations').query({ kind: 'VIDEO' }).set(as(t)).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].outputs[0].media.type).toBe('VIDEO');
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: g.outputs[0].media.id } });
      await request(h.http).delete(`/api/v1/creative/generations/${g.id}`).set(as(t)).expect(204);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: row.id } })).deletedAt).not.toBeNull();
      await request(h.http).get(row ? g.outputs[0].media.url : '').expect(404);
    });

    it('does not fake video: with no provider configured it says so, stores nothing, and still offers storyboards', async () => {
      const t = await h.tenant();
      video.configured = false;
      const r = await h.submitVideo(t, {}).expect(503);
      expect(r.body.code).toBe('VIDEO_NOT_CONFIGURED');
      expect(r.body.message).toMatch(/Storyboards and scripts are still available/);
      expect(video.submits).toHaveLength(0);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      expect(await prisma.aIUsagePeriod.count({ where: { businessId: t.businessId } })).toBe(0);
      const status = (await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200)).body;
      expect(status.video).toMatchObject({ configured: false, capabilities: null });
      expect(status.storyboard.configured).toBe(true);
    });

    it('validates formats, lengths, scenes and photos', async () => {
      const t = await h.tenant();
      for (const bad of [{ format: 'IMAX' }, { seconds: 3 }, { seconds: 91 }, { style: 'ARTHOUSE' }, { instructions: 'x'.repeat(501) }, { sceneOrder: 0 }, { unknown: 1 }]) await h.submitVideo(t, bad).expect(400);
      expect((await h.submitVideo(t, { format: 'SQUARE', seconds: 45 }).expect(400)).body.code).toBe('VIDEO_LENGTH_INVALID'); // squares are 4-30 s
      expect((await h.submitVideo(t, { sceneOrder: 2 }).expect(400)).body.code).toBe('STORYBOARD_REQUIRED');
      expect((await h.submitVideo(t, { storyboardId: 'c'.repeat(25) }).expect(404)).body.code).toBe('STORYBOARD_NOT_FOUND');
      const caps = video.capabilities as { sizes: Record<string, unknown>; imageToVideo: boolean };
      const square = caps.sizes['1:1'];
      delete caps.sizes['1:1'];
      try {
        expect((await h.submitVideo(t, { format: 'SQUARE', seconds: 8 }).expect(400)).body.code).toBe('VIDEO_FORMAT_UNSUPPORTED');
      } finally {
        caps.sizes['1:1'] = square;
      }
      const photo = await h.upload(t, await studioPhoto());
      caps.imageToVideo = false;
      try {
        expect((await h.submitVideo(t, { sourceMediaId: photo.id }).expect(400)).body.code).toBe('IMAGE_TO_VIDEO_UNSUPPORTED');
      } finally {
        caps.imageToVideo = true;
      }
      const other = await h.tenant('Other photo');
      await h.submitVideo(t, { sourceMediaId: (await h.upload(other, await studioPhoto())).id }).expect(400);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      expect(video.submits).toHaveLength(0);
    });

    it('animates the merchant\'s photo when the provider can', async () => {
      const t = await h.tenant();
      const photo = await h.upload(t, await studioPhoto());
      const g = await videoGen(t, { sourceMediaId: photo.id });
      expect(g.status).toBe('SUCCEEDED');
      expect(video.submits[0]!.source).toMatchObject({ mime: 'image/png' });
    });
  });

  describe('video provider failures', () => {
    it('retries a transient submission failure; the provider job is created once and billed once', async () => {
      const t = await h.tenant();
      jest.spyOn(video, 'submit').mockRejectedValueOnce(new CreativeProviderError('rate_limit', 'busy', 429));
      const g = await videoGen(t, {});
      expect(g).toMatchObject({ status: 'SUCCEEDED', job: { attempts: 2 } });
      expect(video.submits).toHaveLength(1);
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 8 });
      const rows = await prisma.aIUsage.findMany({ where: { businessId: t.businessId, operation: 'VIDEO_GENERATION' }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.success)).toEqual([false, true]);
    });

    it.each([
      ['rate limit', () => new CreativeProviderError('rate_limit', 'busy', 429), 'VIDEO_PROVIDER_RATE_LIMIT', 3],
      ['an outage', () => new CreativeProviderError('server', 'down', 503), 'VIDEO_PROVIDER_ERROR', 3],
      ['bad credentials', () => new CreativeProviderError('auth', 'rejected the configured credentials', 401), 'VIDEO_PROVIDER_AUTH', 1],
      ['a refusal', () => new CreativeProviderError('refusal', 'declined', 400), 'VIDEO_PROVIDER_REFUSED', 1],
    ])('%s while submitting fails with a clear code and releases the reservation', async (_n, err, code, attempts) => {
      const t = await h.tenant();
      video.submitError = (err as () => Error)();
      const g = await videoGen(t, {});
      expect(g).toMatchObject({ status: 'FAILED', errorCode: code, outputs: [], job: { attempts }, usage: { producedUnits: 0 } });
      expect(g.job.providerStatus).toBeNull();
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 0 });
    }, 30_000);

    it('a job the provider reports as failed or declined is final, not retried, and not charged', async () => {
      const t = await h.tenant();
      video.statusPlan = [{ state: 'failed', error: { code: 'moderation_blocked', message: 'Declined by the safety system' } }];
      const refused = await videoGen(t, {});
      expect(refused).toMatchObject({ status: 'FAILED', errorCode: 'VIDEO_PROVIDER_REFUSED', job: { attempts: 1, providerStatus: 'failed' } });
      expect(refused.errorMessage).toContain('Declined by the safety system');
      video.reset();
      video.statusPlan = [{ state: 'failed', error: { code: 'internal', message: 'Rendering failed' } }];
      expect((await videoGen(t, {})).errorCode).toBe('VIDEO_PROVIDER_FAILED');
      expect(video.submits).toHaveLength(1);
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 0 });
    });

    it('gives up on a video that is never ready, and releases the reservation', async () => {
      const t = await h.tenant();
      video.statusPlan = [{ state: 'in_progress', progress: 10 }];
      const res = await h.submitVideo(t, {}).expect(202);
      await h.waitFor(async () => (await prisma.creativeGeneration.findUnique({ where: { id: res.body.id } }))?.pollCount);
      await prisma.creativeGeneration.update({ where: { id: res.body.id }, data: { startedAt: new Date(Date.now() - 30 * 60_000) } });
      const g = await h.finished(t, res.body.id);
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'VIDEO_TIMEOUT' });
      expect(g.errorMessage).toMatch(/not ready after 20 minutes/);
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 0 });
    });

    it('a retry never submits the provider job again, even when the download keeps failing', async () => {
      const t = await h.tenant();
      video.downloadError = new CreativeProviderError('server', 'storage of the provider is down', 503);
      const g = await videoGen(t, {});
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'VIDEO_PROVIDER_ERROR', job: { attempts: 3 } });
      expect(video.submits).toHaveLength(1); // three attempts, one provider job
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 0 });
    }, 30_000);

    it('a transient download failure is retried from the existing provider job', async () => {
      const t = await h.tenant();
      jest.spyOn(video, 'download').mockRejectedValueOnce(new CreativeProviderError('network', 'dropped', undefined));
      const g = await videoGen(t, {});
      expect(g).toMatchObject({ status: 'SUCCEEDED', job: { attempts: 2 } });
      expect(video.submits).toHaveLength(1);
      expect(await h.period(t.businessId)).toMatchObject({ completedVideoSeconds: 8, reservedVideoSeconds: 0 });
    });

    it('does not resubmit when it cannot know whether the provider accepted an earlier submission', async () => {
      const t = await h.tenant();
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined);
      const res = await h.submitVideo(t, {}).expect(202);
      jest.restoreAllMocks();
      // The worker crashed between "ask the provider" and "save its id".
      await prisma.creativeGeneration.update({ where: { id: res.body.id }, data: { providerStatus: 'SUBMITTING' } });
      await queue.enqueue(res.body.id);
      const g = await h.finished(t, res.body.id);
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'VIDEO_SUBMIT_UNKNOWN' });
      expect(g.errorMessage).toMatch(/check your provider dashboard/);
      expect(video.submits).toHaveLength(0); // never risked a second charge
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 0 });
    });

    it('rejects a delivered file that is not a video, or is too large, and cleans up; the provider still billed', async () => {
      const t = await h.tenant();
      jest.spyOn(video, 'download').mockResolvedValueOnce({ data: Buffer.from('<html>not a video</html>'), mime: 'video/mp4' });
      const bad = await videoGen(t, {});
      expect(bad).toMatchObject({ status: 'FAILED', errorCode: 'FILE_TYPE_MISMATCH', outputs: [] });
      expect(await prisma.mediaAsset.count({ where: { businessId: t.businessId } })).toBe(0);
      expect(video.submits).toHaveLength(1); // a bad file is final: no retry
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 8 }); // delivered and billed by the provider
      video.reset();
      jest.spyOn(video, 'download').mockResolvedValueOnce({ data: Buffer.concat([fakeMp4(), Buffer.alloc(3 * 1024 * 1024)]), mime: 'video/mp4' }); // limit in tests: 2 MB
      const big = await videoGen(t, {});
      expect(big).toMatchObject({ status: 'FAILED', errorCode: 'FILE_TOO_LARGE' });
      expect(await prisma.mediaAsset.count({ where: { businessId: t.businessId } })).toBe(0);
    });
  });

  describe('video limits and idempotency', () => {
    it('video seconds are reserved atomically per business: two 8-second videos do not fit in 12 seconds', async () => {
      const t = await h.tenant();
      await h.withPlan(t.businessId, { aiVideoSecondsPerMonth: 12 });
      video.statusPlan = [{ state: 'in_progress' }];
      const results = await Promise.all([h.submitVideo(t, { seconds: 8 }), h.submitVideo(t, { seconds: 8 }), h.submitVideo(t, { seconds: 8 })]);
      const ok = results.filter((r) => r.status === 202);
      expect(ok).toHaveLength(1);
      const no = results.filter((r) => r.status === 429);
      expect(no).toHaveLength(2);
      expect(no[0]!.body).toMatchObject({ code: 'VIDEO_LIMIT_REACHED', usage: { limit: 12, reserved: 8, remaining: 4 } });
      // A 4-second clip still fits; images have their own allowance and are unaffected.
      const four = await h.submitVideo(t, { seconds: 4 }).expect(202);
      await h.submitImage(t, { count: 1 }).expect(202);
      await h.submitVideo(t, { seconds: 4 }).expect(429);
      video.statusPlan = [{ state: 'completed' }];
      for (const r of [ok[0]!, four]) expect((await h.finished(t, r.body.id)).status).toBe('SUCCEEDED');
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 12 });
    }, 60_000);

    it('concurrent requests never exceed the limit (6 clips of 4 s, limit 12 s)', async () => {
      const t = await h.tenant();
      await h.withPlan(t.businessId, { aiVideoSecondsPerMonth: 12 });
      video.statusPlan = [{ state: 'in_progress' }];
      const results = await Promise.all(Array.from({ length: 6 }, () => h.submitVideo(t, { seconds: 4 })));
      expect(results.filter((r) => r.status === 202)).toHaveLength(3);
      expect(results.filter((r) => r.status === 429)).toHaveLength(3);
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 12 });
      video.statusPlan = [{ state: 'completed' }];
      for (const r of results.filter((x) => x.status === 202)) await h.finished(t, r.body.id);
      expect(await h.period(t.businessId)).toMatchObject({ reservedVideoSeconds: 0, completedVideoSeconds: 12 });
    }, 60_000);

    it('the same Idempotency-Key returns the same video job: one reservation, one provider submission', async () => {
      const t = await h.tenant();
      const a = await h.submitVideo(t, {}, 'video-key-0001').expect(202);
      const b = await h.submitVideo(t, {}, 'video-key-0001').expect(202);
      expect(b.body).toMatchObject({ id: a.body.id, replayed: true });
      expect((await h.submitVideo(t, { seconds: 4 }, 'video-key-0001').expect(409)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      await h.finished(t, a.body.id);
      expect(video.submits).toHaveLength(1);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(1);
      expect(await h.period(t.businessId)).toMatchObject({ completedVideoSeconds: 8, reservedVideoSeconds: 0 });
    });
  });

  describe('storyboards (TOUMA AI pipeline)', () => {
    it('queues a script and storyboard through the existing AI pipeline, with grounding and usage tracking', async () => {
      const t = await h.tenant();
      const res = await post(t, '/creative/storyboards', { language: 'en', format: 'SHORT_VERTICAL', seconds: 12, style: 'UGC', tone: 'PLAYFUL', itemType: 'PRODUCT', itemId: t.productId }).expect(202);
      expect(res.body).toMatchObject({ task: 'STORYBOARD', status: 'QUEUED', format: 'SHORT_VERTICAL', statusUrl: `/api/v1/ai/generations/${res.body.id}/status` });
      const g = (await h.settled(t, res.body.id)).body;
      expect(g).toMatchObject({ status: 'SUCCEEDED', task: 'STORYBOARD', promptVersion: 'storyboard-creator@1' });
      expect(g.output).toMatchObject({ format: 'SHORT_VERTICAL', aspectRatio: '9:16', totalSeconds: 12, language: 'en' });
      expect(g.output.scenes.map((s: { order: number }) => s.order)).toEqual([1, 2, 3]);
      expect(g.output.scenes.reduce((n: number, s: { durationSeconds: number }) => n + s.durationSeconds, 0)).toBe(12);
      expect(g.output.videoPrompt.length).toBeGreaterThan(10);
      expect(g.quality).toMatchObject({ passed: true });
      expect(g.usage.inputTokens).toBeGreaterThan(0);
      // The request the model saw: structured parameters and the product's verified facts only.
      const user = text.requests[text.requests.length - 1]!.user;
      expect(user).toContain('"task": "STORYBOARD"');
      expect(user).toContain('"seconds": 12');
      expect(user).toContain('Bissap juice');
      expect(text.requests[text.requests.length - 1]!.system).toContain('TOUMA AI Video Director');
      // Counted with the other AI generations, and recorded by agent.
      expect((await prisma.aIUsagePeriod.findFirst({ where: { businessId: t.businessId } }))!.completedGenerations).toBeGreaterThanOrEqual(2);
      expect(await prisma.aIUsage.count({ where: { businessId: t.businessId, agent: 'VIDEO_CREATOR' } })).toBe(1);
    });

    it('applies the brand kit (colours, style, guidelines) to storyboards and to written content', async () => {
      const t = await h.tenant();
      await request(h.http).put('/api/v1/creative/brand-kit').set(as(t)).send({ colors: [{ name: 'Hibiscus', hex: '#A81D3C', role: 'PRIMARY' }], visualStyle: 'LUXURY', guidelines: 'Always warm and airy.', preferredTone: 'FRIENDLY' }).expect(200);
      await storyboard(t, {});
      const sb = text.requests[text.requests.length - 1]!;
      expect(sb.user).toContain('Always warm and airy.');
      expect(sb.user).toContain('primary #A81D3C');
      expect(sb.system).toContain('Follow the brand kit');
      text.reset();
      const content = await post(t, '/ai/content', { format: 'INSTAGRAM_CAPTION', purpose: 'PROMOTIONAL', tone: 'FRIENDLY', language: 'en' }).expect(202);
      await h.settled(t, content.body.id);
      const cr = text.requests.find((r) => r.system.includes('Content Creator'))!;
      expect(cr.user).toContain('Always warm and airy.');
      expect(cr.user).toContain('"preferredTone": "FRIENDLY"');
      expect(cr.system).toContain('Follow the brand kit');
      // A business without a kit gets none.
      const plain = await h.tenant('No kit');
      text.reset();
      await storyboard(plain, {});
      expect(text.requests[text.requests.length - 1]!.user).toContain('"brand": null');
    });

    it('rejects a storyboard that invents facts, like any other TOUMA AI text', async () => {
      const t = await h.tenant();
      await post(t, '/ai/business-analysis', { language: 'en' }).expect(202).then((r) => h.settled(t, r.body.id)); // warm the analysis cache
      text.reset();
      const invented = (req: Parameters<typeof fakeDefaultAnswer>[0]) => JSON.stringify({ ...fakeDefaultAnswer(req), voiceoverScript: 'Only 999 XAF today, with free delivery!' });
      text.enqueue(invented, invented);
      const g = await storyboard(t, {});
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'AI_INVALID_OUTPUT' });
      expect(g.errorMessage).toMatch(/999 XAF/);
    });

    it('checks its own structure: wrong format, impossible timing', async () => {
      const t = await h.tenant();
      await post(t, '/ai/business-analysis', { language: 'en' }).expect(202).then((r) => h.settled(t, r.body.id));
      text.reset();
      const slow = (req: Parameters<typeof fakeDefaultAnswer>[0]) => {
        const a = fakeDefaultAnswer(req) as { scenes: Array<{ durationSeconds: number }> };
        return JSON.stringify({ ...a, scenes: a.scenes.map((s) => ({ ...s, durationSeconds: s.durationSeconds + 6 })) });
      };
      text.enqueue(slow, slow);
      const g = await storyboard(t, {});
      expect(g.status).toBe('FAILED');
      expect(g.errorMessage).toMatch(/scene durations add up to/);
    });

    it('validates requests, uses only active items, and is limited to people who may use AI', async () => {
      const owner = await h.tenant();
      const viewer = await h.member(owner, 'VIEWER');
      for (const bad of [{ format: 'IMAX' }, { language: 'de' }, { seconds: 3 }, { seconds: 91 }, { style: 'ARTHOUSE' }, { tone: 'ANGRY' }, { itemId: 'nope' }, { x: 1 }]) await post(owner, '/creative/storyboards', { language: 'en', format: 'SHORT_VERTICAL', seconds: 8, ...bad }).expect(400);
      expect((await post(owner, '/creative/storyboards', { language: 'en', format: 'SQUARE', seconds: 60 }).expect(400)).body.code).toBe('VIDEO_LENGTH_INVALID');
      const draft = await post(owner, '/products', { name: 'Hidden', status: 'DRAFT' }).expect(201);
      await post(owner, '/creative/storyboards', { language: 'en', format: 'SHORT_VERTICAL', seconds: 8, itemType: 'PRODUCT', itemId: draft.body.id }).expect(400);
      await post(viewer, '/creative/storyboards', { language: 'en', format: 'SHORT_VERTICAL', seconds: 8 }).expect(403);
      expect(await prisma.aIGeneration.count({ where: { businessId: owner.businessId, task: 'STORYBOARD' } })).toBe(0);
    });

    it('lists only storyboards, per business', async () => {
      const a = await h.tenant('SB A');
      const b = await h.tenant('SB B');
      await storyboard(a, {});
      await post(a, '/ai/business-analysis', { language: 'en' }).expect(202);
      const list = await request(h.http).get('/api/v1/creative/storyboards').set(as(a)).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].task).toBe('STORYBOARD');
      expect((await request(h.http).get('/api/v1/creative/storyboards').set(as(b)).expect(200)).body.total).toBe(0);
    });

    it('turns into a video: the storyboard\'s scenes become the video prompt, or just one scene', async () => {
      const t = await h.tenant();
      const sb = await storyboard(t, { seconds: 12, itemType: 'PRODUCT', itemId: t.productId });
      expect(sb.status).toBe('SUCCEEDED');
      const g = await videoGen(t, { storyboardId: sb.id, seconds: 12, itemType: 'PRODUCT', itemId: t.productId });
      expect(g).toMatchObject({ status: 'SUCCEEDED', params: { storyboardId: sb.id, sceneOrder: null, seconds: 12 } });
      expect(video.submits[0]!.prompt).toContain('Scene 1 (4s)');
      expect(video.submits[0]!.prompt).toContain('Scene 3');
      video.reset();
      await videoGen(t, { storyboardId: sb.id, sceneOrder: 2, seconds: 4 });
      expect(video.submits[0]!.prompt).toContain('Scene 2');
      expect(video.submits[0]!.prompt).not.toContain('Scene 1');
      await h.submitVideo(t, { storyboardId: sb.id, sceneOrder: 9 }).expect(400).expect((r) => expect(r.body.code).toBe('SCENE_NOT_FOUND'));
      // Another business's storyboard is invisible.
      const other = await h.tenant('SB Other');
      await h.submitVideo(other, { storyboardId: sb.id }).expect(404);
    });
  });

  describe('security and isolation', () => {
    it('video jobs are private to the business, and roles apply', async () => {
      const owner = await h.tenant('Vid A');
      const other = await h.tenant('Vid B');
      const viewer = await h.member(owner, 'VIEWER');
      const g = await videoGen(owner, {});
      await h.submitVideo(viewer, {}).expect(403);
      await request(h.http).get(`/api/v1/creative/generations/${g.id}`).set(as(viewer)).expect(200);
      await request(h.http).delete(`/api/v1/creative/generations/${g.id}`).set(as(viewer)).expect(403);
      await request(h.http).get(`/api/v1/creative/generations/${g.id}`).set(as(other)).expect(404);
      await request(h.http).get(`/api/v1/creative/generations/${g.id}/status`).set(as(other)).expect(404);
      await request(h.http).delete(`/api/v1/creative/generations/${g.id}`).set(as(other)).expect(404);
      await request(h.http).get(`/api/v1/media/${g.outputs[0].media.id}`).set(as(other)).expect(404);
      expect((await request(h.http).get('/api/v1/media').query({ type: 'VIDEO' }).set(as(other)).expect(200)).body.items).toHaveLength(0);
      expect((await request(h.http).get('/api/v1/creative/generations').set(as(other)).expect(200)).body.total).toBe(0);
      await request(h.http).get('/api/v1/creative/generations').set({ Authorization: `Bearer ${other.token}`, 'X-Business-Id': owner.businessId }).expect(404);
    });

    it('a provider that returns something that is not a picture cannot put anything in the library', async () => {
      const t = await h.tenant();
      image.enqueue(async () => ({ images: [{ data: Buffer.from('<?php system($_GET["c"]); ?>'), mime: 'image/png' }], model: 'fake:gpt-image-1' }));
      const g = await h.finished(t, (await h.submitImage(t, { count: 1 }).expect(202)).body.id);
      expect(g).toMatchObject({ status: 'FAILED', outputs: [] });
      expect(g.errorMessage).toBe('Unexpected error while generating'); // no internals in the message
      expect(await prisma.mediaAsset.count({ where: { businessId: t.businessId } })).toBe(0);
    });

    it('nothing in any creative response exposes storage keys, hashes or credentials', async () => {
      const t = await h.tenant();
      const g = await videoGen(t, {});
      const dump = JSON.stringify([g, (await request(h.http).get('/api/v1/creative/generations').set(as(t)).expect(200)).body, (await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200)).body]);
      expect(dump).not.toMatch(/businesses\/[a-z0-9]+\/media|checksum|storageKey|sk-|apiKey|Bearer|OPENAI/);
    });
  });
});
