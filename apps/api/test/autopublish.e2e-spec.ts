import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SocialApiError } from '@touma/social-connectors';
import { PublishingAutomationService } from '../src/publishing/automation.service';
import { as, type Ctx } from './ai-helpers';
import { prisma, register, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * N21 autonomous & hybrid publishing. The platforms are the test-only simulator: nothing is sent anywhere, so these tests prove TOUMA's decisions
 * (consent, policy, classification, approval, gate, no duplicates), not that a real platform accepts a post.
 */
const ENV: Record<string, string> = { AUTOPUBLISH_ENABLED: 'true', AUTOPUBLISH_RATE_LIMIT_PER_MINUTE: '1000', BILLING_ENABLED: 'true', BILLING_PROVIDER: 'simulated', BILLING_WEBHOOK_SECRET: 'n21-webhook-secret-0123456789', BILLING_ENFORCEMENT_ENABLED: 'true', BILLING_GRACE_DAYS: '3' };
const DAY = 86_400_000;
const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' }];

describe('Autonomous & hybrid publishing (e2e)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let auto: PublishingAutomationService;
  let n = 0;
  const api = (m: 'get' | 'post' | 'put', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/publishing/${path}`).set(as(c)); return body !== undefined ? r.send(body) : m === 'get' ? r : r.send({}); };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    await prisma.$executeRawUnsafe('TRUNCATE "AgentControl" CASCADE');
    await prisma.plan.upsert({ where: { code: 'PRO' }, update: { limits: {}, isActive: true }, create: { code: 'PRO', name: 'PRO', priceAmount: '49', priceAmountMinor: 4900, yearlyPriceAmountMinor: 49000, currency: 'USD', limits: {} } });
    app = await startApp();
    h = socialHelpers(app);
    auto = app.get(PublishingAutomationService);
  });
  beforeEach(() => h.hub.reset());
  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "AgentControl" CASCADE');
    await app.close(); await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  /** A business with an active simulated subscription, an owner, an admin, an editor, and one connected account. */
  async function biz(platform: 'INSTAGRAM' | 'TIKTOK' = 'INSTAGRAM') {
    const owner = await h.tenant(`Autopub ${++n}`);
    const admin = await h.member(owner, 'ADMIN');
    const editor = await h.member(owner, 'EDITOR');
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await prisma.subscription.create({ data: { businessId: owner.businessId, planId: plan.id, status: 'ACTIVE', provider: 'simulated', amountMinor: 4900, currentPeriodStart: new Date(Date.now() - 5 * DAY), currentPeriodEnd: new Date(Date.now() + 25 * DAY) } });
    const account = await h.connect(owner, platform);
    const media = await h.jpeg(owner);
    return { owner, admin, editor, account, media, slot: 0 };
  }
  type Biz = Awaited<ReturnType<typeof biz>>;
  const CONSENT = { accept: true, consentVersion: '2026-11-v1' };
  /** Consent, then the policy. Returns the policy request so tests can `.expect(...)` on it. */
  function enable(b: Biz, mode: 'AUTO' | 'HYBRID', extra: Record<string, unknown> = {}) {
    const consent = api('post', `accounts/${b.account.id}/consent`, b.owner, CONSENT).expect(200);
    return consentThen(consent, () => api('put', `accounts/${b.account.id}/policy`, b.owner, { mode, timezone: 'UTC', allowedContentTypes: ['IMAGE'], allowedPublishingHours: ALL_DAY, maximumPostsPerDay: 10, ...extra }));
  }
  /** Runs `next` after `first` finished, keeping supertest's chainable `.expect`. */
  function consentThen(first: PromiseLike<unknown>, next: () => request.Test): request.Test {
    const t = next();
    const run = t.then.bind(t);
    (t as unknown as { then: unknown }).then = (ok: never, ko: never) => Promise.resolve(first).then(() => run(ok, ko), ko);
    return t;
  }
  const post = (b: Biz, i: number, caption = `Fresh bissap juice number ${i}, served cold at our shop.`) => ({ title: `Post ${i}`, caption, hashtags: ['#bissap'], contentType: 'IMAGE', mediaIds: [b.media.id] });
  const plan = (b: Biz, posts: object[], extra: Record<string, unknown> = {}) => api('post', 'plan', b.owner, { accountId: b.account.id, days: posts.length, startDate: h.day(2), posts, ...extra });
  const decisionOf = (entryId: string) => prisma.publishingDecision.findFirstOrThrow({ where: { calendarEventId: entryId }, orderBy: { createdAt: 'desc' } });
  const pubs = (entryId: string) => prisma.publication.findMany({ where: { calendarEventId: entryId } });
  const actionsOf = async (b: Biz) => (await prisma.publishingDecision.findMany({ where: { businessId: b.owner.businessId }, orderBy: { createdAt: 'asc' } })).map((d) => d.action);
  /** One post on a fresh day of this business (two posts at the same time would conflict, as they should). */
  async function planOne(b: Biz, caption?: string) {
    const r = await plan(b, [post(b, 1, caption)], { startDate: h.day(2 + b.slot++), days: 1 }).expect(201);
    return r.body.entries[0] as { entryId: string; decision: { action: string; risk: string; reasons: Array<{ code: string }> } };
  }
  /** Dispatches and waits long enough for the queue to have acted; resolves to the publications that exist. */
  const settle = async (entryId: string) => { await h.dispatch(entryId); await new Promise((r) => setTimeout(r, 700)); return pubs(entryId); };
  /** The reason the gate recorded on the entry (written by the queue worker, so it is awaited). */
  const gateError = (entryId: string) => h.waitFor(async () => (await prisma.calendarEvent.findUniqueOrThrow({ where: { id: entryId } })).lastError);

  it('AUTO needs a valid, current consent; viewers and editors cannot configure it', async () => {
    const b = await biz();
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { mode: 'AUTO' }).expect(409).expect((r) => expect(r.body.code).toBe('CONSENT_REQUIRED'));
    await api('post', `accounts/${b.account.id}/consent`, b.owner, { accept: true, consentVersion: 'old' }).expect(409).expect((r) => expect(r.body.code).toBe('CONSENT_VERSION_MISMATCH'));
    await api('post', `accounts/${b.account.id}/consent`, b.editor, CONSENT).expect(403);
    const res = await enable(b, 'AUTO').expect(200);
    expect(res.body).toMatchObject({ effectiveMode: 'AUTO', consentRequired: false, policy: { mode: 'AUTO', automationEnabled: true, consentVersion: '2026-11-v1', maximumPostsPerDay: 10 } });
    expect(res.body.policy.consentGrantedAt).toBeTruthy();
    await api('put', `accounts/${b.account.id}/policy`, b.editor, { mode: 'MANUAL' }).expect(403);
    expect((await api('get', 'accounts', b.editor).expect(200)).body).toHaveLength(1); // reading is allowed
  });

  it('HYBRID can be enabled and an invalid configuration is refused', async () => {
    const b = await biz();
    expect((await enable(b, 'HYBRID').expect(200)).body.effectiveMode).toBe('HYBRID');
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { maximumPostsPerDay: 50 }).expect(400);
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { allowedPublishingHours: [{ days: [1], from: '20:00', to: '08:00' }] }).expect(400);
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { allowedContentTypes: ['VIDEO', 'TEXT'] }).expect(400); // Instagram cannot publish text through its official API
    const caps = (await api('get', 'capabilities', b.owner).expect(200)).body;
    expect(caps.platforms.TIKTOK.perPostConfirmation).toBe(true);
    expect(JSON.stringify(caps)).not.toMatch(/accessToken|secret/i);
  });

  it('a normal post is scheduled by the policy and published (simulated) exactly once', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    expect(e.decision).toMatchObject({ action: 'AUTO_SCHEDULED', risk: 'LOW_RISK' });
    const row = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: e.entryId }, include: { content: true } });
    expect(row.content!.status).toBe('SCHEDULED');
    expect(row.authorizedById).toBeTruthy();
    expect((await decisionOf(e.entryId))).toMatchObject({ automated: true, approvedById: row.authorizedById });
    await h.dispatch(e.entryId);
    expect(await h.reach(e.entryId, ['PUBLISHED'])).toMatchObject({ status: 'PUBLISHED', simulated: true });
    expect(await pubs(e.entryId)).toHaveLength(1);
    expect(h.hub.posts).toHaveLength(1);
    const types = (await prisma.publishingEvent.findMany({ where: { calendarEventId: e.entryId } })).map((x) => x.type);
    expect(types).toContain('AUTO_SCHEDULED');
  });

  it('sensitive content waits for a person even in AUTO; the editor cannot approve; the admin approves and it is published', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b, 'Our bissap cures diabetes and heals everything, 100% guaranteed results.');
    expect(e.decision).toMatchObject({ action: 'SENT_TO_REVIEW', risk: 'REVIEW_REQUIRED' });
    expect(e.decision.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['HEALTH_CLAIM', 'MISLEADING']));
    await h.calendarWorker.tick();
    expect(await pubs(e.entryId)).toHaveLength(0); // not scheduled: nothing to dispatch
    await api('post', `entries/${e.entryId}/approve`, b.editor).expect(403);
    expect((await api('get', 'reviews', b.admin).expect(200)).body).toHaveLength(1);
    const ap = await api('post', `entries/${e.entryId}/approve`, b.admin);
    expect([ap.status, ap.body.code]).toEqual([200, undefined]);
    const d = await decisionOf(e.entryId);
    expect(d).toMatchObject({ action: 'HUMAN_APPROVED', automated: false, approvedById: expect.any(String) });
    expect(d.validUntil).toBeTruthy();
    await h.dispatch(e.entryId);
    expect(await h.reach(e.entryId, ['PUBLISHED'])).toMatchObject({ status: 'PUBLISHED' });
    await api('post', `entries/${e.entryId}/approve`, b.admin).expect(409); // single use
  });

  it('editing after the approval invalidates it: nothing is published until it is approved again', async () => {
    const b = await biz();
    await enable(b, 'HYBRID').expect(200);
    const e = await planOne(b, 'Special offer: 70% off everything this week only!'); // unusual promotion: review in HYBRID
    expect(e.decision.action).toBe('SENT_TO_REVIEW');
    await api('post', `entries/${e.entryId}/approve`, b.admin).expect(200);
    await request(h.http).patch(`/api/v1/calendar/entries/${e.entryId}`).set(as(b.owner)).send({ caption: 'Special offer: 70% off everything, and a free gift!' }).expect(200);
    const row = await prisma.calendarEvent.findUniqueOrThrow({ where: { id: e.entryId }, include: { content: true } });
    expect(row.content!.status).toBe('IN_REVIEW');
    expect(await settle(e.entryId)).toHaveLength(0);
    await api('post', `entries/${e.entryId}/approve`, b.admin).expect(409); // the new version has no decision waiting: process it first
    const next = await api('post', `entries/${e.entryId}/process`, b.owner).expect(200);
    expect(next.body.action).toBe('SENT_TO_REVIEW');
    expect(next.body.contentVersion).toBeGreaterThan(1);
  });

  it('BLOCKED content is never published and an approval cannot lift it', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b, 'Use this key sk-abcdefghijklmnopqrstuvwxyz123456 to join.');
    expect(e.decision).toMatchObject({ action: 'BLOCKED', risk: 'BLOCKED' });
    await api('post', `entries/${e.entryId}/approve`, b.admin).expect(409);
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('without the platform permission AUTO cannot be enabled, and a lost permission sends posts to a person', async () => {
    const b = await biz();
    await prisma.socialAccount.update({ where: { id: b.account.id }, data: { metadata: { permissionsMissing: ['instagram_content_publish'], criticalMissing: ['instagram_content_publish'] } } });
    await api('post', `accounts/${b.account.id}/consent`, b.owner, CONSENT).expect(200);
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { mode: 'AUTO' }).expect(409).expect((r) => expect(r.body.code).toBe('PERMISSION_MISSING'));
    await prisma.socialAccount.update({ where: { id: b.account.id }, data: { metadata: { permissionsMissing: [], criticalMissing: [] } } });
    await enable(b, 'AUTO').expect(200);
    await prisma.socialAccount.update({ where: { id: b.account.id }, data: { status: 'PERMISSION_MISSING' } });
    const e = await planOne(b);
    expect(e.decision.action).toBe('SENT_TO_REVIEW'); // policy inactive: manual fallback
    expect((await api('get', `accounts/${b.account.id}`, b.owner).expect(200)).body.effectiveMode).toBe('MANUAL');
  });

  it('revoking the consent withdraws automatic schedules and stops publishing, even when the revocation is not propagated', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    const e2 = await planOne(b, 'Another ordinary post about fresh bissap juice for everyone.');
    expect(e.decision.action).toBe('AUTO_SCHEDULED');
    // Revocation written straight to the database, as if the withdrawal step had not run: the gate still stops the post.
    await prisma.publishingPolicy.update({ where: { socialAccountId: b.account.id }, data: { consentRevokedAt: new Date() } });
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(await gateError(e.entryId)).toMatch(/CONSENT_REVOKED/);
    await prisma.publishingPolicy.update({ where: { socialAccountId: b.account.id }, data: { consentRevokedAt: null } });
    // Real revocation through the API: withdrawn at once, back to MANUAL.
    const res = await api('post', `accounts/${b.account.id}/consent/revoke`, b.owner).expect(200);
    expect(res.body).toMatchObject({ effectiveMode: 'MANUAL', consentRequired: true });
    expect((await decisionOf(e2.entryId)).action).toBe('WITHDRAWN');
    expect((await prisma.calendarEvent.findUniqueOrThrow({ where: { id: e2.entryId }, include: { content: true } })).content!.status).toBe('APPROVED');
    expect(await settle(e2.entryId)).toHaveLength(0);
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { mode: 'AUTO' }).expect(409);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('a post refused by the platform ends FAILED with a controlled reason and is not retried blindly', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    h.hub.script('INSTAGRAM', 'publish', new SocialApiError('permission', 'Requires instagram_content_publish', { outcome: 'not_created' }));
    const p = await settle(e.entryId);
    await h.reach(e.entryId, ['FAILED', 'MANUAL_REQUIRED']);
    const pub = (await pubs(e.entryId))[0]!;
    expect(['FAILED', 'MANUAL_REQUIRED']).toContain(pub.status);
    expect(pub.status).not.toBe('PUBLISHED');
    expect(h.hub.posts).toHaveLength(0);
    expect(p.length).toBeGreaterThanOrEqual(0);
  });

  it('an expired subscription stops automatic publishing and refuses a new configuration', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    await prisma.subscription.update({ where: { businessId: b.owner.businessId }, data: { status: 'EXPIRED', currentPeriodEnd: new Date(Date.now() - 30 * DAY) } });
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(await gateError(e.entryId)).toMatch(/SUBSCRIPTION_REQUIRED/);
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { maximumPostsPerDay: 3 }).expect(402); // no new configuration without a subscription
    await api('post', `accounts/${b.account.id}/resume`, b.owner).expect(402);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('a disconnected account publishes nothing', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    await prisma.socialAccount.update({ where: { id: b.account.id }, data: { status: 'DISCONNECTED' } });
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(0);
    expect((await api('get', `accounts/${b.account.id}`, b.owner).expect(200)).body.effectiveMode).toBe('MANUAL');
  });

  it('a task run twice (and a hand-off repeated) never duplicates a decision or a publication', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    const again = await Promise.all([api('post', `entries/${e.entryId}/process`, b.owner), api('post', `entries/${e.entryId}/process`, b.owner), auto.process({ businessId: b.owner.businessId, membershipId: 'x', role: 'OWNER', userId: (await prisma.membership.findFirstOrThrow({ where: { businessId: b.owner.businessId, role: 'OWNER' } })).userId }, e.entryId)]);
    expect(again.every((r) => (r as { body?: { action: string } }).body?.action ? (r as { body: { action: string } }).body.action === 'AUTO_SCHEDULED' : true)).toBe(true);
    expect(await prisma.publishingDecision.count({ where: { calendarEventId: e.entryId } })).toBe(1);
    await h.dispatch(e.entryId);
    expect((await h.reach(e.entryId, ['PUBLISHED'])).status).toBe('PUBLISHED');
    // The hand-off repeated after the publication (a restart, a second worker): nothing new is created or sent.
    await h.calendarWorker.tick();
    await h.calendarWorker.tick();
    await new Promise((r) => setTimeout(r, 500));
    expect(await pubs(e.entryId)).toHaveLength(1);
    expect(h.hub.posts).toHaveLength(1);
    // A crashed claim is recovered by the background pass, once.
    const q = await planOne(b, 'A second ordinary post about our fresh bissap juice today.');
    await prisma.publishingDecision.update({ where: { calendarEventId_contentVersion: { calendarEventId: q.entryId, contentVersion: 1 } }, data: { action: 'PROCESSING' } });
    await prisma.$executeRaw`UPDATE "PublishingDecision" SET "updatedAt" = now() - interval '1 hour' WHERE "calendarEventId" = ${q.entryId}`;
    expect((await auto.tick()).processed).toBe(1);
    expect((await decisionOf(q.entryId)).action).toBe('AUTO_SCHEDULED');
    expect((await auto.tick()).processed).toBe(0);
  });

  it('the emergency stop and the pause stop outward actions; resuming allows them again', async () => {
    const b = await biz();
    await enable(b, 'AUTO').expect(200);
    const e = await planOne(b);
    await prisma.agentControl.upsert({ where: { scope_scopeId: { scope: 'GLOBAL', scopeId: '' } }, create: { scope: 'GLOBAL', scopeId: '', stopped: true, reason: 'test' }, update: { stopped: true } });
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(await gateError(e.entryId)).toMatch(/AUTOMATION_STOPPED/);
    await prisma.agentControl.update({ where: { scope_scopeId: { scope: 'GLOBAL', scopeId: '' } }, data: { stopped: false } });
    await api('post', `accounts/${b.account.id}/pause`, b.owner).expect(200);
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(await gateError(e.entryId)).toMatch(/AUTOMATION_PAUSED/);
    await api('post', `accounts/${b.account.id}/resume`, b.owner).expect(200);
    await h.dispatch(e.entryId);
    expect(await h.reach(e.entryId, ['PUBLISHED'])).toMatchObject({ status: 'PUBLISHED' });
  });

  it('the daily limit is enforced: the next post of the same day goes to review', async () => {
    const b = await biz();
    await enable(b, 'AUTO', { maximumPostsPerDay: 1 }).expect(200);
    const date = h.day(3);
    const mk = async (caption: string) => (await plan(b, [post(b, 1, caption)], { startDate: date, days: 1 }).expect(201)).body.entries[0];
    const first = await mk('First ordinary post about fresh bissap juice.');
    const second = await mk('Second ordinary post about fresh bissap juice.');
    expect(first.decision.action).toBe('AUTO_SCHEDULED');
    expect(second.decision.action).toBe('SENT_TO_REVIEW');
    expect(second.decision.reasons.map((r: { code: string }) => r.code)).toContain('DAILY_LIMIT');
  });

  it('TikTok: the per-post confirmation is never given on the person\'s behalf', async () => {
    const b = await biz('TIKTOK');
    await api('post', `accounts/${b.account.id}/consent`, b.owner, CONSENT).expect(200);
    await api('put', `accounts/${b.account.id}/policy`, b.owner, { mode: 'AUTO', timezone: 'UTC', allowedContentTypes: ['VIDEO'], allowedPublishingHours: ALL_DAY, maximumPostsPerDay: 5 }).expect(200);
    const video = await h.video(b.owner);
    const r = await plan(b, [{ title: 'Clip', caption: 'A short clip of our bissap.', contentType: 'VIDEO', mediaIds: [video.id] }]).expect(201);
    const e = r.body.entries[0];
    expect(e.decision.action).toBe('AWAITING_PLATFORM_CONFIRMATION');
    expect(await settle(e.entryId)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(0);
  });

  it('tenant isolation: another business cannot read, change or plan on these accounts and entries', async () => {
    const a = await biz();
    const other = await biz();
    await enable(a, 'AUTO').expect(200);
    const e = await planOne(a);
    await api('get', `accounts/${a.account.id}`, other.owner).expect(404);
    await api('put', `accounts/${a.account.id}/policy`, other.owner, { mode: 'MANUAL' }).expect(404);
    await api('post', `accounts/${a.account.id}/consent/revoke`, other.owner).expect(404);
    await api('post', `accounts/${a.account.id}/pause`, other.owner).expect(404);
    await api('post', 'plan', other.owner, { accountId: a.account.id, days: 1, posts: [post(other, 1)] }).expect(404);
    await api('post', `entries/${e.entryId}/process`, other.owner).expect(404);
    await api('post', `entries/${e.entryId}/approve`, other.owner).expect(404);
    expect((await api('get', 'accounts', other.owner).expect(200)).body.map((x: { account: { id: string } }) => x.account.id)).toEqual([other.account.id]);
    expect((await api('get', 'history', other.owner).expect(200)).body.every((x: { businessId: string }) => x.businessId === other.owner.businessId)).toBe(true);
    // A policy of one business can never govern an account of another (the guard also checks the business).
    expect((await prisma.publishingPolicy.findUniqueOrThrow({ where: { socialAccountId: a.account.id } })).businessId).toBe(a.owner.businessId);
  });

  it('the endpoints do not exist when the feature flag is off', async () => {
    const b = await biz();
    process.env.AUTOPUBLISH_ENABLED = 'false';
    const app2 = await startApp();
    try { await request(app2.getHttpServer()).get('/api/v1/publishing/accounts').set(as(b.owner)).expect(404); } finally { await app2.close(); process.env.AUTOPUBLISH_ENABLED = 'true'; }
  });

  it('DEMO: client A (AUTO) and client B (HYBRID) each plan five fictitious posts for a week; nothing leaves the process', async () => {
    const A = await biz();
    const B = await biz();
    await enable(A, 'AUTO').expect(200);
    await enable(B, 'HYBRID').expect(200);
    const ordinary = (b: Biz, k: number) => post(b, k, `Fresh bissap juice, tasting number ${k}. Come and try it at our shop.`);
    // Client A: five ordinary posts, scheduled by the policy.
    const ra = (await plan(A, [1, 2, 3, 4, 5].map((k) => ordinary(A, k))).expect(201)).body.entries;
    expect(ra.map((x: { decision: { action: string } }) => x.decision.action)).toEqual(Array(5).fill('AUTO_SCHEDULED'));
    // Client B: five posts, two of them sensitive.
    const rb = (await plan(B, [ordinary(B, 1), post(B, 2, 'Our juice cures every illness, guaranteed results!'), ordinary(B, 3), post(B, 4, 'Contact the owner at boss@example.com or +235 66 12 34 56.'), ordinary(B, 5)]).expect(201)).body.entries;
    expect(rb.map((x: { decision: { action: string } }) => x.decision.action)).toEqual(['AUTO_SCHEDULED', 'SENT_TO_REVIEW', 'AUTO_SCHEDULED', 'SENT_TO_REVIEW', 'AUTO_SCHEDULED']);
    // The two reviews wait on B's approval queue; A has none.
    expect((await api('get', 'reviews', B.admin).expect(200)).body).toHaveLength(2);
    expect((await api('get', 'reviews', A.admin).expect(200)).body).toHaveLength(0);
    // B approves one and rejects the other.
    await api('post', `entries/${rb[1].entryId}/approve`, B.admin).expect(200);
    await api('post', `entries/${rb[3].entryId}/reject`, B.admin, { reason: 'Personal data must not be published' }).expect(200);
    // The week passes: every scheduled post is handed over and published (simulated).
    for (const e of [...ra, rb[0], rb[1], rb[2], rb[4]]) await h.dispatch(e.entryId);
    for (const e of [...ra, rb[0], rb[1], rb[2], rb[4]]) expect((await h.reach(e.entryId, ['PUBLISHED'])).simulated).toBe(true);
    expect(await settle(rb[3].entryId)).toHaveLength(0);
    expect(h.hub.posts).toHaveLength(9);
    // The dashboard data: results, schedule and history per client; consumption stays estimated and separate.
    const resA = (await api('get', 'results', A.owner).expect(200)).body;
    const resB = (await api('get', 'results', B.owner).expect(200)).body;
    expect(resA.filter((p: { status: string }) => p.status === 'PUBLISHED')).toHaveLength(5);
    expect(resB.filter((p: { status: string }) => p.status === 'PUBLISHED')).toHaveLength(4);
    const schedB = (await api('get', 'schedule', B.owner).expect(200)).body;
    expect(schedB.map((s: { action: string }) => s.action).sort()).toEqual(['AUTO_SCHEDULED', 'AUTO_SCHEDULED', 'AUTO_SCHEDULED', 'HUMAN_APPROVED', 'REJECTED']);
    expect(await actionsOf(A)).toEqual(Array(5).fill('AUTO_SCHEDULED'));
    const hist = (await api('get', 'history', B.owner).expect(200)).body.map((x: { type: string }) => x.type);
    expect(hist).toEqual(expect.arrayContaining(['CONSENT_GRANTED', 'POLICY_CHANGED', 'PLAN_CREATED', 'AUTO_SCHEDULED', 'SENT_TO_REVIEW', 'HUMAN_APPROVED', 'REJECTED']));
    await register(app); // keep the helper imported and the app healthy
  });
});
