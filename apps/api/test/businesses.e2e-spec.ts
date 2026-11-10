import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { BusinessRole } from '@touma/database';
import { prisma, register, resetDb, startApp } from './helpers';

/**
 * Tenant isolation & RBAC against a real database.
 * Memberships for non-owners are inserted directly (invitations arrive with email in Phase 2).
 */
describe('Businesses, tenancy and RBAC (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDb();
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function createBusiness(token: string, body: Record<string, unknown> = {}) {
    const res = await request(http)
      .post('/api/v1/businesses')
      .set(auth(token))
      .send({ name: 'Café Awa', type: 'RESTAURANT', timezone: 'Africa/Ndjamena', currency: 'xaf', country: 'td', ...body })
      .expect(201);
    return res.body as { id: string; slug: string; name: string; role: string; permissions: string[] };
  }

  async function addMember(businessId: string, role: BusinessRole) {
    const m = await register(app);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: m.email } });
    const membership = await prisma.membership.create({
      data: { userId: user.id, businessId, role, status: 'ACTIVE', joinedAt: new Date() },
    });
    return { ...m, membershipId: membership.id, userId: user.id };
  }

  describe('creation', () => {
    it('creates a business, makes the creator OWNER and audits it', async () => {
      const owner = await register(app);
      const b = await createBusiness(owner.accessToken);
      expect(b).toMatchObject({ name: 'Café Awa', role: 'OWNER', currency: 'XAF', country: 'TD', timezone: 'Africa/Ndjamena' });
      expect(b.slug).toMatch(/^cafe-awa-[a-f0-9]{6}$/);
      expect(b.permissions).toContain('business.delete');
      const audit = await prisma.auditLog.findFirst({ where: { businessId: b.id, action: 'business.create' } });
      expect(audit).not.toBeNull();

      const list = await request(http).get('/api/v1/businesses').set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((x: { id: string }) => x.id)).toEqual([b.id]);
      const me = await request(http).get('/api/v1/users/me').set(auth(owner.accessToken)).expect(200);
      expect(me.body.memberships[0]).toMatchObject({ role: 'OWNER', business: { id: b.id } });
    });

    it.each([
      [{ name: 'A', type: 'OTHER' }],
      [{ name: 'Valid', type: 'SPACESHIP' }],
      [{ name: 'Valid', type: 'OTHER', timezone: 'Mars/Olympus' }],
      [{ name: 'Valid', type: 'OTHER', website: 'javascript:alert(1)' }],
      [{ name: 'Valid', type: 'OTHER', currency: 'DOLLARS' }],
      [{ name: 'Valid', type: 'OTHER', slug: 'chosen-slug' }],
      [{ name: 'Valid', type: 'OTHER', deletedAt: null }],
    ])('rejects invalid or non-whitelisted input %#', async (body) => {
      const owner = await register(app);
      await request(http).post('/api/v1/businesses').set(auth(owner.accessToken)).send(body).expect(400);
    });

    it('requires authentication', async () => {
      await request(http).post('/api/v1/businesses').send({ name: 'X Shop', type: 'OTHER' }).expect(401);
    });

    it('enforces the per-user ownership cap', async () => {
      const owner = await register(app);
      for (let i = 0; i < 5; i++) await createBusiness(owner.accessToken, { name: `Shop ${i}` });
      const res = await request(http)
        .post('/api/v1/businesses')
        .set(auth(owner.accessToken))
        .send({ name: 'One too many', type: 'OTHER' })
        .expect(403);
      expect(res.body.code).toBe('BUSINESS_LIMIT_REACHED');
    });
  });

  describe('tenant isolation', () => {
    it('a non-member gets 404 on every business route and cannot list it', async () => {
      const a = await register(app);
      const b = await register(app);
      const biz = await createBusiness(a.accessToken);
      const base = `/api/v1/businesses/${biz.id}`;

      await request(http).get(base).set(auth(b.accessToken)).expect(404);
      await request(http).patch(base).set(auth(b.accessToken)).send({ name: 'Hijacked' }).expect(404);
      await request(http).delete(base).set(auth(b.accessToken)).send({ confirmName: biz.name }).expect(404);
      await request(http).get(`${base}/dashboard`).set(auth(b.accessToken)).expect(404);
      await request(http).get(`${base}/members`).set(auth(b.accessToken)).expect(404);

      const list = await request(http).get('/api/v1/businesses').set(auth(b.accessToken)).expect(200);
      expect(list.body).toEqual([]);
      expect((await prisma.business.findUniqueOrThrow({ where: { id: biz.id } })).name).toBe('Café Awa');
    });

    it('404 for a non-member and for a non-existent id look identical', async () => {
      const a = await register(app);
      const b = await register(app);
      const biz = await createBusiness(a.accessToken);
      const foreign = await request(http).get(`/api/v1/businesses/${biz.id}`).set(auth(b.accessToken)).expect(404);
      const missing = await request(http)
        .get('/api/v1/businesses/clxxxxxxxxxxxxxxxxxxxxxxx')
        .set(auth(b.accessToken))
        .expect(404);
      expect(foreign.body.code).toBe(missing.body.code);
      expect(foreign.body.message).toBe(missing.body.message);
    });

    it('cannot manipulate a membership of another tenant through own business route', async () => {
      const a = await register(app);
      const b = await register(app);
      const bizA = await createBusiness(a.accessToken, { name: 'Tenant A' });
      const bizB = await createBusiness(b.accessToken, { name: 'Tenant B' });
      const viewerOfA = await addMember(bizA.id, 'VIEWER');

      // B is OWNER of bizB but targets A's membership id via B's own business path.
      await request(http)
        .patch(`/api/v1/businesses/${bizB.id}/members/${viewerOfA.membershipId}`)
        .set(auth(b.accessToken))
        .send({ role: 'ADMIN' })
        .expect(404);
      await request(http)
        .delete(`/api/v1/businesses/${bizB.id}/members/${viewerOfA.membershipId}`)
        .set(auth(b.accessToken))
        .expect(404);
      const m = await prisma.membership.findUniqueOrThrow({ where: { id: viewerOfA.membershipId } });
      expect(m).toMatchObject({ role: 'VIEWER', status: 'ACTIVE' });
    });

    it('revoked members lose access immediately', async () => {
      const owner = await register(app);
      const biz = await createBusiness(owner.accessToken);
      const editor = await addMember(biz.id, 'EDITOR');
      await request(http).get(`/api/v1/businesses/${biz.id}`).set(auth(editor.accessToken)).expect(200);
      await request(http)
        .delete(`/api/v1/businesses/${biz.id}/members/${editor.membershipId}`)
        .set(auth(owner.accessToken))
        .expect(204);
      await request(http).get(`/api/v1/businesses/${biz.id}`).set(auth(editor.accessToken)).expect(404);
    });

    it('soft-deleted businesses disappear for all members', async () => {
      const owner = await register(app);
      const biz = await createBusiness(owner.accessToken);
      const admin = await addMember(biz.id, 'ADMIN');
      await request(http)
        .delete(`/api/v1/businesses/${biz.id}`)
        .set(auth(owner.accessToken))
        .send({ confirmName: 'wrong' })
        .expect(400);
      await request(http)
        .delete(`/api/v1/businesses/${biz.id}`)
        .set(auth(owner.accessToken))
        .send({ confirmName: biz.name })
        .expect(204);
      await request(http).get(`/api/v1/businesses/${biz.id}`).set(auth(owner.accessToken)).expect(404);
      const list = await request(http).get('/api/v1/businesses').set(auth(admin.accessToken)).expect(200);
      expect(list.body).toEqual([]);
      expect((await prisma.business.findUniqueOrThrow({ where: { id: biz.id } })).deletedAt).not.toBeNull();
    });
  });

  describe('role permissions', () => {
    let ownerToken: string;
    let bizId: string;
    let bizName: string;
    let admin: Awaited<ReturnType<typeof addMember>>;
    let editor: Awaited<ReturnType<typeof addMember>>;
    let viewer: Awaited<ReturnType<typeof addMember>>;
    let ownerMembershipId: string;

    beforeAll(async () => {
      const owner = await register(app);
      ownerToken = owner.accessToken;
      const biz = await createBusiness(ownerToken, { name: 'RBAC Shop' });
      bizId = biz.id;
      bizName = biz.name;
      admin = await addMember(bizId, 'ADMIN');
      editor = await addMember(bizId, 'EDITOR');
      viewer = await addMember(bizId, 'VIEWER');
      ownerMembershipId = (await prisma.membership.findFirstOrThrow({ where: { businessId: bizId, role: 'OWNER' } })).id;
    });

    it('every member can read the business and dashboard', async () => {
      for (const t of [ownerToken, admin.accessToken, editor.accessToken, viewer.accessToken]) {
        await request(http).get(`/api/v1/businesses/${bizId}`).set(auth(t)).expect(200);
        await request(http).get(`/api/v1/businesses/${bizId}/dashboard`).set(auth(t)).expect(200);
      }
    });

    it('viewer and editor cannot update the business; admin can', async () => {
      for (const t of [viewer.accessToken, editor.accessToken]) {
        const res = await request(http).patch(`/api/v1/businesses/${bizId}`).set(auth(t)).send({ industry: 'x' }).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');
      }
      const res = await request(http)
        .patch(`/api/v1/businesses/${bizId}`)
        .set(auth(admin.accessToken))
        .send({ industry: 'Food & beverage', brandVoice: 'Warm' })
        .expect(200);
      expect(res.body).toMatchObject({ industry: 'Food & beverage', role: 'ADMIN' });
      expect(res.body.permissions).not.toContain('business.delete');
    });

    it('clears optional fields with empty strings and refuses to null required ones', async () => {
      await request(http)
        .patch(`/api/v1/businesses/${bizId}`)
        .set(auth(admin.accessToken))
        .send({ website: 'https://shop.example', country: 'fr' })
        .expect(200);
      const cleared = await request(http)
        .patch(`/api/v1/businesses/${bizId}`)
        .set(auth(admin.accessToken))
        .send({ website: '', country: '' })
        .expect(200);
      expect(cleared.body).toMatchObject({ website: null, country: null });
      for (const body of [{ name: null }, { name: '' }, { timezone: null }, {}]) {
        await request(http).patch(`/api/v1/businesses/${bizId}`).set(auth(admin.accessToken)).send(body).expect(400);
      }
    });

    it('only the owner can delete', async () => {
      await request(http)
        .delete(`/api/v1/businesses/${bizId}`)
        .set(auth(admin.accessToken))
        .send({ confirmName: bizName })
        .expect(403);
    });

    it('editor and viewer cannot manage members', async () => {
      await request(http)
        .patch(`/api/v1/businesses/${bizId}/members/${viewer.membershipId}`)
        .set(auth(editor.accessToken))
        .send({ role: 'EDITOR' })
        .expect(403);
      await request(http)
        .delete(`/api/v1/businesses/${bizId}/members/${viewer.membershipId}`)
        .set(auth(editor.accessToken))
        .expect(403);
    });

    it('admin cannot promote to admin/owner or touch the owner', async () => {
      await request(http)
        .patch(`/api/v1/businesses/${bizId}/members/${viewer.membershipId}`)
        .set(auth(admin.accessToken))
        .send({ role: 'ADMIN' })
        .expect(403);
      await request(http)
        .patch(`/api/v1/businesses/${bizId}/members/${ownerMembershipId}`)
        .set(auth(admin.accessToken))
        .send({ role: 'VIEWER' })
        .expect(403);
      await request(http)
        .delete(`/api/v1/businesses/${bizId}/members/${ownerMembershipId}`)
        .set(auth(admin.accessToken))
        .expect(403);
    });

    it('admin can promote viewer to editor (audited)', async () => {
      const res = await request(http)
        .patch(`/api/v1/businesses/${bizId}/members/${viewer.membershipId}`)
        .set(auth(admin.accessToken))
        .send({ role: 'EDITOR' })
        .expect(200);
      expect(res.body.find((m: { id: string }) => m.id === viewer.membershipId).role).toBe('EDITOR');
      const audit = await prisma.auditLog.findFirst({ where: { businessId: bizId, action: 'membership.role_change' } });
      expect(audit?.metadata).toMatchObject({ from: 'VIEWER', to: 'EDITOR' });
    });

    it('nobody can change their own role; the last owner cannot leave', async () => {
      await request(http)
        .patch(`/api/v1/businesses/${bizId}/members/${admin.membershipId}`)
        .set(auth(admin.accessToken))
        .send({ role: 'OWNER' })
        .expect(403);
      const res = await request(http)
        .delete(`/api/v1/businesses/${bizId}/members/${ownerMembershipId}`)
        .set(auth(ownerToken))
        .expect(400);
      expect(res.body.code).toBe('LAST_OWNER');
    });

    it('a member can leave on their own', async () => {
      await request(http)
        .delete(`/api/v1/businesses/${bizId}/members/${editor.membershipId}`)
        .set(auth(editor.accessToken))
        .expect(204);
      await request(http).get(`/api/v1/businesses/${bizId}`).set(auth(editor.accessToken)).expect(404);
    });

    it('members list does not expose credentials', async () => {
      const res = await request(http).get(`/api/v1/businesses/${bizId}/members`).set(auth(viewer.accessToken)).expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshTokenHash/);
    });
  });

  describe('dashboard summary', () => {
    it('returns only stored records — empty for a new business (no fake data)', async () => {
      const owner = await register(app);
      const biz = await createBusiness(owner.accessToken);
      const res = await request(http).get(`/api/v1/businesses/${biz.id}/dashboard`).set(auth(owner.accessToken)).expect(200);
      expect(res.body).toEqual({ socialAccounts: [], content: { total: 0, byStatus: {} }, upcomingPublications: [], members: 1 });
    });

    it('counts real content and never leaks another tenant’s records', async () => {
      const a = await register(app);
      const b = await register(app);
      const bizA = await createBusiness(a.accessToken, { name: 'Counted' });
      const bizB = await createBusiness(b.accessToken, { name: 'Other' });
      await prisma.content.createMany({
        data: [
          { businessId: bizA.id, type: 'TEXT', status: 'DRAFT', caption: 'a' },
          { businessId: bizA.id, type: 'TEXT', status: 'APPROVED', caption: 'b' },
          { businessId: bizB.id, type: 'TEXT', status: 'DRAFT', caption: 'c' },
        ],
      });
      const res = await request(http).get(`/api/v1/businesses/${bizA.id}/dashboard`).set(auth(a.accessToken)).expect(200);
      expect(res.body.content).toEqual({ total: 2, byStatus: { DRAFT: 1, APPROVED: 1 } });
    });
  });

  describe('platform admin', () => {
    it('regular users are refused; super admins get aggregate counts only', async () => {
      const user = await register(app);
      await request(http).get('/api/v1/admin/overview').set(auth(user.accessToken)).expect(403);
      await prisma.user.update({ where: { email: user.email }, data: { platformRole: 'SUPER_ADMIN' } });
      const res = await request(http).get('/api/v1/admin/overview').set(auth(user.accessToken)).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['activeSessions', 'businesses', 'users']);
    });

    it('platform admins have no implicit access to tenant data', async () => {
      const owner = await register(app);
      const biz = await createBusiness(owner.accessToken);
      const admin = await register(app);
      await prisma.user.update({ where: { email: admin.email }, data: { platformRole: 'SUPER_ADMIN' } });
      await request(http).get(`/api/v1/businesses/${biz.id}`).set(auth(admin.accessToken)).expect(404);
    });
  });
});
