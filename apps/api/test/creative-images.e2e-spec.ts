import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { CreativeProviderError, FakeImageProvider } from '@touma/creative';
import { OBJECT_STORAGE, type ObjectStorage } from '@touma/storage';
import { CreativeQueueService } from '../src/creative/creative-queue';
import { IMAGE_PROVIDER } from '../src/creative/creative-providers';
import { CreativeUsageService } from '../src/creative/creative-usage.service';
import { CreativeWorkerService } from '../src/creative/creative-worker.service';
import { as } from './ai-helpers';
import { creativeHelpers, noisyPhoto, studioPhoto } from './creative-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Creative Studio: brand kit, image generation, product preservation, storage integration, provider failures,
 * usage limits and idempotency. Real PostgreSQL, Redis, BullMQ, the real media pipeline (type checks, scanning,
 * re-encoding, thumbnails, quotas) and in-memory object storage; only the image PROVIDER is the test-only fake
 * (the real adapters are covered by unit tests against a stubbed network).
 */
describe('Creative Studio: brand kit and images (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof creativeHelpers>;
  let image: FakeImageProvider;
  let storage: ObjectStorage;
  let usage: CreativeUsageService;
  let queue: CreativeQueueService;
  let worker: CreativeWorkerService;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    h = creativeHelpers(app);
    image = app.get(IMAGE_PROVIDER);
    storage = app.get(OBJECT_STORAGE);
    usage = app.get(CreativeUsageService);
    queue = app.get(CreativeQueueService);
    worker = app.get(CreativeWorkerService);
  });
  beforeEach(() => image.reset());
  afterEach(() => {
    h.releaseAll();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const put = (c: { token: string; businessId: string }, body: Record<string, unknown>) => request(h.http).put('/api/v1/creative/brand-kit').set(as(c)).send(body);
  const imageGen = async (c: Parameters<typeof as>[0], body: Record<string, unknown> = {}) => h.finished(c, (await h.submitImage(c, body).expect(202)).body.id);

  describe('overview', () => {
    it('reports providers, capabilities, options, usage and storage, and never credentials', async () => {
      const t = await h.tenant();
      const res = await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200);
      expect(res.body.image).toMatchObject({ configured: true, provider: 'fake', model: 'gpt-image-1', capabilities: { edit: true, maxImagesPerRequest: 4 } });
      expect(res.body.video).toMatchObject({ configured: true, capabilities: { seconds: [4, 8, 12], imageToVideo: true } });
      expect(res.body.usage).toMatchObject({ images: { completed: 0, limit: 100 }, videoSeconds: { limit: 120 }, limitSource: 'default' });
      expect(res.body.storage).toMatchObject({ configured: true, usedBytes: 0 });
      expect(res.body.options.aspectRatios).toContain('9:16');
      expect(res.body.options.platformAspects.TIKTOK).toEqual(['9:16']);
      expect(res.body.costTracking).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/apiKey|sk-|OPENAI_API_KEY|secret/i);
    });
  });

  describe('brand kit', () => {
    it('starts empty, saves colours, fonts, style, guidelines and tone, and clears fields with null', async () => {
      const t = await h.tenant();
      const empty = await request(h.http).get('/api/v1/creative/brand-kit').set(as(t)).expect(200);
      expect(empty.body).toMatchObject({ configured: false, colors: [], logo: null, visualStyle: null });
      const saved = await put(t, {
        colors: [{ name: 'Hibiscus', hex: '#a81d3c', role: 'PRIMARY' }, { name: 'Cream', hex: '#FFF4E0', role: 'BACKGROUND' }, { name: 'Ink', hex: '#222222', role: 'TEXT' }],
        headingFont: 'Playfair Display', bodyFont: 'Inter', visualStyle: 'LUXURY', guidelines: 'Warm, airy, handmade.', preferredTone: 'FRIENDLY',
      }).expect(200);
      expect(saved.body).toMatchObject({ configured: true, headingFont: 'Playfair Display', visualStyle: 'LUXURY', preferredTone: 'FRIENDLY', guidelines: 'Warm, airy, handmade.' });
      expect(saved.body.colors[0]).toEqual({ name: 'Hibiscus', hex: '#A81D3C', role: 'PRIMARY' }); // normalised to upper case
      await put(t, { guidelines: null, bodyFont: null }).expect(200);
      const after = (await request(h.http).get('/api/v1/creative/brand-kit').set(as(t)).expect(200)).body;
      expect(after).toMatchObject({ guidelines: null, bodyFont: null, headingFont: 'Playfair Display', visualStyle: 'LUXURY' });
      expect(after.colors).toHaveLength(3); // fields that were not sent are untouched
      expect(await prisma.auditLog.count({ where: { businessId: t.businessId, action: 'creative.brand_kit_updated' } })).toBe(2);
    });

    it.each([
      ['an invalid colour', { colors: [{ name: 'x', hex: 'red', role: 'PRIMARY' }] }],
      ['an unknown colour role', { colors: [{ name: 'x', hex: '#112233', role: 'NEON' }] }],
      ['two primary colours', { colors: [{ name: 'a', hex: '#112233', role: 'PRIMARY' }, { name: 'b', hex: '#445566', role: 'PRIMARY' }] }],
      ['too many accent colours', { colors: Array.from({ length: 4 }, (_, i) => ({ name: `a${i}`, hex: '#112233', role: 'ACCENT' })) }],
      ['more than 8 colours', { colors: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, hex: '#112233', role: 'ACCENT' })) }],
      ['an unknown font', { headingFont: 'Comic Sans' }],
      ['an unknown style', { visualStyle: 'GRUNGE' }],
      ['an unknown tone', { preferredTone: 'ANGRY' }],
      ['overlong guidelines', { guidelines: 'x'.repeat(2001) }],
      ['unknown fields', { businessId: 'other' }],
    ])('rejects %s', async (_n, body) => {
      const t = await h.tenant();
      await put(t, body).expect(400);
    });

    it('the logo is an image of this business: set, shown, cleared; other businesses\' images are refused', async () => {
      const a = await h.tenant('Logo A');
      const b = await h.tenant('Logo B');
      const logo = await h.upload(a, await sharp({ create: { width: 300, height: 120, channels: 4, background: '#a81d3c' } }).png().toBuffer(), 'logo.png');
      const foreign = await h.upload(b, await studioPhoto(), 'b.png');
      await put(a, { logoMediaId: foreign.id }).expect(400); // cross-tenant references in a payload are refused
      const ok = await put(a, { logoMediaId: logo.id }).expect(200);
      expect(ok.body.logo).toMatchObject({ id: logo.id, type: 'IMAGE' });
      expect((await prisma.business.findUniqueOrThrow({ where: { id: a.businessId } })).logoMediaId).toBe(logo.id);
      await put(a, { logoMediaId: null }).expect(200);
      expect((await request(h.http).get('/api/v1/creative/brand-kit').set(as(a)).expect(200)).body.logo).toBeNull();
    });

    it('is private to the business and respects roles', async () => {
      const owner = await h.tenant('Kit A');
      const other = await h.tenant('Kit B');
      const editor = await h.member(owner, 'EDITOR');
      const admin = await h.member(owner, 'ADMIN');
      const viewer = await h.member(owner, 'VIEWER');
      await put(owner, { visualStyle: 'BOLD' }).expect(200);
      expect((await request(h.http).get('/api/v1/creative/brand-kit').set(as(other)).expect(200)).body.visualStyle).toBeNull();
      expect((await request(h.http).get('/api/v1/creative/brand-kit').set(as(viewer)).expect(200)).body.visualStyle).toBe('BOLD'); // everyone can read
      await put(editor, { visualStyle: 'MINIMAL' }).expect(403); // changing the brand is an admin decision
      await put(viewer, { visualStyle: 'MINIMAL' }).expect(403);
      await put(admin, { visualStyle: 'MINIMAL' }).expect(200);
      await request(h.http).get('/api/v1/creative/brand-kit').set({ Authorization: `Bearer ${other.token}`, 'X-Business-Id': owner.businessId }).expect(404);
    });

    it('is applied to generated images: palette, style and guidelines reach the prompt, and it can be turned off', async () => {
      const t = await h.tenant();
      await put(t, { colors: [{ name: 'Hibiscus', hex: '#A81D3C', role: 'PRIMARY' }], visualStyle: 'LUXURY', guidelines: 'Always warm and airy.' }).expect(200);
      const on = await imageGen(t, { itemType: 'PRODUCT', itemId: t.productId });
      expect(image.requests[0]!.prompt).toContain('#A81D3C');
      expect(image.requests[0]!.prompt).toContain('Always warm and airy.');
      expect(image.requests[0]!.prompt).toContain('premium and elegant'); // the kit's LUXURY style is the default
      expect(on.params).toMatchObject({ style: 'LUXURY', useBrandKit: true });
      const prisma1 = await prisma.creativeGeneration.findUniqueOrThrow({ where: { id: on.id } });
      expect(prisma1.brandSnapshot).toMatchObject({ visualStyle: 'LUXURY' });
      image.reset();
      const off = await imageGen(t, { useBrandKit: false });
      expect(image.requests[0]!.prompt).not.toContain('#A81D3C');
      expect(off.params).toMatchObject({ style: 'PHOTOREALISTIC', useBrandKit: false });
      // An explicit style wins over the kit.
      image.reset();
      expect((await imageGen(t, { style: 'PLAYFUL' })).params.style).toBe('PLAYFUL');
    });

    it('the logo is placed on the image on request, and refused when the business has none', async () => {
      const t = await h.tenant();
      await h.submitImage(t, { logoPlacement: 'TOP_LEFT' }).expect(400).expect((r) => expect(r.body.code).toBe('NO_LOGO'));
      const logo = await h.upload(t, await sharp({ create: { width: 300, height: 120, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), 'logo.png');
      await put(t, { logoMediaId: logo.id }).expect(200);
      const g = await imageGen(t, { logoPlacement: 'TOP_LEFT', aspectRatio: '1:1' });
      expect(g.status).toBe('SUCCEEDED');
      const file = await h.download(g.outputs[0].media.url);
      const { data, info } = await sharp(file.body as Buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const o = (Math.round(info.width * 0.04 + 20) * info.width + Math.round(info.width * 0.04 + 20)) * 3; // inside the logo box, top-left
      expect(data[o]).toBeGreaterThan(180); // red logo pixels
      expect(data[o + 1]).toBeLessThan(80);
    });
  });

  describe('image generation workflow', () => {
    it('queues the job (202), generates, stores, and tracks usage and cost', async () => {
      const t = await h.tenant();
      image.enqueue(async (req) => {
        await new Promise((r) => setTimeout(r, 150)); // slow provider: the job is visibly in flight
        return (await new FakeImageProvider().generate(req));
      });
      const res = await h.submitImage(t, { type: 'LIFESTYLE', style: 'NATURAL', aspectRatio: '4:5', resolution: 'STANDARD', background: 'KITCHEN', theme: 'RAMADAN', platform: 'INSTAGRAM', itemType: 'PRODUCT', itemId: t.productId, count: 2 }).expect(202);
      expect(res.body).toMatchObject({ kind: 'IMAGE', status: 'QUEUED', outputs: [], replayed: false, statusUrl: `/api/v1/creative/generations/${res.body.id}/status` });
      const running = await h.waitFor(async () => {
        const st = await request(h.http).get(`/api/v1/creative/generations/${res.body.id}/status`).set(as(t)).expect(200);
        return st.body.status === 'RUNNING' ? st.body : null;
      });
      expect(running).toMatchObject({ final: false, resultAvailable: false, requestedUnits: 2 });
      const g = await h.finished(t, res.body.id);
      expect(g).toMatchObject({ status: 'SUCCEEDED', provider: 'fake', errorCode: null, usage: { requestedUnits: 2, producedUnits: 2, unitKind: 'IMAGE', costKnown: true } });
      expect(g.usage.costUsd).toBeCloseTo(0.08, 6); // 2 images × $0.04
      expect(g.usage.inputTokens).toBeGreaterThan(0);
      expect(g.usage.outputTokens).toBe(2000);
      expect(g.job.attempts).toBe(1);
      expect(g.outputs).toHaveLength(2);
      for (const o of g.outputs) {
        expect([o.width, o.height]).toEqual([864, 1080]); // 4:5 at STANDARD (long edge 1080)
        expect(o.media).toMatchObject({ type: 'IMAGE', status: 'READY', mimeType: 'image/jpeg', width: 864, height: 1080 });
        expect(o.media.thumbnailUrl).toBeTruthy();
        expect(o.upscaled).toBe(false); // the provider's 1024×1536 render is larger than 864×1080: nothing was enlarged
        expect(o.preservation).toBe('NONE');
      }
      // The provider received a native size, a verified-facts prompt and no price.
      expect(image.requests[0]).toMatchObject({ count: 2, size: { width: 1024, height: 1536 } });
      expect(image.requests[0]!.prompt).toContain('Bissap juice');
      expect(image.requests[0]!.prompt).toContain('Ramadan');
      expect(image.requests[0]!.prompt).toContain('Designed for Instagram');
      expect(image.requests[0]!.prompt).not.toMatch(/1500|XAF/);
      // Settled quota: images committed, reservation released.
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0, completedImages: 2 });
      // Recorded with the rest of TOUMA AI usage.
      const rows = await prisma.aIUsage.findMany({ where: { businessId: t.businessId, operation: 'IMAGE_GENERATION' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agent: 'VISUAL_CREATOR', imageCount: 2, success: true, attemptKind: 'creative' });
      expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.08, 6);
      expect(await prisma.auditLog.count({ where: { businessId: t.businessId, action: 'creative.image_requested' } })).toBe(1);
    });

    it('stores results in the media library through the real pipeline: tenant prefix, scan, thumbnail, metadata, origin', async () => {
      const t = await h.tenant();
      const g = await imageGen(t, { count: 1, overlayText: 'Fresh bissap juice', overlayPosition: 'TOP' });
      const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: g.outputs[0].media.id } });
      expect(media).toMatchObject({ businessId: t.businessId, origin: 'AI_GENERATED', status: 'READY', folder: 'ai-studio/images', mimeType: 'image/jpeg', scanStatus: 'SKIPPED', width: 1080, height: 1080 });
      expect(media.storageKey).toMatch(new RegExp(`^businesses/${t.businessId}/media/[a-f0-9]{32}\\.jpg$`));
      expect(media.thumbnailKey).toMatch(new RegExp(`^businesses/${t.businessId}/media/thumbs/`));
      expect(media.tags).toContain('ai-generated');
      expect(media.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await storage.head(media.storageKey)).toMatchObject({ contentType: 'image/jpeg' });
      expect(await storage.head(media.thumbnailKey!)).not.toBeNull();
      // They appear in the library like any media, and count against the storage quota.
      const lib = await request(h.http).get('/api/v1/media').query({ folder: 'ai-studio/images' }).set(as(t)).expect(200);
      expect(lib.body.items.map((m: { id: string }) => m.id)).toContain(media.id);
      const u = await request(h.http).get('/api/v1/media/usage').set(as(t)).expect(200);
      expect(u.body.usedBytes).toBe(Number(media.sizeBytes) + Number(media.thumbnailSizeBytes));
    });

    it('secure downloads: signed URL serves the exact file, with attachment on request; tampering and cross-tenant access fail', async () => {
      const a = await h.tenant('DL A');
      const b = await h.tenant('DL B');
      const g = await imageGen(a, { count: 1 });
      const m = g.outputs[0].media;
      const file = await h.download(m.url).expect(200);
      expect(file.headers['content-type']).toBe('image/jpeg');
      expect((await sharp(file.body as Buffer).metadata()).format).toBe('jpeg');
      expect(file.headers['content-disposition']).toMatch(/^inline/);
      const dl = await h.download(`${m.url}&download=1`).expect(200);
      expect(dl.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''ai-product-ad-/);
      // Thumbnails are signed variants.
      expect((await h.download(m.thumbnailUrl).expect(200)).headers['content-type']).toBe('image/webp');
      // Forged, expired and missing signatures are refused.
      const u = new URL(m.url, 'http://x');
      await request(h.http).get(`${u.pathname}?exp=${u.searchParams.get('exp')}&sig=AAAA`).expect(404);
      await request(h.http).get(`${u.pathname}?exp=1000&sig=${u.searchParams.get('sig')}`).expect(404);
      await request(h.http).get(u.pathname).expect(404);
      // Business B cannot reach A's generation, its media record, or its library.
      await request(h.http).get(`/api/v1/media/${m.id}`).set(as(b)).expect(404);
      await request(h.http).get(`/api/v1/creative/generations/${g.id}`).set(as(b)).expect(404);
      expect((await request(h.http).get('/api/v1/media').query({ folder: 'ai-studio/images' }).set(as(b)).expect(200)).body.items).toHaveLength(0);
    });

    it('validates every setting', async () => {
      const t = await h.tenant();
      for (const bad of [
        { type: 'PORTRAIT' }, { style: 'GLITCH' }, { aspectRatio: '2:1' }, { resolution: '8K' }, { background: 'SPACE' }, { theme: 'HALLOWEEN' }, { overlayPosition: 'LEFT' }, { logoPlacement: 'MIDDLE' },
        { platform: 'MYSPACE' }, { count: 0 }, { count: 5 }, { preservation: 'MAYBE' }, { overlayText: 'x'.repeat(121) }, { instructions: 'x'.repeat(501) }, { itemId: 'not-an-id' }, { unknownField: 1 },
      ]) await h.submitImage(t, bad).expect(400);
      // A platform only gets aspect ratios that suit it.
      const r = await h.submitImage(t, { platform: 'TIKTOK', aspectRatio: '1:1' }).expect(400);
      expect(r.body).toMatchObject({ code: 'ASPECT_NOT_SUITED' });
      expect(r.body.message).toContain('9:16');
      await h.submitImage(t, { platform: 'TIKTOK', aspectRatio: '9:16' }).expect(202);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(1); // only the valid request was stored
    });

    it('uses only ACTIVE items of this business', async () => {
      const a = await h.tenant('Items A');
      const b = await h.tenant('Items B');
      const draft = await request(h.http).post('/api/v1/products').set(as(a)).send({ name: 'Hidden draft', status: 'DRAFT' }).expect(201);
      await h.submitImage(a, { itemType: 'PRODUCT', itemId: draft.body.id }).expect(400).expect((r) => expect(r.body.code).toBe('ITEM_NOT_ACTIVE'));
      await h.submitImage(a, { itemType: 'PRODUCT', itemId: b.productId }).expect(404).expect((r) => expect(r.body.code).toBe('ITEM_NOT_FOUND'));
      expect(await prisma.creativeGeneration.count({ where: { businessId: a.businessId } })).toBe(0);
      expect(await prisma.aIUsagePeriod.count({ where: { businessId: a.businessId } })).toBe(0);
    });

    it('variations: several results to compare, more on demand, one favourite, and a link to the original request', async () => {
      const t = await h.tenant();
      const g = await imageGen(t, { count: 3, itemType: 'PRODUCT', itemId: t.productId });
      expect(g.outputs).toHaveLength(3);
      expect(new Set(g.outputs.map((o: { media: { id: string } }) => o.media.id)).size).toBe(3);
      const sums = await prisma.mediaAsset.findMany({ where: { id: { in: g.outputs.map((o: { media: { id: string } }) => o.media.id) } }, select: { checksumSha256: true } });
      expect(new Set(sums.map((s) => s.checksumSha256)).size).toBe(3); // genuinely different pictures
      // Pick a favourite (one per generation).
      const first = await request(h.http).patch(`/api/v1/creative/outputs/${g.outputs[0].id}`).set(as(t)).send({ selected: true }).expect(200);
      expect(first.body.outputs.map((o: { selected: boolean }) => o.selected)).toEqual([true, false, false]);
      const second = await request(h.http).patch(`/api/v1/creative/outputs/${g.outputs[2].id}`).set(as(t)).send({ selected: true }).expect(200);
      expect(second.body.outputs.map((o: { selected: boolean }) => o.selected)).toEqual([false, false, true]);
      const none = await request(h.http).patch(`/api/v1/creative/outputs/${g.outputs[2].id}`).set(as(t)).send({ selected: false }).expect(200);
      expect(none.body.outputs.every((o: { selected: boolean }) => !o.selected)).toBe(true);
      await request(h.http).patch(`/api/v1/creative/outputs/${g.outputs[0].id}`).set(as(t)).send({ selected: 'yes' }).expect(400);
      // More variations: same settings and prompt, linked to the parent.
      image.reset();
      const v = await request(h.http).post(`/api/v1/creative/generations/${g.id}/variations`).set(as(t)).send({ count: 2, instructions: 'Closer crop' }).expect(202);
      const vg = await h.finished(t, v.body.id);
      expect(vg).toMatchObject({ status: 'SUCCEEDED', parentId: g.id, params: { type: 'PRODUCT_AD', aspectRatio: '1:1', count: 2, instructions: 'Closer crop' } });
      expect(vg.outputs).toHaveLength(2);
      expect(image.requests[0]!.prompt).toContain('Closer crop');
      await request(h.http).post(`/api/v1/creative/generations/${g.id}/variations`).set(as(t)).send({ count: 9 }).expect(400);
    });

    it('history lists generations with outputs, filters and pagination; deleting removes the files', async () => {
      const t = await h.tenant();
      const a = await imageGen(t, { count: 1 });
      await imageGen(t, { count: 1, type: 'PROMO_POSTER' });
      const all = await request(h.http).get('/api/v1/creative/generations').query({ pageSize: 1 }).set(as(t)).expect(200);
      expect(all.body).toMatchObject({ total: 2, pageCount: 2 });
      expect((await request(h.http).get('/api/v1/creative/generations').query({ kind: 'VIDEO' }).set(as(t)).expect(200)).body.total).toBe(0);
      expect((await request(h.http).get('/api/v1/creative/generations').query({ status: 'FAILED' }).set(as(t)).expect(200)).body.total).toBe(0);
      expect(all.body.items[0].outputs).toHaveLength(1);
      const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.outputs[0].media.id } });
      await request(h.http).delete(`/api/v1/creative/generations/${a.id}`).set(as(t)).expect(204);
      expect(await prisma.creativeGeneration.count({ where: { id: a.id } })).toBe(0);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.id } })).deletedAt).not.toBeNull();
      expect(await storage.head(media.storageKey)).toBeNull(); // removed from storage too
      expect(await storage.head(media.thumbnailKey!)).toBeNull();
      await request(h.http).get(`/api/v1/creative/generations/${a.id}`).set(as(t)).expect(404);
    });
  });

  describe('preserving the original product photo', () => {
    it('EXACT: the real product is cut out and composited, never sent to the model; its pixels survive', async () => {
      const t = await h.tenant();
      const photo = await h.upload(t, await studioPhoto());
      const g = await imageGen(t, { sourceMediaId: photo.id, preservation: 'EXACT', itemType: 'PRODUCT', itemId: t.productId, aspectRatio: '1:1', type: 'LIFESTYLE', background: 'KITCHEN' });
      expect(g.status).toBe('SUCCEEDED');
      expect(g.params).toMatchObject({ preservation: 'EXACT', mode: 'SCENE_ONLY' });
      expect(g.outputs[0]).toMatchObject({ preservation: 'EXACT' });
      // The model only drew an empty scene: it never saw the photo and was told there is no product.
      expect(image.requests[0]!.source).toBeUndefined();
      expect(image.requests[0]!.prompt).toMatch(/NO product/);
      expect(image.requests[0]!.prompt).toContain('a warm kitchen or dining setting');
      // The result keeps the product: its red body and blue label are in the middle of a scene that is not white.
      const { data, info } = await sharp((await h.download(g.outputs[0].media.url)).body as Buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => [data[(y * info.width + x) * 3]!, data[(y * info.width + x) * 3 + 1]!, data[(y * info.width + x) * 3 + 2]!];
      const cx = Math.floor(info.width / 2);
      const cy = Math.floor(info.height / 2);
      const body = at(cx, Math.round(cy - info.height * 0.12));
      const label = at(cx, cy);
      expect(body[0]).toBeGreaterThan(190); expect(body[1]).toBeLessThan(60); expect(body[2]).toBeLessThan(60);
      expect(label[2]).toBeGreaterThan(150); expect(label[0]).toBeLessThan(70);
      expect(at(8, 8).join()).not.toBe('255,255,255'); // the white studio backdrop was replaced
    });

    it('GUIDED: the photo goes to the model with an instruction to keep the product unchanged, and the result says it is best effort', async () => {
      const t = await h.tenant();
      const photo = await h.upload(t, await studioPhoto());
      const g = await imageGen(t, { sourceMediaId: photo.id, preservation: 'GUIDED', itemType: 'PRODUCT', itemId: t.productId });
      expect(g.params).toMatchObject({ preservation: 'GUIDED', mode: 'EDIT' });
      expect(g.outputs[0].preservation).toBe('GUIDED');
      expect(image.requests[0]!.source).toMatchObject({ mime: 'image/png' });
      expect(image.requests[0]!.source!.data.length).toBeGreaterThan(100);
      expect(image.requests[0]!.fidelity).toBe('high');
      expect(image.requests[0]!.prompt).toContain('KEEP THE PRODUCT EXACTLY AS IT IS');
    });

    it('refuses EXACT for a photo it cannot separate, with advice, and charges nothing; GUIDED still works', async () => {
      const t = await h.tenant();
      const busy = await h.upload(t, await noisyPhoto());
      const r = await h.submitImage(t, { sourceMediaId: busy.id, preservation: 'EXACT' }).expect(422);
      expect(r.body.code).toBe('PRODUCT_CUTOUT_FAILED');
      expect(r.body.message).toMatch(/plain or transparent background/);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      expect(await prisma.aIUsagePeriod.count({ where: { businessId: t.businessId } })).toBe(0);
      await imageGen(t, { sourceMediaId: busy.id, preservation: 'GUIDED' });
    });

    it('only photos of this business can be used', async () => {
      const a = await h.tenant('Src A');
      const b = await h.tenant('Src B');
      const foreign = await h.upload(b, await studioPhoto());
      await h.submitImage(a, { sourceMediaId: foreign.id }).expect(400);
      await h.submitImage(a, { sourceMediaId: 'c'.repeat(25) }).expect(400);
      expect(await prisma.creativeGeneration.count({ where: { businessId: a.businessId } })).toBe(0);
    });

    it('without a photo the product is only an illustration, and the result says so (no preservation claim)', async () => {
      const t = await h.tenant();
      const g = await imageGen(t, { itemType: 'PRODUCT', itemId: t.productId });
      expect(g.params).toMatchObject({ preservation: 'NONE', mode: 'TEXT_TO_IMAGE' });
      expect(g.outputs[0].preservation).toBe('NONE');
      expect(image.requests[0]!.prompt).toContain('Do not invent packaging');
    });
  });

  describe('text on the image', () => {
    it('is checked against the verified business data like any AI text', async () => {
      const t = await h.tenant();
      const bad = await h.submitImage(t, { overlayText: 'Only 999 XAF today, free delivery!' }).expect(422);
      expect(bad.body.code).toBe('OVERLAY_UNVERIFIED');
      expect(bad.body.issues.join()).toMatch(/999 XAF/);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      const ok = await imageGen(t, { overlayText: 'Fresh bissap, 1 500 XAF', overlayPosition: 'BOTTOM', itemType: 'PRODUCT', itemId: t.productId });
      expect(ok.status).toBe('SUCCEEDED');
      // The model is told not to draw text; TOUMA draws it.
      expect(image.requests[0]!.prompt).toContain('Do NOT draw any words');
      expect(image.requests[0]!.prompt).toContain('Leave a calm, uncluttered area');
      expect(image.requests[0]!.prompt).not.toContain('Fresh bissap');
    });

    it('is drawn on the result, where requested', async () => {
      const t = await h.tenant();
      const plain = await imageGen(t, { aspectRatio: '1:1', background: 'WHITE_STUDIO' });
      image.reset();
      const withText = await imageGen(t, { aspectRatio: '1:1', background: 'WHITE_STUDIO', overlayText: 'Fresh bissap', overlayPosition: 'TOP' });
      const dims = async (g: { outputs: Array<{ media: { url: string } }> }) => (await sharp((await h.download(g.outputs[0]!.media.url)).body as Buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
      const [pa, pb] = await Promise.all([dims(plain), dims(withText)]);
      const rowsChanged = (from: number, to: number) => { let n = 0; for (let y = from; y < to; y++) for (let x = 0; x < pa.info.width; x++) if (Math.abs(pa.data[(y * pa.info.width + x) * 3]! - pb.data[(y * pb.info.width + x) * 3]!) > 12) n++; return n; };
      expect(rowsChanged(0, 300)).toBeGreaterThan(3000);
    });
  });

  describe('storage integration and cleanup of failed generations', () => {
    it('refuses to start when the storage quota is full, charging nothing', async () => {
      const t = await h.tenant();
      await imageGen(t, { count: 1 }); // something is stored
      await prisma.business.update({ where: { id: t.businessId }, data: { storageQuotaBytes: 1n } });
      const before = await h.period(t.businessId);
      const r = await h.submitImage(t, {}).expect(413);
      expect(r.body.code).toBe('STORAGE_QUOTA_EXCEEDED');
      expect(await h.period(t.businessId)).toEqual(before);
      expect(image.requests).toHaveLength(1);
    });

    it('a generation that runs out of storage part-way fails cleanly: stored results are removed, billed images stay counted', async () => {
      const t = await h.tenant();
      const first = await imageGen(t, { count: 1 });
      const m = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.outputs[0].media.id } });
      const one = Number(m.sizeBytes) + Number(m.thumbnailSizeBytes);
      // Room for about one and a half images: the first of the next three fits, the second does not.
      await prisma.business.update({ where: { id: t.businessId }, data: { storageQuotaBytes: BigInt(one * 2 + Math.floor(one / 2)) } });
      image.reset();
      const g = await imageGen(t, { count: 3, aspectRatio: '1:1' });
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'STORAGE_QUOTA_EXCEEDED', outputs: [] });
      expect(image.requests).toHaveLength(1); // not retried: the provider had already produced (and billed) the images
      // Nothing is left behind: no outputs, the file that did fit is deleted from the library and from storage.
      expect(await prisma.creativeOutput.count({ where: { generationId: g.id } })).toBe(0);
      const left = await prisma.mediaAsset.findMany({ where: { businessId: t.businessId, origin: 'AI_GENERATED', deletedAt: null } });
      expect(left.map((x) => x.id)).toEqual([m.id]); // only the first, successful generation's image remains
      const removed = await prisma.mediaAsset.findMany({ where: { businessId: t.businessId, deletedAt: { not: null } } });
      expect(removed).toHaveLength(1);
      expect(await storage.head(removed[0]!.storageKey)).toBeNull();
      // The provider billed 3 images: they count against the month even though they could not be kept.
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0, completedImages: 1 + 3 });
      expect((await prisma.creativeGeneration.findUniqueOrThrow({ where: { id: g.id } })).producedUnits).toBe(3);
    });

    it('is not available without configured storage (nothing is queued or charged)', async () => {
      const t = await h.tenant();
      const mutable = storage as { configured: boolean };
      mutable.configured = false;
      try {
        const r = await h.submitImage(t, {}).expect(503);
        expect(r.body.code).toBe('STORAGE_NOT_CONFIGURED');
        expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      } finally {
        mutable.configured = true;
      }
    });
  });

  describe('provider failures', () => {
    it('no provider configured: 503 IMAGE_NOT_CONFIGURED, nothing stored or charged', async () => {
      const t = await h.tenant();
      image.configured = false;
      const r = await h.submitImage(t, {}).expect(503);
      expect(r.body.code).toBe('IMAGE_NOT_CONFIGURED');
      expect(image.requests).toHaveLength(0);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(0);
      expect((await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200)).body.image.configured).toBe(false);
    });

    it('retries transient failures with backoff and bills once', async () => {
      const t = await h.tenant();
      image.enqueue(new CreativeProviderError('rate_limit', 'busy', 429), new CreativeProviderError('server', 'down', 503));
      const g = await imageGen(t, { count: 2 });
      expect(g).toMatchObject({ status: 'SUCCEEDED', job: { attempts: 3 } });
      expect(image.requests).toHaveLength(3);
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0, completedImages: 2 });
      const rows = await prisma.aIUsage.findMany({ where: { businessId: t.businessId, operation: 'IMAGE_GENERATION' }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.success)).toEqual([false, false, true]); // every call is recorded; only the successful one carries images
      expect(rows.map((r) => r.imageCount)).toEqual([0, 0, 2]);
    });

    it.each([
      ['rate limit', () => [1, 2, 3].map(() => new CreativeProviderError('rate_limit', 'busy', 429)), 'IMAGE_PROVIDER_RATE_LIMIT', 3],
      ['an outage', () => [1, 2, 3].map(() => new CreativeProviderError('server', 'down', 503)), 'IMAGE_PROVIDER_ERROR', 3],
      ['bad credentials', () => [new CreativeProviderError('auth', 'rejected the configured credentials', 401)], 'IMAGE_PROVIDER_AUTH', 1],
      ['no remaining quota', () => [new CreativeProviderError('billing', 'no quota', 429)], 'IMAGE_PROVIDER_BILLING', 1],
      ['a refusal', () => [new CreativeProviderError('refusal', 'declined by the safety system', 400)], 'IMAGE_PROVIDER_REFUSED', 1],
      ['a bad request', () => [new CreativeProviderError('bad_request', 'invalid size', 400)], 'IMAGE_PROVIDER_BAD_REQUEST', 1],
      ['an empty answer', () => [new CreativeProviderError('invalid_output', 'no image', 200)], 'IMAGE_PROVIDER_INVALID_OUTPUT', 1],
    ])('%s fails the job with a clear code, retries only transient errors, and releases the reservation', async (_n, errors, code, calls) => {
      const t = await h.tenant();
      image.enqueue(...(errors as () => Error[])());
      const g = await imageGen(t, { count: 2 });
      expect(g).toMatchObject({ status: 'FAILED', errorCode: code, outputs: [], usage: { producedUnits: 0 } });
      expect(image.requests).toHaveLength(calls as number);
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0, completedImages: 0 }); // nothing produced, nothing charged
      expect(await prisma.mediaAsset.count({ where: { businessId: t.businessId, origin: 'AI_GENERATED' } })).toBe(0);
    }, 30_000);

    it('never leaks the prompt or credentials in a stored error', async () => {
      const t = await h.tenant();
      image.enqueue(new CreativeProviderError('bad_request', 'The request was rejected', 400));
      const g = await imageGen(t, { instructions: 'SECRET CAMPAIGN WORDS' });
      expect(JSON.stringify({ e: g.errorMessage, c: g.errorCode })).not.toMatch(/SECRET CAMPAIGN|sk-|Bearer/);
    });

    it('re-checks permissions when the job runs: a member removed after submitting gets nothing generated', async () => {
      const owner = await h.tenant();
      const editor = await h.member(owner, 'EDITOR');
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined);
      const res = await h.submitImage(editor, {}).expect(202);
      jest.restoreAllMocks();
      await prisma.membership.updateMany({ where: { userId: editor.userId, businessId: owner.businessId }, data: { status: 'REVOKED' } });
      await queue.enqueue(res.body.id);
      const g = await h.finished(owner, res.body.id);
      expect(g).toMatchObject({ status: 'FAILED', errorCode: 'CREATIVE_FORBIDDEN' });
      expect(image.requests).toHaveLength(0);
      expect(await h.period(owner.businessId)).toMatchObject({ reservedImages: 0, completedImages: 0 });
    });
  });

  describe('usage limits', () => {
    it('concurrent requests never exceed the plan limit (10 requests, limit 3 images)', async () => {
      const t = await h.tenant();
      await h.withPlan(t.businessId, { aiImagesPerMonth: 3 });
      const release = (() => { let r!: () => void; const open = new Promise<void>((res) => (r = res)); for (let i = 0; i < 20; i++) image.enqueue(async (req) => { await open; return new FakeImageProvider().generate(req); }); return r; })();
      const results = await Promise.all(Array.from({ length: 10 }, () => h.submitImage(t, { count: 1 })));
      const accepted = results.filter((r) => r.status === 202);
      expect(accepted).toHaveLength(3);
      const rejected = results.filter((r) => r.status === 429);
      expect(rejected).toHaveLength(7);
      expect(new Set(rejected.map((r) => r.body.code))).toEqual(new Set(['IMAGE_LIMIT_REACHED']));
      expect(rejected[0]!.body.usage).toMatchObject({ limit: 3, reserved: 3 });
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 3, completedImages: 0 });
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(3); // rejected requests left no trace
      release();
      for (const r of accepted) expect((await h.finished(t, r.body.id)).status).toBe('SUCCEEDED');
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0, completedImages: 3 });
      await h.submitImage(t, { count: 1 }).expect(429);
    }, 60_000);

    it('a request is accepted only if all its images fit in what is left', async () => {
      const t = await h.tenant();
      await h.withPlan(t.businessId, { aiImagesPerMonth: 5 });
      await imageGen(t, { count: 3 });
      const r = await h.submitImage(t, { count: 3 }).expect(429);
      expect(r.body.usage).toMatchObject({ completed: 3, limit: 5, remaining: 2 });
      await imageGen(t, { count: 2 });
      expect((await request(h.http).get('/api/v1/creative/status').set(as(t)).expect(200)).body.usage).toMatchObject({ images: { completed: 5, remaining: 0, limit: 5 }, limitSource: 'plan' });
    });

    it('limits are per business and per month', async () => {
      const a = await h.tenant('Lim A');
      const b = await h.tenant('Lim B');
      await h.withPlan(a.businessId, { aiImagesPerMonth: 1 });
      await imageGen(a, { count: 1 });
      await h.submitImage(a, { count: 1 }).expect(429);
      await imageGen(b, { count: 1 }); // B has its own counters and the default limit
      expect(await h.period(b.businessId)).toMatchObject({ completedImages: 1 });
      // Last month's usage does not count against this month.
      const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 10));
      const prevPeriod = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth(), 1));
      await prisma.aIUsagePeriod.create({ data: { businessId: b.businessId, periodStart: prevPeriod, completedImages: 99 } });
      await imageGen(b, { count: 1 });
      expect((await usage.monthToDate(b.businessId)).images.completed).toBe(2);
    });

    it('settlement is exactly once, and self-healing recovers lost jobs and unsettled reservations', async () => {
      const t = await h.tenant();
      const g = await imageGen(t, { count: 2 });
      const before = await h.period(t.businessId);
      expect(await usage.settle(g.id)).toBeNull(); // settling again changes nothing
      expect(await h.period(t.businessId)).toEqual(before);
      // An accepted generation whose job was never created (crash after commit) is re-enqueued and completes.
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined);
      const lost = await h.submitImage(t, { count: 1 }).expect(202);
      jest.restoreAllMocks();
      await prisma.creativeGeneration.update({ where: { id: lost.body.id }, data: { queuedAt: new Date(Date.now() - 5 * 60_000) } });
      expect(await worker.reconcile()).toMatchObject({ requeued: 1 });
      expect((await h.finished(t, lost.body.id)).status).toBe('SUCCEEDED');
      // A job that vanished from the queue long ago is failed and its reservation released.
      jest.spyOn(queue, 'enqueue').mockResolvedValueOnce(undefined);
      const gone = await h.submitImage(t, { count: 1 }).expect(202);
      jest.restoreAllMocks();
      await prisma.creativeGeneration.update({ where: { id: gone.body.id }, data: { status: 'RUNNING', queuedAt: new Date(Date.now() - 3 * 3600_000) } });
      expect(await worker.reconcile()).toMatchObject({ failed: 1 });
      expect(await prisma.creativeGeneration.findUniqueOrThrow({ where: { id: gone.body.id } })).toMatchObject({ status: 'FAILED', errorCode: 'CREATIVE_JOB_STALLED' });
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0 });
      // A finished generation whose reservation was left open is settled by the reconciler.
      const f = await imageGen(t, { count: 1 });
      await prisma.creativeGeneration.update({ where: { id: f.id }, data: { settledAt: null } });
      await prisma.aIUsagePeriod.updateMany({ where: { businessId: t.businessId }, data: { reservedImages: 1, completedImages: { decrement: 1 } } });
      expect(await worker.reconcile()).toMatchObject({ settled: 1 });
      expect(await h.period(t.businessId)).toMatchObject({ reservedImages: 0 });
    });
  });

  describe('job idempotency', () => {
    it('the same Idempotency-Key and body returns the same generation: one reservation, one provider call', async () => {
      const t = await h.tenant();
      const a = await h.submitImage(t, { count: 2 }, 'idem-key-0001').expect(202);
      const b = await h.submitImage(t, { count: 2 }, 'idem-key-0001').expect(202);
      expect(b.body.id).toBe(a.body.id);
      expect(a.body.replayed).toBe(false);
      expect(b.body.replayed).toBe(true);
      await h.finished(t, a.body.id);
      const c = await h.submitImage(t, { count: 2 }, 'idem-key-0001').expect(202); // also after completion
      expect(c.body).toMatchObject({ id: a.body.id, replayed: true, status: 'SUCCEEDED' });
      expect(image.requests).toHaveLength(1);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(1);
      expect(await h.period(t.businessId)).toMatchObject({ completedImages: 2, reservedImages: 0 });
    });

    it('the same key with different parameters is a conflict, and an invalid key is refused', async () => {
      const t = await h.tenant();
      await h.submitImage(t, { count: 1 }, 'idem-key-0002').expect(202);
      const r = await h.submitImage(t, { count: 2 }, 'idem-key-0002').expect(409);
      expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      await h.submitImage(t, {}, 'short').expect(400);
      await h.submitImage(t, {}, 'has spaces in it!').expect(400);
    });

    it('simultaneous identical requests create exactly one generation', async () => {
      const t = await h.tenant();
      const results = await Promise.all(Array.from({ length: 6 }, () => h.submitImage(t, { count: 1 }, 'idem-race-0001')));
      expect(results.every((r) => r.status === 202)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      await h.finished(t, results[0]!.body.id);
      expect(image.requests).toHaveLength(1);
      expect(await prisma.creativeGeneration.count({ where: { businessId: t.businessId } })).toBe(1);
      expect(await h.period(t.businessId)).toMatchObject({ completedImages: 1, reservedImages: 0 });
    });

    it('keys are scoped to the business: another business with the same key gets its own generation', async () => {
      const a = await h.tenant('Key A');
      const b = await h.tenant('Key B');
      const ra = await h.submitImage(a, { count: 1 }, 'idem-shared-01').expect(202);
      const rb = await h.submitImage(b, { count: 1 }, 'idem-shared-01').expect(202);
      expect(ra.body.id).not.toBe(rb.body.id);
      expect(rb.body.replayed).toBe(false);
      await Promise.all([h.finished(a, ra.body.id), h.finished(b, rb.body.id)]);
    });

    it('a finished job delivered again does no new work', async () => {
      const t = await h.tenant();
      const g = await imageGen(t, { count: 1 });
      await queue.enqueue(g.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(image.requests).toHaveLength(1);
      expect((await prisma.creativeOutput.count({ where: { generationId: g.id } }))).toBe(1);
    });
  });

  describe('roles and isolation', () => {
    it('viewers can look but not generate or delete; another business sees nothing', async () => {
      const owner = await h.tenant('Role A');
      const other = await h.tenant('Role B');
      const viewer = await h.member(owner, 'VIEWER');
      const editor = await h.member(owner, 'EDITOR');
      const g = await imageGen(owner, { count: 1 });
      await h.submitImage(viewer, {}).expect(403);
      await request(h.http).get(`/api/v1/creative/generations/${g.id}`).set(as(viewer)).expect(200);
      await request(h.http).get('/api/v1/creative/generations').set(as(viewer)).expect(200);
      await request(h.http).delete(`/api/v1/creative/generations/${g.id}`).set(as(viewer)).expect(403);
      await request(h.http).patch(`/api/v1/creative/outputs/${g.outputs[0].id}`).set(as(viewer)).send({ selected: true }).expect(403);
      const edited = await h.submitImage(editor, { count: 1 }).expect(202); // editors create
      await h.finished(owner, edited.body.id);
      // Business B: every door is a 404.
      const spoof = { Authorization: `Bearer ${other.token}`, 'X-Business-Id': owner.businessId };
      const door = (m: 'get' | 'post' | 'delete' | 'patch', path: string, body?: object) => (request(h.http) as never as Record<string, (u: string) => request.Test>)[m](`/api/v1/creative${path}`).set(as(other)).send(body ?? {});
      await door('get', `/generations/${g.id}`).expect(404);
      await door('get', `/generations/${g.id}/status`).expect(404);
      await door('post', `/generations/${g.id}/variations`, { count: 1 }).expect(404);
      await door('delete', `/generations/${g.id}`).expect(404);
      await door('patch', `/outputs/${g.outputs[0].id}`, { selected: true }).expect(404);
      await request(h.http).get('/api/v1/creative/generations').set(spoof).expect(404);
      await h.submitImage({ token: other.token, businessId: owner.businessId }, {}).expect(404);
      expect((await request(h.http).get('/api/v1/creative/generations').set(as(other)).expect(200)).body.total).toBe(0);
      await request(h.http).get('/api/v1/creative/generations').set('X-Business-Id', owner.businessId).expect(401);
    });

    it('a worker only ever sends one business\'s facts to the provider, even with jobs interleaved', async () => {
      const a = await h.tenant('Mix A');
      const b = await h.tenant('Mix B');
      const [ra, rb] = await Promise.all([h.submitImage(a, { itemType: 'PRODUCT', itemId: a.productId }), h.submitImage(b, { itemType: 'PRODUCT', itemId: b.productId })]);
      await Promise.all([h.finished(a, ra.body.id), h.finished(b, rb.body.id)]);
      for (const r of image.requests) expect(r.prompt.includes('Mix A') && r.prompt.includes('Mix B')).toBe(false);
      expect(image.requests.some((r) => r.prompt.includes('Mix A Bissap'))).toBe(true);
      expect(image.requests.some((r) => r.prompt.includes('Mix B Bissap'))).toBe(true);
      expect(Object.keys((await queue.getJob(ra.body.id))?.data ?? { generationId: 1 })).toEqual(['generationId']); // ids only in Redis
    });
  });
});
