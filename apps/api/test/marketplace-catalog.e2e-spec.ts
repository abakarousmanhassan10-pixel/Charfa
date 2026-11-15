import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';
import { manifestHash } from '../src/marketplace/marketplace.service';

/** N24 block A: the catalog and the three fictitious listings. No installation, payment or review exists yet, and the catalog must not pretend otherwise. */
const ENV: Record<string, string> = { MARKETPLACE_ENABLED: 'true', MARKETPLACE_DEMO_ENABLED: 'true', MARKETPLACE_RATE_LIMIT_PER_MINUTE: '1000' };

describe('Marketplace catalog (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let admin: { accessToken: string; email: string };
  let a: Ctx; let b: Ctx;
  const M = (path: string, c: Ctx) => request(h.http).get(`/api/v1/marketplace/${path}`).set(as(c));
  const list = async (c: Ctx, qs = '') => (await M(`catalog${qs}`, c).expect(200)).body as { total: number; items: Array<{ slug: string; pricing: { type: string; simulated: boolean }; installs: { count: number | null }; reviews: { count: number; average: number | null }; creator: { demo: boolean }; demo: boolean; latestVersion: string }> };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    await prisma.$executeRawUnsafe('TRUNCATE "MarketplaceReview", "MarketplaceVersion", "MarketplaceListing", "CreatorProfile" CASCADE');
    app = await startApp();
    h = socialHelpers(app);
    admin = await register(app);
    await prisma.user.update({ where: { email: admin.email }, data: { platformRole: 'SUPER_ADMIN' } });
    a = await h.tenant('Shop A'); b = await h.tenant('Shop B');
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const seed = () => request(h.http).post('/api/v1/admin/marketplace/demo-seed').set('Authorization', `Bearer ${admin.accessToken}`).send({});

  it('only a platform administrator can create the demo entries, and it is idempotent', async () => {
    await request(h.http).post('/api/v1/admin/marketplace/demo-seed').set(as(a)).send({}).expect(403);
    expect((await seed().expect(200)).body).toMatchObject({ listings: 3, created: 3, demo: true });
    expect((await seed().expect(200)).body).toMatchObject({ created: 0 });
    expect(await prisma.marketplaceListing.count()).toBe(3);
    expect(await prisma.marketplaceVersion.count()).toBe(4);
    expect(await prisma.creatorProfile.count()).toBe(1);
  });

  it('lists the three listings: two free, one premium (simulated), all labelled demo, nothing invented', async () => {
    const r = await list(a);
    expect(r.total).toBe(3);
    expect(r.items.map((i) => i.slug).sort()).toEqual(['customer-support-ai', 'ecommerce-research-ai', 'marketing-ai-pro']);
    const by = Object.fromEntries(r.items.map((i) => [i.slug, i]));
    expect(by['marketing-ai-pro']!.pricing).toMatchObject({ type: 'FREE', simulated: false });
    expect(by['customer-support-ai']!.pricing).toMatchObject({ type: 'PREMIUM', simulated: true });
    expect(by['ecommerce-research-ai']!.pricing.type).toBe('FREE');
    expect(by['marketing-ai-pro']!.latestVersion).toBe('1.1.0');
    for (const i of r.items) {
      expect(i).toMatchObject({ demo: true, creator: { demo: true }, installs: { count: null }, reviews: { count: 0, average: null } });
    }
  });

  it('search, category, pricing, model filters and sorting', async () => {
    expect((await list(a, '?q=support')).items.map((i) => i.slug)).toEqual(['customer-support-ai']);
    expect((await list(a, '?q=BISSAP')).total).toBe(0);
    expect((await list(a, '?q=calendar')).items.map((i) => i.slug)).toEqual(['marketing-ai-pro']); // tag match
    expect((await list(a, '?category=ECOMMERCE')).items.map((i) => i.slug)).toEqual(['ecommerce-research-ai']);
    expect((await list(a, '?pricing=PREMIUM')).items.map((i) => i.slug)).toEqual(['customer-support-ai']);
    expect((await list(a, '?pricing=FREE')).total).toBe(2);
    expect((await list(a, '?model=mock-model')).total).toBe(3);
    expect((await list(a, '?model=other-model')).total).toBe(0);
    expect((await list(a, '?sort=name')).items.map((i) => i.slug)).toEqual(['customer-support-ai', 'ecommerce-research-ai', 'marketing-ai-pro']);
    expect((await list(a, '?pageSize=2&page=2')).items).toHaveLength(1);
    await M('catalog?category=NOPE', a).expect(400);
    await M('catalog?pageSize=500', a).expect(400);
    const cats = (await M('categories', a).expect(200)).body as Array<{ category: string; listings: number }>;
    expect(cats.find((c) => c.category === 'MARKETING')!.listings).toBe(1);
    expect(cats.find((c) => c.category === 'ANALYTICS')!.listings).toBe(0);
  });

  it('a listing page shows capabilities, required permissions, models, licence, author, latest version and the update history', async () => {
    const d = (await M('listings/marketing-ai-pro', a).expect(200)).body;
    expect(d).toMatchObject({ name: 'Marketing AI Pro', pricing: { type: 'FREE' }, license: { type: 'FREE' }, latestVersion: { version: '1.1.0' }, creator: { displayName: 'Demo Studio (fictitious)', demo: true, verified: false }, compatibleModels: ['mock-model'] });
    expect(d.capabilities.map((c: { tool: string }) => c.tool).sort()).toEqual(['catalog.search', 'draft.save', 'knowledge.lookup']);
    expect(d.permissions.map((p: { key: string }) => p.key).sort()).toEqual(['read.catalog', 'read.knowledge', 'write.drafts']);
    expect(d.permissions.find((p: { key: string }) => p.key === 'write.drafts').sensitive).toBe(true);
    expect(d.history.map((x: { version: string }) => x.version)).toEqual(['1.1.0', '1.0.0']);
    expect(d.history[0].permissions).toContain('read.knowledge');
    expect(d.history[1].permissions).not.toContain('read.knowledge'); // the update asked for one more permission: visible in the history
    expect(d.history[0].manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.agent.instructions).toMatch(/Never promise results/);
    expect(d.installs.count).toBeNull();
    expect(d.reviews).toMatchObject({ count: 0, average: null, items: [], verifiedOnly: true });
    const p = (await M('listings/customer-support-ai', a).expect(200)).body;
    expect(p.pricing).toMatchObject({ type: 'PREMIUM', simulated: true });
    expect(p.pricing.note).toMatch(/no price is set and no payment/);
    expect(p.license.type).toBe('PREMIUM_SIMULATED');
    await M('listings/does-not-exist', a).expect(404);
    await M('listings/BAD SLUG', a).expect(400);
  });

  it('only published, moderated content is visible: drafts, suspended listings, unpublished versions and suspended creators are hidden', async () => {
    const creator = await prisma.creatorProfile.findFirstOrThrow();
    const base = { creatorId: creator.id, summary: 'A hidden test listing for the catalog.', description: 'x', category: 'RESEARCH', tags: [], demo: true };
    const mkVersion = (listingId: string, status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED') => prisma.marketplaceVersion.create({ data: { listingId, version: '1.0.0', manifest: { id: 'x' }, manifestHash: 'h', changelog: 'c', status, publishedAt: new Date() } });
    const draft = await prisma.marketplaceListing.create({ data: { ...base, slug: 'hidden-draft', name: 'Hidden Draft', status: 'DRAFT' } }); await mkVersion(draft.id, 'DRAFT');
    const susp = await prisma.marketplaceListing.create({ data: { ...base, slug: 'hidden-suspended', name: 'Hidden Suspended', status: 'SUSPENDED', suspendedReason: 'test' } }); await mkVersion(susp.id);
    const noVer = await prisma.marketplaceListing.create({ data: { ...base, slug: 'hidden-noversion', name: 'Hidden No Version', status: 'PUBLISHED', publishedAt: new Date() } }); await mkVersion(noVer.id, 'DRAFT');
    expect((await list(a)).total).toBe(3);
    for (const s of ['hidden-draft', 'hidden-suspended', 'hidden-noversion']) await M(`listings/${s}`, a).expect(404);
    // Suspending a published listing removes it at once; reinstating a creator brings it back.
    await prisma.marketplaceListing.update({ where: { slug: 'ecommerce-research-ai' }, data: { status: 'SUSPENDED', suspendedReason: 'review' } });
    expect((await list(a)).items.map((i) => i.slug)).not.toContain('ecommerce-research-ai');
    await M('listings/ecommerce-research-ai', a).expect(404);
    await prisma.marketplaceListing.update({ where: { slug: 'ecommerce-research-ai' }, data: { status: 'PUBLISHED', suspendedReason: null } });
    await prisma.creatorProfile.update({ where: { id: creator.id }, data: { status: 'SUSPENDED' } });
    expect((await list(a)).total).toBe(0);
    await prisma.creatorProfile.update({ where: { id: creator.id }, data: { status: 'ACTIVE' } });
    expect((await list(a)).total).toBe(3);
    await prisma.marketplaceVersion.deleteMany({ where: { listing: { slug: { startsWith: 'hidden-' } } } });
    await prisma.marketplaceListing.deleteMany({ where: { slug: { startsWith: 'hidden-' } } });
  });

  it('reviews count only when moderated and approved; none exist in the catalog otherwise', async () => {
    const l = await prisma.marketplaceListing.findUniqueOrThrow({ where: { slug: 'marketing-ai-pro' } });
    await prisma.marketplaceReview.create({ data: { listingId: l.id, businessId: a.businessId, userId: 'u1', rating: 5, comment: 'Pending review', status: 'PENDING' } });
    await prisma.marketplaceReview.create({ data: { listingId: l.id, businessId: b.businessId, userId: 'u2', rating: 3, comment: 'Approved review', status: 'APPROVED' } });
    const d = (await M('listings/marketing-ai-pro', a).expect(200)).body;
    expect(d.reviews).toMatchObject({ count: 1, average: 3 });
    expect(d.reviews.items).toHaveLength(1);
    expect(JSON.stringify(d.reviews)).not.toMatch(/u1|u2|Shop A|Shop B|businessId|userId/); // no reviewer identity
    // One review per business and a rating from 1 to 5 are enforced by the database.
    await expect(prisma.marketplaceReview.create({ data: { listingId: l.id, businessId: a.businessId, userId: 'u1', rating: 4 } })).rejects.toThrow();
    await expect(prisma.marketplaceReview.create({ data: { listingId: l.id, businessId: b.businessId, userId: 'u3', rating: 9 } })).rejects.toThrow();
    await prisma.marketplaceReview.deleteMany({});
  });

  it('published versions are immutable at the database level; the hash matches the content', async () => {
    const v = await prisma.marketplaceVersion.findFirstOrThrow({ where: { version: '1.0.0', listing: { slug: 'marketing-ai-pro' } } });
    expect(manifestHash(v.manifest)).toBe(v.manifestHash);
    await expect(prisma.marketplaceVersion.update({ where: { id: v.id }, data: { manifest: { tampered: true } } })).rejects.toThrow(/immutable/);
    await expect(prisma.marketplaceVersion.update({ where: { id: v.id }, data: { changelog: 'rewritten' } })).rejects.toThrow(/immutable/);
    await expect(prisma.marketplaceVersion.update({ where: { id: v.id }, data: { manifestHash: 'x' } })).rejects.toThrow(/immutable/);
    await prisma.marketplaceVersion.update({ where: { id: v.id }, data: { status: 'SUSPENDED' } }); // moderation status may change
    await prisma.marketplaceVersion.update({ where: { id: v.id }, data: { status: 'PUBLISHED' } });
    // Manifests of the seed are plain data: no URL, key or script field.
    const all = await prisma.marketplaceVersion.findMany();
    expect(JSON.stringify(all.map((x) => x.manifest))).not.toMatch(/https?:|sk-|postInstall|<script|\\bscripts?\\b/);
  });

  it('access: signed-in members only, any member can read, flag off hides everything', async () => {
    await request(h.http).get('/api/v1/marketplace/catalog').expect(401);
    const viewer = await h.member(a, 'VIEWER');
    expect((await list(viewer)).total).toBe(3);
    process.env.MARKETPLACE_ENABLED = 'false';
    const app2 = await startApp();
    try { await request(app2.getHttpServer()).get('/api/v1/marketplace/catalog').set(as(a)).expect(404); } finally { await app2.close(); process.env.MARKETPLACE_ENABLED = 'true'; }
  });
});
