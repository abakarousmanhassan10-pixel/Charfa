import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { S3ObjectStorage, StorageError, type S3Provider } from '@touma/storage';

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

  const cfg = () => ({
    provider: (process.env.S3_PROVIDER ?? 'minio') as S3Provider,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });
  /** A separate client, independent of the API process, to inspect the bucket itself. */
  const inspector = () => new S3ObjectStorage(cfg());
  /** Direct, unauthenticated URL of an object in the bucket. */
  const directUrl = (key: string) => {
    const c = cfg();
    return c.endpoint ? `${c.endpoint.replace(/\/$/, '')}/${c.bucket}/${key}` : `https://${c.bucket}.s3.${c.region}.amazonaws.com/${key}`;
  };
  const jpeg = (color: string) => sharp({ create: { width: 320, height: 240, channels: 3, background: color } }).jpeg().toBuffer();
  async function owner(name: string) {
    const http = app.getHttpServer();
    const u = await helpers.register(app);
    const b = await request(http).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name, type: 'OTHER' }).expect(201);
    return { user: u, businessId: b.body.id as string, h: { Authorization: `Bearer ${u.accessToken}`, 'X-Business-Id': b.body.id as string } };
  }

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

  it('objects really live in the bucket, under the tenant prefix, and are private', async () => {
    const http = app.getHttpServer();
    const a = await owner('Bucket Proof');
    const up = await request(http).post('/api/v1/media').set(a.h).attach('file', await jpeg('#a33'), { filename: 'p.jpg', contentType: 'image/jpeg' }).expect(201);
    const row = await helpers.prisma.mediaAsset.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row.storageKey.startsWith(`businesses/${a.businessId}/media/`)).toBe(true);
    expect(row.thumbnailKey?.startsWith(`businesses/${a.businessId}/media/thumbs/`)).toBe(true);
    // Seen by an independent client: the bytes in the bucket are what the API serves.
    const s3 = inspector();
    const head = await s3.head(row.storageKey);
    expect(head?.size).toBe(Number(row.sizeBytes));
    const served = await request(http).get(up.body.url).expect(200);
    const stored = await s3.get(row.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stored.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(served.body as Buffer)).toBe(true);
    // The bucket is not publicly readable: an unauthenticated direct request is refused.
    const anon = await fetch(directUrl(row.storageKey));
    expect(anon.ok).toBe(false);
    expect([400, 401, 403]).toContain(anon.status);
    // No response exposes the storage key, bucket or credentials.
    const detail = await request(http).get(`/api/v1/media/${up.body.id}`).set(a.h).expect(200);
    const text = JSON.stringify(detail.body) + JSON.stringify(up.body);
    expect(text).not.toContain(row.storageKey);
    expect(text).not.toContain(process.env.S3_ACCESS_KEY_ID!);
    expect(text).not.toContain(process.env.S3_SECRET_ACCESS_KEY!);
    expect(text).not.toContain(process.env.S3_BUCKET!);
    await request(http).delete(`/api/v1/media/${up.body.id}`).set(a.h).expect(204);
    expect(await s3.head(row.storageKey)).toBeNull();
    expect(await s3.head(row.thumbnailKey!)).toBeNull();
  });

  it('tenant isolation and role permissions hold for real stored files', async () => {
    const http = app.getHttpServer();
    const a = await owner('Tenant A');
    const b = await owner('Tenant B');
    const upA = await request(http).post('/api/v1/media').set(a.h).attach('file', await jpeg('#3a3'), { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(201);
    const upB = await request(http).post('/api/v1/media').set(b.h).attach('file', await jpeg('#33a'), { filename: 'b.jpg', contentType: 'image/jpeg' }).expect(201);
    const rowA = await helpers.prisma.mediaAsset.findUniqueOrThrow({ where: { id: upA.body.id } });

    // B cannot read, list, edit or delete A's media, with its own scope or by claiming A's tenant.
    await request(http).get(`/api/v1/media/${upA.body.id}`).set(b.h).expect(404);
    await request(http).patch(`/api/v1/media/${upA.body.id}`).set(b.h).send({ altText: 'x' }).expect(404);
    await request(http).delete(`/api/v1/media/${upA.body.id}`).set(b.h).expect(404);
    const listB = await request(http).get('/api/v1/media').set(b.h).expect(200);
    expect(listB.body.items.map((m: { id: string }) => m.id)).toEqual([upB.body.id]);
    await request(http).get('/api/v1/media').set({ ...b.h, 'X-Business-Id': a.businessId }).expect(404);
    await request(http).post('/api/v1/media').set({ ...b.h, 'X-Business-Id': a.businessId }).attach('file', await jpeg('#000'), { filename: 'x.jpg', contentType: 'image/jpeg' }).expect(404);
    // A signature for B's file does not open A's file.
    const sigB = new URL(upB.body.url, 'http://x');
    await request(http).get(`/api/v1/media/${upA.body.id}/content?${sigB.searchParams.toString()}`).expect(404);
    // A's object is untouched in the bucket after B's attempts.
    expect(await inspector().head(rowA.storageKey)).not.toBeNull();

    // A VIEWER of A can read but not upload or delete.
    const viewer = await helpers.register(app);
    const viewerId = (await helpers.prisma.user.findUniqueOrThrow({ where: { email: viewer.email } })).id;
    await helpers.prisma.membership.create({ data: { userId: viewerId, businessId: a.businessId, role: 'VIEWER', status: 'ACTIVE' } });
    const vh = { Authorization: `Bearer ${viewer.accessToken}`, 'X-Business-Id': a.businessId };
    const seen = await request(http).get(`/api/v1/media/${upA.body.id}`).set(vh).expect(200);
    await request(http).get(seen.body.url).expect(200);
    await request(http).post('/api/v1/media').set(vh).attach('file', await jpeg('#fff'), { filename: 'v.jpg', contentType: 'image/jpeg' }).expect(403);
    await request(http).delete(`/api/v1/media/${upA.body.id}`).set(vh).expect(403);
    expect(await inspector().head(rowA.storageKey)).not.toBeNull();

    // Unauthenticated API access is refused.
    await request(http).get('/api/v1/media').set('X-Business-Id', a.businessId).expect(401);
    await request(http).get(`/api/v1/media/${upA.body.id}/content`).expect(404);

    for (const [id, h] of [[upA.body.id, a.h], [upB.body.id, b.h]] as const) await request(http).delete(`/api/v1/media/${id}`).set(h).expect(204);
  });

  it('storage errors are typed: wrong credentials and a missing bucket', async () => {
    const wrongKey = new S3ObjectStorage({ ...cfg(), secretAccessKey: `${process.env.S3_SECRET_ACCESS_KEY}-wrong` });
    await expect(wrongKey.put('_probe/denied.txt', Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 })).rejects.toMatchObject({ kind: 'access_denied' });
    const missing = new S3ObjectStorage({ ...cfg(), bucket: `touma-missing-${Date.now()}`, autoCreateBucket: false });
    const err = await missing.put('_probe/missing.txt', Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).kind).toBe('bucket_missing');
    // A missing object is a typed not_found, never a crash.
    await expect(inspector().get(`_probe/none-${Date.now()}`)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
