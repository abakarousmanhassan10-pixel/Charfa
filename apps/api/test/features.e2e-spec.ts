import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { register, resetDb, startApp, prisma } from './helpers';

describe('Feature visibility (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    await resetDb();
    app = await startApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('requires a session and returns booleans only, reflecting the deployment flags', async () => {
    await request(app.getHttpServer()).get('/api/v1/features').expect(401);
    const u = await register(app);
    const res = await request(app.getHttpServer()).get('/api/v1/features').set('Authorization', `Bearer ${u.accessToken}`).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['ai', 'campaigns', 'market', 'media', 'salesAssist', 'workflows']);
    expect(Object.values(res.body).every((v) => typeof v === 'boolean')).toBe(true);
    expect(res.body).toMatchObject({ workflows: true, market: true, salesAssist: true, campaigns: true }); // enabled in the test environment
    expect(JSON.stringify(res.body)).not.toMatch(/key|secret|url|host/i);
  });
});
