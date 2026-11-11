import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { BusinessRole } from '@touma/database';
import { prisma, register, resetDb, startApp } from './helpers';
import { createHash } from 'crypto';
import { html, mp4, png, svg } from './fixtures';

/**
 * Phase 2 integration tests against a real PostgreSQL database.
 * Object storage uses the TEST-ONLY in-memory driver (same contract as S3).
 */
describe('Phase 2: businesses, catalog, media, knowledge (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  type Ctx = { token: string; businessId: string; email: string };
  const as = (c: Ctx) => ({ Authorization: `Bearer ${c.token}`, 'X-Business-Id': c.businessId });

  async function tenant(body: Record<string, unknown> = {}): Promise<Ctx> {
    const user = await register(app);
    const res = await request(http)
      .post('/api/v1/businesses')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Café Awa', type: 'RESTAURANT', currency: 'XAF', ...body })
      .expect(201);
    return { token: user.accessToken, businessId: res.body.id, email: user.email };
  }

  async function member(owner: Ctx, role: BusinessRole): Promise<Ctx> {
    const user = await register(app);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: user.email } });
    await prisma.membership.create({ data: { userId: u.id, businessId: owner.businessId, role, status: 'ACTIVE' } });
    return { token: user.accessToken, businessId: owner.businessId, email: user.email };
  }

  const upload = (c: Ctx, buf: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) => {
    let r = request(http).post('/api/v1/media').set(as(c));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', buf, { filename, contentType });
  };

  // ─── Business management ─────────────────────────────────────────────────────
  describe('business management', () => {
    it('stores contact information, city and seeds localized industry categories', async () => {
      const t = await tenant({ city: "N'Djamena", contactEmail: 'Hello@Cafe.Example', contactPhone: '+235 66 00 00 00', defaultLocale: 'fr', address: 'Avenue Charles de Gaulle' });
      const b = await request(http).get(`/api/v1/businesses/${t.businessId}`).set(as(t)).expect(200);
      expect(b.body).toMatchObject({ city: "N'Djamena", contactEmail: 'hello@cafe.example', contactPhone: '+235 66 00 00 00', logoUrl: null });
      const cats = await request(http).get('/api/v1/product-categories').set(as(t)).expect(200);
      expect(cats.body.map((c: { name: string }) => c.name)).toEqual(['Entrées', 'Plats', 'Desserts', 'Boissons', 'Menus & formules']);
      expect(cats.body.every((c: { isDefault: boolean }) => c.isDefault)).toBe(true);
      const svc = await request(http).get('/api/v1/service-categories').set(as(t)).expect(200);
      expect(svc.body.map((c: { slug: string }) => c.slug)).toContain('delivery');
    });

    it.each([[{ contactEmail: 'not-an-email' }], [{ contactPhone: 'call me maybe' }], [{ city: 'x'.repeat(121) }]])('validates contact fields %#', async (body) => {
      const t = await tenant();
      await request(http).patch(`/api/v1/businesses/${t.businessId}`).set(as(t)).send(body).expect(400);
    });

    it('sets a logo only from its own image library and serves it through a signed URL', async () => {
      const a = await tenant();
      const b = await tenant();
      const img = await upload(a, png(64, 64), 'logo.png', 'image/png').expect(201);
      const foreign = await upload(b, png(), 'b.png', 'image/png').expect(201);
      const video = await upload(a, mp4(), 'clip.mp4', 'video/mp4').expect(201);

      await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(as(a)).send({ logoMediaId: foreign.body.id }).expect(400);
      await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(as(a)).send({ logoMediaId: video.body.id }).expect(400);
      const res = await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(as(a)).send({ logoMediaId: img.body.id }).expect(200);
      expect(res.body.logoUrl).toMatch(/^\/api\/v1\/media\/\w+\/content\?exp=\d+&sig=/);
      const content = await request(http).get(res.body.logoUrl).expect(200);
      expect(content.headers['content-type']).toBe('image/png');

      const cleared = await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(as(a)).send({ logoMediaId: null }).expect(200);
      expect(cleared.body.logoUrl).toBeNull();
    });
  });

  // ─── Products ────────────────────────────────────────────────────────────────
  describe('products', () => {
    let t: Ctx;
    beforeAll(async () => {
      t = await tenant();
    });

    it('creates a product with exact decimal prices and business currency by default', async () => {
      const cats = await request(http).get('/api/v1/product-categories').set(as(t));
      const res = await request(http)
        .post('/api/v1/products')
        .set(as(t))
        .send({
          name: 'Bissap juice 1L',
          price: '1500',
          discountPrice: '1199.99',
          sku: 'BSP-1L',
          stockQuantity: 40,
          categoryId: cats.body[3].id,
          features: [' Natural ', '', 'Cold-pressed'],
          benefits: ['Refreshing'],
          targetAudience: 'Families',
          status: 'ACTIVE',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        price: '1500.00',
        discountPrice: '1199.99',
        currency: 'XAF',
        availability: 'IN_STOCK',
        features: ['Natural', 'Cold-pressed'],
        category: { name: 'Drinks' },
        media: [],
      });
      expect(res.body).not.toHaveProperty('businessId');
      const row = await prisma.product.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.price?.toString()).toBe('1500');
    });

    it.each([
      [{ name: 'X', price: 15.5 }],
      [{ name: 'X', price: '12.345' }],
      [{ name: 'X', price: '-3' }],
      [{ name: 'X', price: '10', discountPrice: '10' }],
      [{ name: 'X', price: '10', discountPrice: '12' }],
      [{ name: 'X', discountPrice: '5' }],
      [{ name: 'X', stockQuantity: -1 }],
      [{ name: 'X', availability: 'MAYBE' }],
      [{ name: 'X', url: 'javascript:alert(1)' }],
      [{ name: 'X', features: Array(21).fill('f') }],
      [{ name: 'X', businessId: 'someone-else' }],
      [{ name: '' }],
    ])('rejects invalid product %#', async (body) => {
      await request(http).post('/api/v1/products').set(as(t)).send(body).expect(400);
    });

    it('enforces SKU uniqueness per business and releases the SKU on delete', async () => {
      const p = await request(http).post('/api/v1/products').set(as(t)).send({ name: 'A', sku: 'DUP-1' }).expect(201);
      const dup = await request(http).post('/api/v1/products').set(as(t)).send({ name: 'B', sku: 'DUP-1' }).expect(409);
      expect(dup.body.code).toBe('SKU_TAKEN');
      // Same SKU is fine in another business.
      const other = await tenant();
      await request(http).post('/api/v1/products').set(as(other)).send({ name: 'B', sku: 'DUP-1' }).expect(201);
      await request(http).delete(`/api/v1/products/${p.body.id}`).set(as(t)).expect(204);
      await request(http).get(`/api/v1/products/${p.body.id}`).set(as(t)).expect(404);
      await request(http).post('/api/v1/products').set(as(t)).send({ name: 'C', sku: 'DUP-1' }).expect(201);
    });

    it('updates partially, re-validates discount against stored price, and clears fields with null', async () => {
      const p = await request(http).post('/api/v1/products').set(as(t)).send({ name: 'Shoes', price: '100', discountPrice: '80' }).expect(201);
      await request(http).patch(`/api/v1/products/${p.body.id}`).set(as(t)).send({ price: '70' }).expect(400);
      const res = await request(http)
        .patch(`/api/v1/products/${p.body.id}`)
        .set(as(t))
        .send({ discountPrice: null, price: '70', stockQuantity: null, availability: 'PREORDER' })
        .expect(200);
      expect(res.body).toMatchObject({ price: '70.00', discountPrice: null, stockQuantity: null, availability: 'PREORDER' });
      await request(http).patch(`/api/v1/products/${p.body.id}`).set(as(t)).send({}).expect(400);
    });

    it('searches, filters, sorts and paginates', async () => {
      const s = await tenant();
      const cats = await request(http).get('/api/v1/product-categories').set(as(s));
      const drinks = cats.body.find((c: { slug: string }) => c.slug === 'drinks').id;
      for (let i = 1; i <= 7; i++) {
        await request(http)
          .post('/api/v1/products')
          .set(as(s))
          .send({ name: `Mango smoothie ${i}`, price: `${i}00`, categoryId: i % 2 ? drinks : undefined, status: i <= 5 ? 'ACTIVE' : 'DRAFT' })
          .expect(201);
      }
      await request(http).post('/api/v1/products').set(as(s)).send({ name: 'Grilled fish', sku: 'FISH' }).expect(201);

      const page1 = await request(http).get('/api/v1/products').query({ q: 'mango', pageSize: 3, sort: 'price', order: 'asc' }).set(as(s)).expect(200);
      expect(page1.body).toMatchObject({ total: 7, page: 1, pageSize: 3, pageCount: 3 });
      expect(page1.body.items.map((p: { price: string }) => p.price)).toEqual(['100.00', '200.00', '300.00']);
      const page3 = await request(http).get('/api/v1/products').query({ q: 'mango', pageSize: 3, page: 3, sort: 'price', order: 'asc' }).set(as(s)).expect(200);
      expect(page3.body.items).toHaveLength(1);

      const bySku = await request(http).get('/api/v1/products').query({ q: 'fish' }).set(as(s)).expect(200);
      expect(bySku.body.total).toBe(1);
      const inCat = await request(http).get('/api/v1/products').query({ categoryId: drinks }).set(as(s)).expect(200);
      expect(inCat.body.total).toBe(4);
      const none = await request(http).get('/api/v1/products').query({ categoryId: 'none' }).set(as(s)).expect(200);
      expect(none.body.total).toBe(4);
      const drafts = await request(http).get('/api/v1/products').query({ status: 'DRAFT' }).set(as(s)).expect(200);
      expect(drafts.body.total).toBe(3);
      await request(http).get('/api/v1/products').query({ pageSize: 500 }).set(as(s)).expect(400);
      await request(http).get('/api/v1/products').query({ sort: 'password' }).set(as(s)).expect(400);
    });

    it('attaches ordered media that belongs to the business only', async () => {
      const p = await request(http).post('/api/v1/products').set(as(t)).send({ name: 'Gallery product' }).expect(201);
      const a = await upload(t, png(), 'a.png', 'image/png').expect(201);
      const v = await upload(t, mp4(), 'v.mp4', 'video/mp4').expect(201);
      const res = await request(http).put(`/api/v1/products/${p.body.id}/media`).set(as(t)).send({ mediaIds: [v.body.id, a.body.id] }).expect(200);
      expect(res.body.media.map((m: { id: string; position: number }) => [m.id, m.position])).toEqual([
        [v.body.id, 0],
        [a.body.id, 1],
      ]);
      const other = await tenant();
      const foreign = await upload(other, png(), 'f.png', 'image/png').expect(201);
      await request(http).put(`/api/v1/products/${p.body.id}/media`).set(as(t)).send({ mediaIds: [foreign.body.id] }).expect(400);
      await request(http).put(`/api/v1/products/${p.body.id}/media`).set(as(t)).send({ mediaIds: [a.body.id, a.body.id] }).expect(400);
    });
  });

  // ─── Services ────────────────────────────────────────────────────────────────
  describe('services', () => {
    it('full CRUD with booking and availability information', async () => {
      const t = await tenant({ type: 'SERVICE_PROVIDER', currency: 'EUR' });
      const cats = await request(http).get('/api/v1/service-categories').set(as(t));
      const created = await request(http)
        .post('/api/v1/services')
        .set(as(t))
        .send({
          name: 'AC installation',
          price: '250.00',
          durationMinutes: 120,
          categoryId: cats.body.find((c: { slug: string }) => c.slug === 'installation').id,
          availability: 'BY_APPOINTMENT',
          availabilityNotes: 'Mon–Fri 8:00–17:00',
          bookingInfo: 'Call +33 1 23 45 67 89',
          bookingUrl: 'https://book.example/ac',
          status: 'ACTIVE',
        })
        .expect(201);
      expect(created.body).toMatchObject({ price: '250.00', currency: 'EUR', durationMinutes: 120, category: { name: 'Installation' } });
      await request(http).post('/api/v1/services').set(as(t)).send({ name: 'X', durationMinutes: 0 }).expect(400);
      await request(http).post('/api/v1/services').set(as(t)).send({ name: 'X', bookingUrl: 'ftp://x' }).expect(400);

      const upd = await request(http).patch(`/api/v1/services/${created.body.id}`).set(as(t)).send({ price: null, bookingUrl: '' }).expect(200);
      expect(upd.body).toMatchObject({ price: null, bookingUrl: null });
      const list = await request(http).get('/api/v1/services').query({ q: 'install', availability: 'BY_APPOINTMENT' }).set(as(t)).expect(200);
      expect(list.body.total).toBe(1);
      await request(http).delete(`/api/v1/services/${created.body.id}`).set(as(t)).expect(204);
      const after = await request(http).get('/api/v1/services').set(as(t)).expect(200);
      expect(after.body.total).toBe(0);
    });
  });

  // ─── Categories ──────────────────────────────────────────────────────────────
  describe('categories', () => {
    it('custom categories, duplicate names, rename, delete keeps items, restore defaults idempotently', async () => {
      const t = await tenant();
      const c = await request(http).post('/api/v1/product-categories').set(as(t)).send({ name: 'Chef specials' }).expect(201);
      expect(c.body).toMatchObject({ slug: 'chef-specials', isDefault: false, kind: 'PRODUCT' });
      await request(http).post('/api/v1/product-categories').set(as(t)).send({ name: 'chef SPECIALS' }).expect(409);
      // Same name is allowed for the other kind.
      await request(http).post('/api/v1/service-categories').set(as(t)).send({ name: 'Chef specials' }).expect(201);

      const p = await request(http).post('/api/v1/products').set(as(t)).send({ name: 'Thieboudienne', categoryId: c.body.id }).expect(201);
      // A product category cannot be used for a service.
      await request(http).post('/api/v1/services').set(as(t)).send({ name: 'S', categoryId: c.body.id }).expect(400);

      const renamed = await request(http).patch(`/api/v1/product-categories/${c.body.id}`).set(as(t)).send({ name: 'Signature dishes' }).expect(200);
      expect(renamed.body.slug).toBe('signature-dishes');
      const listed = await request(http).get('/api/v1/product-categories').set(as(t));
      expect(listed.body.find((x: { id: string }) => x.id === c.body.id).itemCount).toBe(1);

      await request(http).delete(`/api/v1/product-categories/${c.body.id}`).set(as(t)).expect(204);
      const prod = await request(http).get(`/api/v1/products/${p.body.id}`).set(as(t)).expect(200);
      expect(prod.body.category).toBeNull();

      const defaults = (await request(http).get('/api/v1/product-categories').set(as(t))).body.filter((x: { isDefault: boolean }) => x.isDefault);
      await request(http).delete(`/api/v1/product-categories/${defaults[0].id}`).set(as(t)).expect(204);
      const restored = await request(http).post('/api/v1/product-categories/restore-defaults').set(as(t)).expect(201);
      expect(restored.body.created).toBe(1);
      const again = await request(http).post('/api/v1/product-categories/restore-defaults').set(as(t)).expect(201);
      expect(again.body.created).toBe(0);
    });
  });

  // ─── Media library ──────────────────────────────────────────────────────────
  describe('media uploads', () => {
    let t: Ctx;
    beforeAll(async () => {
      t = await tenant();
    });

    it('accepts a valid image, records metadata and stores it under the tenant prefix', async () => {
      const buf = png(32, 16);
      const res = await upload(t, buf, '../../evil/Photo 1.png', 'image/png', { folder: ' products / summer ', altText: 'Red shoes' }).expect(201);
      expect(res.body).toMatchObject({
        type: 'IMAGE',
        status: 'READY',
        mimeType: 'image/png',
        width: 32,
        height: 16,
        originalFilename: 'Photo 1.png',
        folder: 'products/summer',
        altText: 'Red shoes',
      });
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.storageKey.startsWith(`businesses/${t.businessId}/media/`)).toBe(true);
      expect(row.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(res.body)).not.toMatch(/storageKey|S3_|secret/i);

      const content = await request(http).get(res.body.url).expect(200);
      // Images are re-encoded: the stored bytes are produced by our encoder, not the uploader.
      expect((content.body as Buffer).length).toBe(res.body.sizeBytes);
      expect(createHash('sha256').update(content.body as Buffer).digest('hex')).toBe(row.checksumSha256);
      expect((content.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
      const thumb = await request(http).get(res.body.thumbnailUrl).expect(200);
      expect(thumb.headers['content-type']).toBe('image/webp');
      expect(content.headers).toMatchObject({
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      expect(content.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    });

    it.each([
      ['SVG disguised as PNG', svg, 'x.png', 'image/png', 415],
      ['HTML disguised as JPEG', html, 'x.jpg', 'image/jpeg', 415],
      ['PNG declared as JPEG', png(), 'x.jpg', 'image/jpeg', 415],
      ['empty file', Buffer.alloc(0), 'x.png', 'image/png', 415],
      ['image over the limit', png(4, 4, 1.2 * 1024 * 1024), 'big.png', 'image/png', 413],
      ['video over the limit', mp4(2.5 * 1024 * 1024), 'big.mp4', 'video/mp4', 413],
    ])('rejects %s', async (_label, buf, name, type, status) => {
      const before = await prisma.mediaAsset.count({ where: { businessId: t.businessId } });
      const res = await upload(t, buf as Buffer, name as string, type as string).expect(status as number);
      expect(res.body.code).toEqual(expect.any(String));
      expect(await prisma.mediaAsset.count({ where: { businessId: t.businessId } })).toBe(before);
    });

    it('rejects non-multipart and file-less requests', async () => {
      await request(http).post('/api/v1/media').set(as(t)).send({ file: 'x' }).expect(400);
      await request(http).post('/api/v1/media').set(as(t)).field('folder', 'a').expect(400);
    });

    it('rejects tampered or expired signed URLs', async () => {
      const res = await upload(t, png(), 'a.png', 'image/png').expect(201);
      const url = new URL(res.body.url, 'http://x');
      await request(http).get(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=AAAA`).expect(404);
      await request(http).get(`${url.pathname}?exp=1000&sig=${url.searchParams.get('sig')}`).expect(404);
      await request(http).get(url.pathname).expect(404);
    });

    it('supports Range requests for video playback', async () => {
      const res = await upload(t, mp4(10_000), 'clip.mp4', 'video/mp4').expect(201);
      const part = await request(http).get(res.body.url).set('Range', 'bytes=0-99').expect(206);
      expect(part.headers['content-range']).toBe('bytes 0-99/10000');
      expect((part.body as Buffer).length).toBe(100);
    });

    it('lists with type/folder/search filters, edits metadata, lists folders', async () => {
      const s = await tenant();
      const a = await upload(s, png(), 'shoes.png', 'image/png', { folder: 'products' }).expect(201);
      await upload(s, png(), 'banner.png', 'image/png').expect(201);
      await upload(s, mp4(), 'promo.mp4', 'video/mp4', { folder: 'ads' }).expect(201);
      const imgs = await request(http).get('/api/v1/media').query({ type: 'IMAGE' }).set(as(s)).expect(200);
      expect(imgs.body.total).toBe(2);
      const folder = await request(http).get('/api/v1/media').query({ folder: 'products' }).set(as(s)).expect(200);
      expect(folder.body.items.map((m: { id: string }) => m.id)).toEqual([a.body.id]);
      const root = await request(http).get('/api/v1/media').query({ folder: '' }).set(as(s)).expect(200);
      expect(root.body.total).toBe(1);
      const search = await request(http).get('/api/v1/media').query({ q: 'PROMO' }).set(as(s)).expect(200);
      expect(search.body.total).toBe(1);

      const upd = await request(http).patch(`/api/v1/media/${a.body.id}`).set(as(s)).send({ folder: 'catalog/2026', tags: ['Shoes', ' red '], altText: '' }).expect(200);
      expect(upd.body).toMatchObject({ folder: 'catalog/2026', tags: ['shoes', 'red'], altText: null });
      await request(http).patch(`/api/v1/media/${a.body.id}`).set(as(s)).send({ folder: '../etc' }).expect(400);
      const folders = await request(http).get('/api/v1/media/folders').set(as(s)).expect(200);
      expect(folders.body).toEqual(expect.arrayContaining([{ folder: 'catalog/2026', count: 1 }, { folder: 'ads', count: 1 }]));
    });

    it('deleting media detaches it from products and the logo and stops serving it', async () => {
      const s = await tenant();
      const m = await upload(s, png(), 'logo.png', 'image/png').expect(201);
      const p = await request(http).post('/api/v1/products').set(as(s)).send({ name: 'P' }).expect(201);
      await request(http).put(`/api/v1/products/${p.body.id}/media`).set(as(s)).send({ mediaIds: [m.body.id] }).expect(200);
      await request(http).patch(`/api/v1/businesses/${s.businessId}`).set(as(s)).send({ logoMediaId: m.body.id }).expect(200);
      const usage = await request(http).get(`/api/v1/media/${m.body.id}`).set(as(s)).expect(200);
      expect(usage.body.usage).toEqual({ products: [{ id: p.body.id, name: 'P' }], businessLogo: true });

      await request(http).delete(`/api/v1/media/${m.body.id}`).set(as(s)).expect(204);
      await request(http).get(m.body.url).expect(404);
      expect((await request(http).get(`/api/v1/products/${p.body.id}`).set(as(s))).body.media).toEqual([]);
      expect((await request(http).get(`/api/v1/businesses/${s.businessId}`).set(as(s))).body.logoUrl).toBeNull();
    });
  });

  // ─── Knowledge base ─────────────────────────────────────────────────────────
  describe('business knowledge', () => {
    it('verification workflow: editors write, admins verify, edits reset verification', async () => {
      const owner = await tenant();
      const editor = await member(owner, 'EDITOR');
      const admin = await member(owner, 'ADMIN');
      const e = await request(http)
        .post('/api/v1/business-knowledge')
        .set(as(editor))
        .send({ category: 'DELIVERY_POLICY', title: 'Delivery area', body: "We deliver in N'Djamena only, 11:00–20:00." })
        .expect(201);
      expect(e.body.verified).toBe(false);
      await request(http).post(`/api/v1/business-knowledge/${e.body.id}/verify`).set(as(editor)).expect(403);
      const v = await request(http).post(`/api/v1/business-knowledge/${e.body.id}/verify`).set(as(admin)).expect(200);
      expect(v.body).toMatchObject({ verified: true, verifiedBy: { fullName: 'Test User' } });
      const edited = await request(http).patch(`/api/v1/business-knowledge/${e.body.id}`).set(as(editor)).send({ body: 'We deliver everywhere for free.' }).expect(200);
      expect(edited.body).toMatchObject({ verified: false, verifiedAt: null });
      await request(http).post('/api/v1/business-knowledge').set(as(editor)).send({ category: 'GOSSIP', title: 'x', body: 'yy' }).expect(400);
      const summary = await request(http).get('/api/v1/business-knowledge/summary').set(as(owner)).expect(200);
      expect(summary.body.find((s: { category: string }) => s.category === 'DELIVERY_POLICY')).toEqual({ category: 'DELIVERY_POLICY', verified: 0, unverified: 1 });
    });

    it('AI context contains only this business, only verified facts and active items, and lists gaps', async () => {
      const a = await tenant({ name: 'Tenant A' });
      const b = await tenant({ name: 'Tenant B' });
      const mk = (c: Ctx, body: object) => request(http).post('/api/v1/business-knowledge').set(as(c)).send(body).expect(201);
      const ok = await mk(a, { category: 'RETURN_POLICY', title: 'Returns', body: 'Returns accepted within 7 days with receipt.' });
      await request(http).post(`/api/v1/business-knowledge/${ok.body.id}/verify`).set(as(a)).expect(200);
      await mk(a, { category: 'FAQ', title: 'Unverified claim', body: 'Free delivery always.' });
      await mk(b, { category: 'COMPANY', title: 'B secret', body: 'Tenant B internal info.' }).then((r) =>
        request(http).post(`/api/v1/business-knowledge/${r.body.id}/verify`).set(as(b)).expect(200),
      );
      await request(http).post('/api/v1/products').set(as(a)).send({ name: 'Active juice', price: '1000', status: 'ACTIVE' }).expect(201);
      await request(http).post('/api/v1/products').set(as(a)).send({ name: 'No price item', status: 'ACTIVE' }).expect(201);
      await request(http).post('/api/v1/products').set(as(a)).send({ name: 'Draft secret', price: '1', status: 'DRAFT' }).expect(201);
      await request(http).post('/api/v1/products').set(as(b)).send({ name: 'B product', price: '5', status: 'ACTIVE' }).expect(201);

      const ctx = await request(http).get('/api/v1/business-knowledge/context').set(as(a)).expect(200);
      const text = JSON.stringify(ctx.body);
      expect(ctx.body.businessId).toBe(a.businessId);
      expect(ctx.body.business.name).toBe('Tenant A');
      expect(ctx.body.knowledge.map((k: { title: string }) => k.title)).toEqual(['Returns']);
      expect(ctx.body.products.map((p: { name: string }) => p.name)).toEqual(['Active juice', 'No price item']);
      expect(ctx.body.products[0]).toMatchObject({ price: '1000.00', stock: 'not tracked' });
      expect(ctx.body.missingInformation).toEqual(
        expect.arrayContaining(['No verified delivery policy information', 'Price not set for product "No price item"']),
      );
      expect(ctx.body.missingInformation).not.toContain('No verified return policy information');
      for (const leak of ['Tenant B', 'B secret', 'B product', 'Draft secret', 'Unverified claim']) expect(text).not.toContain(leak);
    });
  });

  // ─── Authorization & tenant isolation ───────────────────────────────────────
  describe('authorization and tenant isolation', () => {
    it('requires authentication and the X-Business-Id header', async () => {
      const t = await tenant();
      for (const path of ['/api/v1/products', '/api/v1/services', '/api/v1/product-categories', '/api/v1/service-categories', '/api/v1/media', '/api/v1/business-knowledge']) {
        await request(http).get(path).set('X-Business-Id', t.businessId).expect(401);
        await request(http).get(path).set('Authorization', `Bearer ${t.token}`).expect(404);
      }
    });

    it('viewers can read but not write', async () => {
      const owner = await tenant();
      const viewer = await member(owner, 'VIEWER');
      await request(http).get('/api/v1/products').set(as(viewer)).expect(200);
      await request(http).get('/api/v1/media').set(as(viewer)).expect(200);
      await request(http).get('/api/v1/business-knowledge').set(as(viewer)).expect(200);
      await request(http).post('/api/v1/products').set(as(viewer)).send({ name: 'x' }).expect(403);
      await request(http).post('/api/v1/services').set(as(viewer)).send({ name: 'x' }).expect(403);
      await request(http).post('/api/v1/product-categories').set(as(viewer)).send({ name: 'x' }).expect(403);
      await upload(viewer, png(), 'a.png', 'image/png').expect(403);
      await request(http).post('/api/v1/business-knowledge').set(as(viewer)).send({ category: 'FAQ', title: 'xx', body: 'yy' }).expect(403);
      const editor = await member(owner, 'EDITOR');
      await request(http).post('/api/v1/products').set(as(editor)).send({ name: 'ok' }).expect(201);
      await upload(editor, png(), 'a.png', 'image/png').expect(201);
    });

    it('a member of business A cannot reach business B resources by id, header or reference', async () => {
      const a = await tenant();
      const b = await tenant();
      const prodB = await request(http).post('/api/v1/products').set(as(b)).send({ name: 'B only', price: '5' }).expect(201);
      const svcB = await request(http).post('/api/v1/services').set(as(b)).send({ name: 'B svc' }).expect(201);
      const catB = (await request(http).get('/api/v1/product-categories').set(as(b))).body[0];
      const mediaB = await upload(b, png(), 'b.png', 'image/png').expect(201);
      const kB = await request(http).post('/api/v1/business-knowledge').set(as(b)).send({ category: 'FAQ', title: 'B faq', body: 'B answer' }).expect(201);

      // 1. A's token with B's header → not a member → 404.
      const spoof = { Authorization: `Bearer ${a.token}`, 'X-Business-Id': b.businessId };
      await request(http).get('/api/v1/products').set(spoof).expect(404);
      await request(http).get(`/api/v1/products/${prodB.body.id}`).set(spoof).expect(404);
      await request(http).post('/api/v1/media').set(spoof).attach('file', png(), { filename: 'x.png', contentType: 'image/png' }).expect(404);

      // 2. A's own tenant scope with B's ids → 404 on every resource type.
      await request(http).get(`/api/v1/products/${prodB.body.id}`).set(as(a)).expect(404);
      await request(http).patch(`/api/v1/products/${prodB.body.id}`).set(as(a)).send({ name: 'hacked' }).expect(404);
      await request(http).delete(`/api/v1/products/${prodB.body.id}`).set(as(a)).expect(404);
      await request(http).put(`/api/v1/products/${prodB.body.id}/media`).set(as(a)).send({ mediaIds: [] }).expect(404);
      await request(http).get(`/api/v1/services/${svcB.body.id}`).set(as(a)).expect(404);
      await request(http).patch(`/api/v1/services/${svcB.body.id}`).set(as(a)).send({ name: 'x' }).expect(404);
      await request(http).patch(`/api/v1/product-categories/${catB.id}`).set(as(a)).send({ name: 'x' }).expect(404);
      await request(http).delete(`/api/v1/product-categories/${catB.id}`).set(as(a)).expect(404);
      await request(http).get(`/api/v1/media/${mediaB.body.id}`).set(as(a)).expect(404);
      await request(http).patch(`/api/v1/media/${mediaB.body.id}`).set(as(a)).send({ folder: 'x' }).expect(404);
      await request(http).delete(`/api/v1/media/${mediaB.body.id}`).set(as(a)).expect(404);
      await request(http).get(`/api/v1/business-knowledge/${kB.body.id}`).set(as(a)).expect(404);
      await request(http).post(`/api/v1/business-knowledge/${kB.body.id}/verify`).set(as(a)).expect(404);

      // 3. References to B's objects inside A's payloads are refused.
      await request(http).post('/api/v1/products').set(as(a)).send({ name: 'x', categoryId: catB.id }).expect(400);
      await request(http).patch(`/api/v1/businesses/${a.businessId}`).set(as(a)).send({ logoMediaId: mediaB.body.id }).expect(400);

      // 4. Lists never include B's data.
      const listA = await request(http).get('/api/v1/products').set(as(a)).expect(200);
      expect(JSON.stringify(listA.body)).not.toContain('B only');

      // Nothing of B was changed.
      expect((await prisma.product.findUniqueOrThrow({ where: { id: prodB.body.id } })).name).toBe('B only');
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaB.body.id } })).deletedAt).toBeNull();
    });

    it('writes audit entries for catalog and media changes', async () => {
      const t = await tenant();
      await request(http).post('/api/v1/products').set(as(t)).send({ name: 'Audited' }).expect(201);
      await upload(t, svg, 'x.png', 'image/png').expect(415);
      const actions = (await prisma.auditLog.findMany({ where: { businessId: t.businessId }, select: { action: true } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['business.create', 'product.create', 'media.upload_rejected']));
    });
  });
});
