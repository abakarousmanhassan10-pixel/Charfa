import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';

/**
 * Full API media path against REAL S3-compatible storage (AWS S3, Cloudflare R2 or MinIO).
 * Opt-in: REAL_STORAGE=1 plus S3_PROVIDER, S3_ENDPOINT (R2/MinIO), S3_REGION, S3_BUCKET,
 * S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY in the environment.
 *   pnpm --filter @touma/api test:real-storage
 * Without REAL_STORAGE=1 the suite is skipped and reported as NOT RUN, never as passed.
 */
const enabled = process.env.REAL_STORAGE === '1';
const d = enabled ? describe : describe.skip;

d('Real S3-compatible storage (e2e, no mocks)', () => {
  let app: INestApplication;
  let helpers: typeof import('./helpers');

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 's3';
    for (const k of ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (!process.env[k]) throw new Error(`${k} is required for the real storage suite`);
    }
    jest.resetModules();
    helpers = await import('./helpers');
    app = await helpers.startApp();
  });
  afterAll(async () => {
    await app?.close();
    await helpers?.prisma.$disconnect();
  });

  it('readiness reports storage as verified only after a real round trip', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(res.body.dependencies.storage.state).toBe('verified');
    expect(res.body.dependencies.storage.steps.map((s: { step: string; ok: boolean }) => `${s.step}:${s.ok}`)).toEqual([
      'upload:true', 'head:true', 'download:true', 'presigned-download:true', 'delete:true', 'deleted-check:true',
    ]);
  });

  it('upload → signed download → thumbnail → delete, through the real bucket', async () => {
    const http = app.getHttpServer();
    const u = await helpers.register(app);
    const b = await request(http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Real Storage', type: 'OTHER' }).expect(201);
    const h = { Authorization: `Bearer ${u.accessToken}`, 'X-Business-Id': b.body.id };
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#2a6' } }).jpeg().toBuffer();
    const up = await request(http).post('/api/v1/media').set(h).attach('file', img, { filename: 'real.jpg', contentType: 'image/jpeg' }).expect(201);
    const original = await request(http).get(up.body.url).expect(200);
    expect((await sharp(original.body as Buffer).metadata()).width).toBe(640);
    const range = await request(http).get(up.body.url).set('Range', 'bytes=0-9').expect(206);
    expect((range.body as Buffer).length).toBe(10);
    await request(http).get(up.body.thumbnailUrl).expect(200);
    await request(http).delete(`/api/v1/media/${up.body.id}`).set(h).expect(204);
    await request(http).get(up.body.url).expect(404);
    const pending = await helpers.prisma.storageDeletion.count({ where: { businessId: b.body.id, completedAt: null } });
    expect(pending).toBe(0); // deleted from the real bucket immediately
  });
});
