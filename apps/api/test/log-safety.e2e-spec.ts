import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SalesPublicService } from '../src/sales/sales-public.service';
import { aiHelpers, as } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';

/**
 * Phase N7 fix: a 5xx used to log the full URL, query string included. Query values are secrets in this API (the customer's
 * chat token, OAuth codes), so server logs must keep only parameter names. Also: the request id is never echoed unchecked.
 */
describe('Log safety on server errors (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function shop(label: string) {
    const h = aiHelpers(app);
    const t = await h.tenant(label);
    const admin = await h.member({ token: t.token, businessId: t.businessId }, 'ADMIN');
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
    await request(http).put('/api/v1/sales/agent').set(as(admin)).send({ enabled: true, replyMode: 'AUTO', languages: ['en'], defaultLanguage: 'en' }).expect(200);
    const first = await request(http).post(`/api/v1/public/chat/${slug}/messages`).send({ message: 'Hello' }).expect(200);
    return { slug, token: first.body.token as string };
  }
  const logged = (spy: jest.SpyInstance) => JSON.stringify(spy.mock.calls);

  it('never writes a query-string secret to the error log, and the client sees no internals', async () => {
    const s = await shop('Log shop');
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(SalesPublicService.prototype, 'poll').mockRejectedValue(new Error('database exploded'));
    const res = await request(http).get(`/api/v1/public/chat/${s.slug}/messages`).query({ token: s.token });
    expect(res.status).toBe(500);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message', 'requestId', 'statusCode']);
    expect(JSON.stringify(res.body)).not.toMatch(/exploded|stack/);
    const log = logged(err);
    expect(log).toContain('/messages?token=[redacted]'); // still useful: the route and the parameter name
    expect(log).toContain('database exploded'); // the real cause stays in the server log
    expect(log).not.toContain(s.token);
    expect(log).toContain(res.body.requestId);
  });

  it('does not echo an unchecked request id (forged or oversized), but keeps a clean one', async () => {
    const a = await request(http).get('/api/v1/definitely-missing').set('x-request-id', 'x'.repeat(300)).expect(404);
    expect(a.body.requestId).not.toContain('xxxx');
    expect(a.headers['x-request-id']).toBe(a.body.requestId);
    const b = await request(http).get('/api/v1/definitely-missing').set('x-request-id', 'trace-abc_123').expect(404);
    expect(b.body.requestId).toBe('trace-abc_123');
  });

  it('keeps working normally: a valid token reads the chat, another shop\'s token is refused and logs no error, and service recovers after a failure', async () => {
    const a = await shop('Shop A');
    const b = await shop('Shop B');
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await request(http).get(`/api/v1/public/chat/${a.slug}/messages`).query({ token: a.token }).expect(200);
    await request(http).get(`/api/v1/public/chat/${b.slug}/messages`).query({ token: a.token }).expect(404); // cross-tenant token
    expect(err).not.toHaveBeenCalled(); // client errors are not logged as server errors
    const spy = jest.spyOn(SalesPublicService.prototype, 'poll').mockRejectedValueOnce(new Error('temporary'));
    await request(http).get(`/api/v1/public/chat/${a.slug}/messages`).query({ token: a.token }).expect(500);
    expect(logged(err)).not.toContain(a.token);
    spy.mockRestore();
    await request(http).get(`/api/v1/public/chat/${a.slug}/messages`).query({ token: a.token }).expect(200); // recovered
  });
});
