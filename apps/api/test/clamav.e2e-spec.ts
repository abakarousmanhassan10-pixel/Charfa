import type { INestApplication } from '@nestjs/common';
import { connect } from 'net';
import request from 'supertest';
import type { MemoryObjectStorage } from '@touma/storage';
import { png } from './fixtures';

/**
 * Malware scanning against a REAL clamd (ClamAV 1.x) loaded with the EICAR test signatures
 * (infrastructure/clamav/start-test-clamd.sh). The suite fails if clamd is not running, so it can
 * never pass silently without a scanner.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVI' + 'RUS-TEST-FILE!$H+H*';

function clamdUp(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = connect({ host: '127.0.0.1', port }, () => s.end('zPING\0'));
    s.on('data', (d) => resolve(d.toString().startsWith('PONG')));
    s.on('error', () => resolve(false));
  });
}

async function appWith(env: Record<string, string>) {
  Object.assign(process.env, env);
  jest.resetModules();
  const helpers = await import('./helpers');
  // Same module registry as the app, so DI tokens (symbols) match.
  const storageModule = await import('@touma/storage');
  return { app: await helpers.startApp(), helpers, storageModule };
}

describe('Malware scanning with real ClamAV (e2e)', () => {
  let app: INestApplication;
  let helpers: typeof import('./helpers');
  let storageModule: typeof import('@touma/storage');
  const saved = { MALWARE_SCANNER: process.env.MALWARE_SCANNER, CLAMAV_PORT: process.env.CLAMAV_PORT };

  beforeAll(async () => {
    if (!(await clamdUp(3310))) throw new Error('clamd is not running on 127.0.0.1:3310 — run infrastructure/clamav/start-test-clamd.sh');
    ({ app, helpers, storageModule } = await appWith({ MALWARE_SCANNER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '3310' }));
  });
  afterAll(async () => {
    await app.close();
    await helpers.prisma.$disconnect();
    Object.assign(process.env, saved);
  });

  async function tenant(a: INestApplication) {
    const u = await helpers.register(a);
    const b = await request(a.getHttpServer()).post('/api/v1/businesses').set('Authorization', `Bearer ${u.accessToken}`).send({ name: 'Scan Shop', type: 'OTHER' }).expect(201);
    return { Authorization: `Bearer ${u.accessToken}`, 'X-Business-Id': b.body.id as string };
  }

  it('clean files are scanned and marked CLEAN', async () => {
    const h = await tenant(app);
    const res = await request(app.getHttpServer()).post('/api/v1/media').set(h).attach('file', png(12, 12), { filename: 'ok.png', contentType: 'image/png' }).expect(201);
    expect(res.body.scanStatus).toBe('CLEAN');
    const row = await helpers.prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ scanEngine: 'clamav', scanStatus: 'CLEAN' });
    expect(row.scannedAt).toBeInstanceOf(Date);
  });

  it('an image carrying a malicious payload is rejected and nothing is stored', async () => {
    const h = await tenant(app);
    const storage = app.get(storageModule.OBJECT_STORAGE) as MemoryObjectStorage;
    const before = storage.objects.size;
    const infected = Buffer.concat([png(12, 12), Buffer.from(EICAR)]);
    const res = await request(app.getHttpServer()).post('/api/v1/media').set(h).attach('file', infected, { filename: 'cat.png', contentType: 'image/png' }).expect(422);
    expect(res.body.code).toBe('MALWARE_DETECTED');
    expect(storage.objects.size).toBe(before);
    expect(await helpers.prisma.mediaAsset.count({ where: { businessId: h['X-Business-Id'] } })).toBe(0);
    const audit = await helpers.prisma.auditLog.findFirst({ where: { businessId: h['X-Business-Id'], action: 'media.upload_rejected' } });
    expect(audit?.metadata).toMatchObject({ reason: 'MALWARE_DETECTED', signature: expect.stringContaining('EICAR') });
  });

  it('fails closed when the scanner is unreachable', async () => {
    const other = await appWith({ MALWARE_SCANNER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '3999' });
    try {
      const h = await tenant(other.app);
      const res = await request(other.app.getHttpServer()).post('/api/v1/media').set(h).attach('file', png(12, 12), { filename: 'ok.png', contentType: 'image/png' }).expect(503);
      expect(res.body.code).toBe('SCAN_UNAVAILABLE');
      const ready = await request(other.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(ready.body.dependencies.malwareScanner).toBe('down');
    } finally {
      await other.app.close();
      await other.helpers.prisma.$disconnect();
    }
  });
});
