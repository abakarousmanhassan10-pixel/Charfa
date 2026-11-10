import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;
  const original = process.env.AUTH_THROTTLE_LIMIT;

  beforeAll(async () => {
    process.env.AUTH_THROTTLE_LIMIT = '3';
    jest.resetModules();
    const helpers = await import('./helpers');
    app = await helpers.startApp();
    await helpers.prisma.$disconnect();
  });
  afterAll(async () => {
    process.env.AUTH_THROTTLE_LIMIT = original;
    await app.close();
  });

  it('throttles repeated login attempts with 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'Whatever-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses).toContain(429);
  });
});
