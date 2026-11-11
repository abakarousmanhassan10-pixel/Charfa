import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Rate limits on the creative endpoints. The limit is read when the app starts, so this runs its own app with a low one. */
describe('Creative Studio: rate limits (e2e)', () => {
  let app: INestApplication;
  let helpers: typeof import('./helpers');
  let token: string;
  let businessId: string;

  beforeAll(async () => {
    process.env.CREATIVE_RATE_LIMIT_PER_MINUTE = '3';
    jest.resetModules();
    helpers = await import('./helpers');
    await helpers.resetDb();
    app = await helpers.startApp();
    const u = await helpers.register(app);
    token = u.accessToken;
    businessId = (await request(app.getHttpServer()).post('/api/v1/businesses').set('Authorization', `Bearer ${token}`).send({ name: 'Throttle Cafe', type: 'RESTAURANT', currency: 'XAF' }).expect(201)).body.id;
  });
  afterAll(async () => {
    process.env.CREATIVE_RATE_LIMIT_PER_MINUTE = '1000';
    await app.close();
    await helpers.prisma.$disconnect();
  });

  it('limits generation requests per client, with Retry-After, before any work or cost', async () => {
    const send = (path: string, body: object = {}) => request(app.getHttpServer()).post(`/api/v1/creative/${path}`).set({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId }).send(body);
    // Invalid requests still count: the limit protects the endpoint, not just successful calls.
    for (let i = 0; i < 3; i++) await send('images').expect(400);
    const blocked = await send('images');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // The limit covers all generation endpoints of the client (images, videos, storyboards share the setting; each route has its own counter).
    for (let i = 0; i < 3; i++) await send('videos').expect(400);
    await send('videos').expect(429);
    // Reading is not limited this way.
    await request(app.getHttpServer()).get('/api/v1/creative/status').set({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId }).expect(200);
    expect(await helpers.prisma.creativeGeneration.count({ where: { businessId } })).toBe(0);
  });
});
