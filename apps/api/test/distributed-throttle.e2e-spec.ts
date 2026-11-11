import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Two API instances sharing one Redis must enforce ONE combined limit. */
describe('Distributed rate limiting (Redis)', () => {
  let a: INestApplication;
  let b: INestApplication;
  const saved = process.env.AUTH_THROTTLE_LIMIT;

  beforeAll(async () => {
    process.env.AUTH_THROTTLE_LIMIT = '4';
    process.env.RATE_LIMIT_STORE = 'redis';
    jest.resetModules();
    const h1 = await import('./helpers');
    a = await h1.startApp();
    jest.resetModules();
    const h2 = await import('./helpers');
    b = await h2.startApp();
    await h1.prisma.$disconnect();
    await h2.prisma.$disconnect();
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('touma:rl:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  afterAll(async () => {
    process.env.AUTH_THROTTLE_LIMIT = saved;
    await a.close();
    await b.close();
  });

  it('requests spread across instances share one counter', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const app = i % 2 === 0 ? a : b;
      const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'Whatever-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.slice(4)).toEqual([429, 429]);
  });

  it('a blocked client stays blocked on every instance and gets Retry-After', async () => {
    const res = await request(b.getHttpServer()).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'Whatever-123' }).expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
