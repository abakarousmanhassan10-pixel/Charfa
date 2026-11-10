import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { STRONG_PASSWORD, prisma, refreshCookie, register, resetDb, startApp, uniqueEmail } from './helpers';

describe('Auth (e2e, real database)', () => {
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

  describe('register', () => {
    it('creates an account, sets an httpOnly SameSite=Strict refresh cookie, never returns the hash', async () => {
      const email = uniqueEmail();
      const res = await request(http)
        .post('/api/v1/auth/register')
        .send({ email: email.toUpperCase(), password: STRONG_PASSWORD, fullName: '  Amina  ', locale: 'fr' })
        .expect(201);
      expect(res.body.user).toMatchObject({ email, fullName: 'Amina', locale: 'fr', platformRole: 'USER' });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
      const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toMatch(/touma_rt=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(res.headers['cache-control']).toBe('no-store');

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
      const audit = await prisma.auditLog.findFirst({ where: { actorId: user.id, action: 'auth.register' } });
      expect(audit).not.toBeNull();
    });

    it('rejects duplicate email with 409', async () => {
      const { email } = await register(app);
      const res = await request(http)
        .post('/api/v1/auth/register')
        .send({ email, password: STRONG_PASSWORD, fullName: 'X' })
        .expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it.each([
      [{ email: 'not-an-email', password: STRONG_PASSWORD, fullName: 'X' }],
      [{ email: uniqueEmail(), password: 'short1A', fullName: 'X' }],
      [{ email: uniqueEmail(), password: 'alllowercase1234', fullName: 'X' }],
      [{ email: uniqueEmail(), password: STRONG_PASSWORD, fullName: '' }],
      [{ email: uniqueEmail(), password: STRONG_PASSWORD, fullName: 'X', platformRole: 'SUPER_ADMIN' }],
      [{ email: uniqueEmail(), password: STRONG_PASSWORD, fullName: 'X', locale: 'xx' }],
    ])('validates input %#', async (body) => {
      await request(http).post('/api/v1/auth/register').send(body).expect(400);
    });

    it('cannot escalate to platform admin through mass assignment', async () => {
      const email = uniqueEmail();
      await request(http)
        .post('/api/v1/auth/register')
        .send({ email, password: STRONG_PASSWORD, fullName: 'X', platformRole: 'SUPER_ADMIN' })
        .expect(400);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  });

  describe('login', () => {
    it('logs in with correct credentials', async () => {
      const { email } = await register(app);
      const res = await request(http).post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(refreshCookie(res)).toBeDefined();
    });

    it('returns the same generic error for unknown email and wrong password', async () => {
      const { email } = await register(app);
      const a = await request(http).post('/api/v1/auth/login').send({ email, password: 'Wrong-password-1' }).expect(401);
      const b = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'Wrong-password-1' })
        .expect(401);
      expect(a.body.code).toBe('INVALID_CREDENTIALS');
      expect(b.body.code).toBe('INVALID_CREDENTIALS');
      expect(a.body.message).toBe(b.body.message);
    });

    it('locks the account after 5 failed attempts', async () => {
      const { email } = await register(app);
      for (let i = 0; i < 5; i++) {
        await request(http).post('/api/v1/auth/login').send({ email, password: 'Wrong-password-1' }).expect(401);
      }
      const res = await request(http).post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD }).expect(401);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
    });

    it('rejects suspended users and revokes their live sessions', async () => {
      const { email, accessToken } = await register(app);
      await prisma.user.update({ where: { email }, data: { status: 'SUSPENDED' } });
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      const res = await request(http).post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD }).expect(401);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('protected routes', () => {
    it('requires a bearer token', async () => {
      const res = await request(http).get('/api/v1/auth/me').expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      await request(http).get('/api/v1/users/me').set('Authorization', 'Bearer garbage').expect(401);
    });

    it('returns the current user and memberships', async () => {
      const { accessToken, email } = await register(app);
      const res = await request(http).get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
      expect(res.body).toMatchObject({ email, memberships: [] });
    });

    it('updates profile with validation', async () => {
      const { accessToken } = await register(app);
      await request(http)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ timezone: 'Not/AZone' })
        .expect(400);
      const res = await request(http)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ timezone: 'Africa/Ndjamena', locale: 'fr' })
        .expect(200);
      expect(res.body).toMatchObject({ timezone: 'Africa/Ndjamena', locale: 'fr' });
    });
  });

  describe('refresh & logout', () => {
    it('requires the CSRF header', async () => {
      const { cookie } = await register(app);
      const res = await request(http).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(403);
      expect(res.body.code).toBe('CSRF_REJECTED');
    });

    it('rejects foreign origins', async () => {
      const { cookie } = await register(app);
      await request(http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .set('x-touma-csrf', '1')
        .set('Origin', 'https://evil.example')
        .expect(403);
    });

    it('rotates the refresh token and invalidates the previous access token', async () => {
      const { cookie, accessToken } = await register(app);
      const res = await request(http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .set('x-touma-csrf', '1')
        .expect(200);
      const next = refreshCookie(res)!;
      expect(next).not.toEqual(cookie);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
    });

    it('detects refresh token reuse and revokes the whole session family', async () => {
      const { cookie } = await register(app);
      const first = await request(http).post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-touma-csrf', '1').expect(200);
      const second = refreshCookie(first)!;

      // Simulate an attacker replaying the old token after the grace window.
      await prisma.session.updateMany({
        where: { revokedAt: { not: null }, replacedById: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });
      await request(http).post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-touma-csrf', '1').expect(401);

      // The legitimate holder of the newest token is also logged out.
      await request(http).post('/api/v1/auth/refresh').set('Cookie', second).set('x-touma-csrf', '1').expect(401);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${first.body.accessToken}`).expect(401);
    });

    it('logout revokes the session and clears the cookie', async () => {
      const { cookie, accessToken } = await register(app);
      const res = await request(http).post('/api/v1/auth/logout').set('Cookie', cookie).set('x-touma-csrf', '1').expect(204);
      expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/touma_rt=;/);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      await request(http).post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-touma-csrf', '1').expect(401);
    });

    it('logout-all revokes every session of the user', async () => {
      const { email, accessToken } = await register(app);
      const other = await request(http).post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD }).expect(200);
      await request(http).post('/api/v1/auth/logout-all').set('Authorization', `Bearer ${accessToken}`).expect(204);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${other.body.accessToken}`).expect(401);
    });
  });

  describe('platform', () => {
    it('health endpoints are public; readiness checks database and redis', async () => {
      await request(http).get('/api/v1/health').expect(200);
      const res = await request(http).get('/api/v1/health/ready').expect(200);
      expect(res.body.checks).toEqual({ database: 'up', redis: 'up' });
      expect(JSON.stringify(res.body)).not.toMatch(/secret|key=/i);
    });

    it('sets security headers and a request id; hides x-powered-by', async () => {
      const res = await request(http).get('/api/v1/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('does not leak internals on unknown routes', async () => {
      const res = await request(http).get('/api/v1/does-not-exist').set('Authorization', 'Bearer x');
      expect([401, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|prisma/i);
    });
  });
});
