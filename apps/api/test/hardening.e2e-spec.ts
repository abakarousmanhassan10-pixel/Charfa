import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import { MemoryObjectStorage, OBJECT_STORAGE } from '@touma/storage';
import { processPendingDeletions } from '../../worker/src/jobs/storage-cleanup';
import { Mailbox } from './mailbox';
import { png } from './fixtures';
import { STRONG_PASSWORD, prisma, register, resetDb, startApp, uniqueEmail } from './helpers';

/**
 * Phase 2 hardening: email flows (real SMTP), invitations, media processing, quotas, deletion
 * cleanup, and security audit checks. Storage here is the TEST-ONLY memory driver; real storage is
 * verified separately with `pnpm storage:check` against S3/R2/MinIO.
 */
describe('Phase 2 hardening (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const mailbox = new Mailbox();

  beforeAll(async () => {
    await resetDb();
    await mailbox.start();
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
    await mailbox.stop();
    await prisma.$disconnect();
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  type Ctx = { token: string; businessId: string; email: string };
  const as = (c: Ctx) => ({ Authorization: `Bearer ${c.token}`, 'X-Business-Id': c.businessId });

  async function verify(email: string) {
    const { token } = await mailbox.waitFor(email, 'email-verification');
    await request(http).post('/api/v1/auth/email/verify').send({ token }).expect(200);
  }

  async function owner(name = 'Hardening Shop', verified = true): Promise<Ctx> {
    const u = await register(app);
    if (verified) await verify(u.email);
    const b = await request(http).post('/api/v1/businesses').set(bearer(u.accessToken)).send({ name, type: 'RETAIL_STORE' }).expect(201);
    return { token: u.accessToken, businessId: b.body.id, email: u.email };
  }

  // ─── Email verification ─────────────────────────────────────────────────────
  describe('email verification', () => {
    it('sends a real email on registration; the single-use token verifies the address', async () => {
      const u = await register(app);
      const { mail, token } = await mailbox.waitFor(u.email, 'email-verification');
      expect(mail.subject).toBe('Confirm your email address');
      expect(mail.raw).toContain('http://localhost:3000/verify-email#token=');
      expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      const row = await prisma.authToken.findFirstOrThrow({ where: { email: u.email } });
      expect(row.tokenHash).not.toBe(token); // only the hash is stored

      let me = await request(http).get('/api/v1/auth/me').set(bearer(u.accessToken)).expect(200);
      expect(me.body.emailVerified).toBe(false);
      await request(http).post('/api/v1/auth/email/verify').send({ token }).expect(200);
      me = await request(http).get('/api/v1/auth/me').set(bearer(u.accessToken)).expect(200);
      expect(me.body.emailVerified).toBe(true);
      const again = await request(http).post('/api/v1/auth/email/verify').send({ token }).expect(400);
      expect(again.body.code).toBe('INVALID_TOKEN');
      await request(http).post('/api/v1/auth/email/resend').set(bearer(u.accessToken)).expect(400);
    });

    it('rejects forged or expired tokens and rate limits resends', async () => {
      const u = await register(app);
      await request(http).post('/api/v1/auth/email/verify').send({ token: 'x'.repeat(43) }).expect(400);
      await request(http).post('/api/v1/auth/email/verify').send({ token: 'short' }).expect(400);
      const { token } = await mailbox.waitFor(u.email, 'email-verification');
      await prisma.authToken.updateMany({ where: { email: u.email }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await request(http).post('/api/v1/auth/email/verify').send({ token }).expect(400);
      const res = await request(http).post('/api/v1/auth/email/resend').set(bearer(u.accessToken)).expect(429);
      expect(res.body.code).toBe('TOO_SOON');
    });

    it('a verification token stops working if the account email no longer matches', async () => {
      const u = await register(app);
      const { token } = await mailbox.waitFor(u.email, 'email-verification');
      await prisma.user.update({ where: { email: u.email }, data: { email: uniqueEmail() } });
      await request(http).post('/api/v1/auth/email/verify').send({ token }).expect(400);
    });
  });

  // ─── Password reset ─────────────────────────────────────────────────────────
  describe('password reset', () => {
    it('identical responses for known and unknown emails; email only for known accounts', async () => {
      const u = await register(app);
      const unknown = uniqueEmail();
      const a = await request(http).post('/api/v1/auth/password/forgot').send({ email: u.email.toUpperCase() }).expect(202);
      const b = await request(http).post('/api/v1/auth/password/forgot').send({ email: unknown }).expect(202);
      expect(a.body).toEqual(b.body);
      await mailbox.waitFor(u.email, 'password-reset');
      await new Promise((r) => setTimeout(r, 300));
      expect(mailbox.messages.some((m) => m.to.includes(unknown))).toBe(false);
    });

    it('resets the password, revokes every session, unlocks the account and is single-use', async () => {
      const u = await register(app);
      for (let i = 0; i < 5; i++) await request(http).post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-password-1' }).expect(401);
      await request(http).post('/api/v1/auth/password/forgot').send({ email: u.email }).expect(202);
      const { token } = await mailbox.waitFor(u.email, 'password-reset');
      await request(http).post('/api/v1/auth/password/reset').send({ token, password: 'weak' }).expect(400);
      await request(http).post('/api/v1/auth/password/reset').send({ token, password: 'New-Strong-Passw0rd' }).expect(204);

      await request(http).get('/api/v1/auth/me').set(bearer(u.accessToken)).expect(401); // sessions revoked
      await request(http).post('/api/v1/auth/login').send({ email: u.email, password: STRONG_PASSWORD }).expect(401);
      const ok = await request(http).post('/api/v1/auth/login').send({ email: u.email, password: 'New-Strong-Passw0rd' }).expect(200);
      expect(ok.body.user.emailVerified).toBe(true); // receiving the email proved control of the address
      await request(http).post('/api/v1/auth/password/reset').send({ token, password: 'Another-Passw0rd-1' }).expect(400);
      await mailbox.waitFor(u.email, 'password-changed');
      const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.password_reset' }, orderBy: { createdAt: 'desc' } });
      expect(JSON.stringify(audit)).not.toContain('New-Strong-Passw0rd');
    });

    it('a new reset request invalidates the previous link; expired links fail', async () => {
      const u = await register(app);
      await request(http).post('/api/v1/auth/password/forgot').send({ email: u.email }).expect(202);
      const first = (await mailbox.waitFor(u.email, 'password-reset')).token!;
      await prisma.authToken.updateMany({ where: { email: u.email, type: 'PASSWORD_RESET' }, data: { createdAt: new Date(Date.now() - 120_000) } });
      mailbox.clear();
      await request(http).post('/api/v1/auth/password/forgot').send({ email: u.email }).expect(202);
      const second = (await mailbox.waitFor(u.email, 'password-reset')).token!;
      expect(second).not.toBe(first);
      await request(http).post('/api/v1/auth/password/reset').send({ token: first, password: 'New-Strong-Passw0rd' }).expect(400);
      await prisma.authToken.updateMany({ where: { email: u.email, type: 'PASSWORD_RESET', usedAt: null }, data: { expiresAt: new Date(Date.now() - 1) } });
      await request(http).post('/api/v1/auth/password/reset').send({ token: second, password: 'New-Strong-Passw0rd' }).expect(400);
    });
  });

  // ─── Invitations ────────────────────────────────────────────────────────────
  describe('invitations', () => {
    it('full flow: invite → email → lookup → accept (bound to the invited address, single use)', async () => {
      const o = await owner('Invite Shop');
      const inviteeEmail = uniqueEmail();
      const inv = await request(http).post(`/api/v1/businesses/${o.businessId}/invitations`).set(bearer(o.token)).send({ email: inviteeEmail.toUpperCase(), role: 'EDITOR' }).expect(201);
      expect(inv.body).toMatchObject({ email: inviteeEmail, role: 'EDITOR', sendCount: 1 });
      expect(JSON.stringify(inv.body)).not.toMatch(/token/i);
      const { mail, token } = await mailbox.waitFor(inviteeEmail, 'invitation');
      expect(mail.subject).toContain('Invite Shop');
      expect(mail.raw).toContain('/invitations/accept#token=');

      const look = await request(http).post('/api/v1/invitations/lookup').send({ token }).expect(200);
      expect(look.body).toEqual({ businessName: 'Invite Shop', role: 'EDITOR', email: inviteeEmail, expiresAt: expect.any(String) });
      await request(http).post('/api/v1/invitations/accept').send({ token }).expect(401);

      // Someone else holding the link cannot use it.
      const intruder = await register(app);
      const mismatch = await request(http).post('/api/v1/invitations/accept').set(bearer(intruder.accessToken)).send({ token }).expect(403);
      expect(mismatch.body.code).toBe('INVITATION_EMAIL_MISMATCH');
      expect(await prisma.membership.count({ where: { businessId: o.businessId, user: { email: intruder.email } } })).toBe(0);

      // The invitee registers with the invited address and accepts.
      const invitee = await register(app, inviteeEmail);
      const accepted = await request(http).post('/api/v1/invitations/accept').set(bearer(invitee.accessToken)).send({ token }).expect(200);
      expect(accepted.body).toMatchObject({ businessId: o.businessId, role: 'EDITOR' });
      const biz = await request(http).get(`/api/v1/businesses/${o.businessId}`).set(bearer(invitee.accessToken)).expect(200);
      expect(biz.body.role).toBe('EDITOR');
      await request(http).post('/api/v1/invitations/accept').set(bearer(invitee.accessToken)).send({ token }).expect(404);
      await request(http).post('/api/v1/invitations/lookup').send({ token }).expect(404);
      const me = await request(http).get('/api/v1/auth/me').set(bearer(invitee.accessToken)).expect(200);
      expect(me.body.emailVerified).toBe(true);
    });

    it('requires a verified inviter and respects the role hierarchy (no escalation)', async () => {
      const unverified = await owner('Unverified Shop', false);
      const r = await request(http).post(`/api/v1/businesses/${unverified.businessId}/invitations`).set(bearer(unverified.token)).send({ email: uniqueEmail(), role: 'VIEWER' }).expect(403);
      expect(r.body.code).toBe('EMAIL_NOT_VERIFIED');

      const o = await owner('Hierarchy Shop');
      const mk = async (role: 'ADMIN' | 'EDITOR' | 'VIEWER') => {
        const u = await register(app);
        await verify(u.email);
        const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } });
        await prisma.membership.create({ data: { userId: user.id, businessId: o.businessId, role, status: 'ACTIVE' } });
        return u.accessToken;
      };
      const admin = await mk('ADMIN');
      const editor = await mk('EDITOR');
      const url = `/api/v1/businesses/${o.businessId}/invitations`;
      await request(http).post(url).set(bearer(editor)).send({ email: uniqueEmail(), role: 'VIEWER' }).expect(403);
      await request(http).post(url).set(bearer(admin)).send({ email: uniqueEmail(), role: 'ADMIN' }).expect(403);
      await request(http).post(url).set(bearer(admin)).send({ email: uniqueEmail(), role: 'OWNER' }).expect(403);
      await request(http).post(url).set(bearer(admin)).send({ email: uniqueEmail(), role: 'EDITOR' }).expect(201);
      await request(http).post(url).set(bearer(o.token)).send({ email: uniqueEmail(), role: 'OWNER' }).expect(201);
      // The accepted role always comes from the invitation, never the request.
      const email = uniqueEmail();
      await request(http).post(url).set(bearer(admin)).send({ email, role: 'VIEWER' }).expect(201);
      const { token } = await mailbox.waitFor(email, 'invitation');
      const u = await register(app, email);
      await request(http).post('/api/v1/invitations/accept').set(bearer(u.accessToken)).send({ token, role: 'OWNER' }).expect(400);
      await request(http).post('/api/v1/invitations/accept').set(bearer(u.accessToken)).send({ token }).expect(200);
      const m = await prisma.membership.findFirstOrThrow({ where: { businessId: o.businessId, user: { email } } });
      expect(m.role).toBe('VIEWER');
    });

    it('revoke and resend invalidate old links; existing members cannot be re-invited', async () => {
      const o = await owner('Revoke Shop');
      const url = `/api/v1/businesses/${o.businessId}/invitations`;
      const email = uniqueEmail();
      const inv = await request(http).post(url).set(bearer(o.token)).send({ email, role: 'VIEWER' }).expect(201);
      const first = (await mailbox.waitFor(email, 'invitation')).token!;
      await prisma.invitation.update({ where: { id: inv.body.id }, data: { lastSentAt: new Date(Date.now() - 120_000) } });
      mailbox.clear();
      await request(http).post(`${url}/${inv.body.id}/resend`).set(bearer(o.token)).expect(200);
      const second = (await mailbox.waitFor(email, 'invitation')).token!;
      await request(http).post('/api/v1/invitations/lookup').send({ token: first }).expect(404);
      await request(http).post('/api/v1/invitations/lookup').send({ token: second }).expect(200);
      await request(http).post(`${url}/${inv.body.id}/resend`).set(bearer(o.token)).expect(429);
      await request(http).delete(`${url}/${inv.body.id}`).set(bearer(o.token)).expect(204);
      await request(http).post('/api/v1/invitations/lookup').send({ token: second }).expect(404);
      const list = await request(http).get(url).set(bearer(o.token)).expect(200);
      expect(list.body).toEqual([]);
      await request(http).post(url).set(bearer(o.token)).send({ email: o.email, role: 'VIEWER' }).expect(409);
    });

    it('invitations of one business cannot be managed from another', async () => {
      const a = await owner('Inv A');
      const b = await owner('Inv B');
      const inv = await request(http).post(`/api/v1/businesses/${a.businessId}/invitations`).set(bearer(a.token)).send({ email: uniqueEmail(), role: 'VIEWER' }).expect(201);
      await request(http).delete(`/api/v1/businesses/${b.businessId}/invitations/${inv.body.id}`).set(bearer(b.token)).expect(404);
      await request(http).get(`/api/v1/businesses/${a.businessId}/invitations`).set(bearer(b.token)).expect(404);
      await request(http).post(`/api/v1/businesses/${b.businessId}/invitations/${inv.body.id}/resend`).set(bearer(b.token)).expect(404);
    });
  });

  // ─── Media processing ───────────────────────────────────────────────────────
  describe('media processing', () => {
    const upload = (c: Ctx, buf: Buffer, name: string, type: string) => request(http).post('/api/v1/media').set(as(c)).attach('file', buf, { filename: name, contentType: type });

    it('removes EXIF (including GPS) and re-encodes JPEGs; makes a WebP thumbnail', async () => {
      const o = await owner();
      const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#c33' } })
        .withExif({ IFD0: { Copyright: 'secret-owner-name', Artist: 'Jane Doe' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 6/1 30/1' } })
        .jpeg()
        .toBuffer();
      expect((await sharp(jpeg).metadata()).exif).toBeDefined();
      const res = await upload(o, jpeg, 'photo.jpg', 'image/jpeg').expect(201);
      const stored = (await request(http).get(res.body.url).expect(200)).body as Buffer;
      const meta = await sharp(stored).metadata();
      expect(meta.exif).toBeUndefined();
      expect(stored.toString('latin1')).not.toContain('secret-owner-name');
      expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 800 });
      const thumb = (await request(http).get(res.body.thumbnailUrl).expect(200)).body as Buffer;
      const tmeta = await sharp(thumb).metadata();
      expect(tmeta.format).toBe('webp');
      expect(Math.max(tmeta.width!, tmeta.height!)).toBe(480);
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(Number(row.originalSizeBytes)).toBe(jpeg.length);
      expect(row.scanStatus).toBe('SKIPPED'); // scanner disabled in this suite; see the ClamAV suite below
    });

    it('polyglot files: data appended after the image never reaches storage', async () => {
      const o = await owner();
      const poly = Buffer.concat([png(16, 16), Buffer.from('<html><script>alert(document.cookie)</script></html>')]);
      const res = await upload(o, poly, 'poly.png', 'image/png').expect(201);
      const stored = (await request(http).get(res.body.url).expect(200)).body as Buffer;
      expect(stored.toString('latin1')).not.toContain('<script>');
    });

    it('rejects decompression bombs and corrupt images', async () => {
      const o = await owner();
      const bomb = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
      expect(bomb.length).toBeLessThan(200_000); // tiny file, 9 megapixels when decoded
      const r1 = await upload(o, bomb, 'bomb.png', 'image/png').expect(415);
      expect(r1.body.code).toBe('IMAGE_DIMENSIONS');
      const corrupt = Buffer.concat([png(4, 4).subarray(0, 40), Buffer.alloc(200, 0xff)]);
      const r2 = await upload(o, corrupt, 'corrupt.png', 'image/png').expect(415);
      expect(r2.body.code).toBe('IMAGE_CORRUPT');
      expect(await prisma.mediaAsset.count({ where: { businessId: o.businessId } })).toBe(0);
    });

    it('enforces the per-business storage quota (other businesses unaffected)', async () => {
      const o = await owner();
      const other = await owner();
      await prisma.business.update({ where: { id: o.businessId }, data: { storageQuotaBytes: BigInt(2000) } });
      const big = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer();
      const res = await upload(o, big, 'big.png', 'image/png').expect(413);
      expect(res.body.code).toBe('STORAGE_QUOTA_EXCEEDED');
      const usage = await request(http).get('/api/v1/media/usage').set(as(o)).expect(200);
      expect(usage.body).toEqual({ usedBytes: 0, quotaBytes: 2000, files: 0 });
      await upload(other, big, 'big.png', 'image/png').expect(201);
    });

    it('failed storage deletions are queued and completed by the cleanup job', async () => {
      const o = await owner();
      const storage = app.get(OBJECT_STORAGE) as MemoryObjectStorage;
      const res = await upload(o, png(20, 20), 'a.png', 'image/png').expect(201);
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.body.id } });
      storage.failDeletes = 2; // original + thumbnail
      await request(http).delete(`/api/v1/media/${res.body.id}`).set(as(o)).expect(204);
      await request(http).get(res.body.url).expect(404); // no longer served even though bytes remain
      expect(await storage.head(row.storageKey)).not.toBeNull();
      const pending = await prisma.storageDeletion.findMany({ where: { businessId: o.businessId, completedAt: null } });
      expect(pending.map((p) => p.storageKey).sort()).toEqual([row.storageKey, row.thumbnailKey].sort());
      expect(pending[0]!.lastError).toMatch(/unavailable/);

      const result = await processPendingDeletions(prisma as never, storage, new Date(Date.now() + 120_000));
      expect(result.deleted).toBeGreaterThanOrEqual(2);
      expect(await storage.head(row.storageKey)).toBeNull();
      expect(await storage.head(row.thumbnailKey!)).toBeNull();
      expect(await prisma.storageDeletion.count({ where: { businessId: o.businessId, completedAt: null } })).toBe(0);
    });
  });

  // ─── Security audit ─────────────────────────────────────────────────────────
  describe('security audit', () => {
    it('unauthorized downloads: missing, forged, expired, swapped or cross-variant signatures are refused', async () => {
      const a = await owner('Dl A');
      const b = await owner('Dl B');
      const ma = await request(http).post('/api/v1/media').set(as(a)).attach('file', png(30, 30), { filename: 'a.png', contentType: 'image/png' }).expect(201);
      const mb = await request(http).post('/api/v1/media').set(as(b)).attach('file', png(30, 30), { filename: 'b.png', contentType: 'image/png' }).expect(201);
      const ua = new URL(ma.body.url, 'http://x');
      const exp = ua.searchParams.get('exp')!;
      const sig = ua.searchParams.get('sig')!;
      await request(http).get(`/api/v1/media/${ma.body.id}/content`).expect(404);
      await request(http).get(`/api/v1/media/${ma.body.id}/content?exp=${exp}&sig=${'A'.repeat(43)}`).expect(404);
      await request(http).get(`/api/v1/media/${ma.body.id}/content?exp=${Date.now() - 1000}&sig=${sig}`).expect(404);
      // A's signature does not open B's file.
      await request(http).get(`/api/v1/media/${mb.body.id}/content?exp=${exp}&sig=${sig}`).expect(404);
      // A thumbnail signature cannot open the original (and vice versa).
      const ut = new URL(ma.body.thumbnailUrl, 'http://x');
      await request(http).get(`/api/v1/media/${ma.body.id}/content?exp=${ut.searchParams.get('exp')}&sig=${ut.searchParams.get('sig')}`).expect(404);
      await request(http).get(`/api/v1/media/${ma.body.id}/content?exp=${exp}&sig=${sig}&variant=thumb`).expect(404);
      await request(http).get(`/api/v1/media/${ma.body.id}/content?exp=${exp}&sig=${sig}&variant=../../etc`).expect(404);
      // Cross-business metadata access.
      await request(http).get(`/api/v1/media/${mb.body.id}`).set(as(a)).expect(404);
      await request(http).get('/api/v1/media').set({ ...bearer(a.token), 'X-Business-Id': b.businessId }).expect(404);
    });

    it('no response leaks tokens, hashes, storage keys or credentials', async () => {
      const o = await owner('Leak Shop');
      await request(http).post('/api/v1/media').set(as(o)).attach('file', png(10, 10), { filename: 'x.png', contentType: 'image/png' }).expect(201);
      await request(http).post(`/api/v1/businesses/${o.businessId}/invitations`).set(bearer(o.token)).send({ email: uniqueEmail(), role: 'VIEWER' }).expect(201);
      const bodies = await Promise.all([
        request(http).get('/api/v1/auth/me').set(bearer(o.token)),
        request(http).get('/api/v1/users/me').set(bearer(o.token)),
        request(http).get(`/api/v1/businesses/${o.businessId}/members`).set(bearer(o.token)),
        request(http).get(`/api/v1/businesses/${o.businessId}/invitations`).set(bearer(o.token)),
        request(http).get('/api/v1/media').set(as(o)),
        request(http).get('/api/v1/health/ready'),
        request(http).get('/api/v1/businesses').set(bearer(o.token)),
      ]);
      for (const r of bodies) {
        const text = JSON.stringify(r.body);
        expect(text).not.toMatch(/passwordHash|refreshTokenHash|tokenHash|storageKey|thumbnailKey|touma-minio-dev-password|SECRET_ACCESS|OPENAI_API_KEY|sk-[A-Za-z0-9]{10}/);
        expect(text).not.toContain(o.token);
      }
      const login = await request(http).post('/api/v1/auth/login').send({ email: o.email, password: STRONG_PASSWORD }).expect(200);
      const cookies = (login.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookies).not.toContain(login.body.accessToken);
      const audits = await prisma.auditLog.findMany({ where: { actorId: { not: null } }, take: 200, orderBy: { createdAt: 'desc' } });
      expect(JSON.stringify(audits)).not.toContain(STRONG_PASSWORD);
    });

    it('permission escalation attempts through mass assignment are rejected', async () => {
      const o = await owner();
      await request(http).patch('/api/v1/users/me').set(bearer(o.token)).send({ platformRole: 'SUPER_ADMIN' }).expect(400);
      await request(http).patch('/api/v1/users/me').set(bearer(o.token)).send({ emailVerifiedAt: null }).expect(400);
      await request(http).patch(`/api/v1/businesses/${o.businessId}`).set(bearer(o.token)).send({ storageQuotaBytes: '999999999999' }).expect(400);
      await request(http).post('/api/v1/auth/register').send({ email: uniqueEmail(), password: STRONG_PASSWORD, fullName: 'X', emailVerified: true }).expect(400);
      const me = await prisma.user.findUniqueOrThrow({ where: { email: o.email } });
      expect(me.platformRole).toBe('USER');
    });
  });
});
