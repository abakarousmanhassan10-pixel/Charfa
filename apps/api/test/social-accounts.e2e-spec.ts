import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'crypto';
import { SocialApiError } from '@touma/social-connectors';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';

/**
 * Social accounts: OAuth connection workflow, account selection, encrypted token storage, token refresh and expiration monitoring,
 * reconnection, disconnection, permissions, tenant isolation and webhook authentication. The platforms are the test-only simulator
 * (no real platform was contacted); the rest is real.
 */
describe('Social accounts (e2e)', () => {
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let owner: Awaited<ReturnType<ReturnType<typeof socialHelpers>['tenant']>>;
  let admin: Ctx & { userId: string };
  let editor: Ctx & { userId: string };
  let viewer: Ctx & { userId: string };
  let other: Awaited<ReturnType<ReturnType<typeof socialHelpers>['tenant']>>;

  beforeAll(async () => {
    await resetDb();
    await prisma.webhookEvent.deleteMany();
    app = await startApp();
    h = socialHelpers(app);
    owner = await h.tenant('Café Awa');
    admin = await h.member(owner, 'ADMIN');
    editor = await h.member(owner, 'EDITOR');
    viewer = await h.member(owner, 'VIEWER');
    other = await h.tenant('Other Shop');
  });
  beforeEach(() => h.hub.reset());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  /** Runs start → platform redirect → callback for a platform and returns the connection session id. */
  async function authorize(c: Ctx, platform: string, code = 'valid-code', reconnectAccountId?: string) {
    const start = await h.post(c, `/connections/${platform}/start`, reconnectAccountId ? { reconnectAccountId } : {}).expect(200);
    const res = await request(h.http).get(`/api/v1/social/oauth/callback/${platform}?code=${code}&state=${stateOf(start.body.authorizationUrl)}`).expect(302);
    return { start: start.body, location: new URL(res.headers.location!) };
  }

  describe('status and configuration', () => {
    it('lists the platforms and what each needs, without secrets', async () => {
      const res = await h.get(viewer, '/status').expect(200);
      expect(res.body.platforms.map((p: { platform: string }) => p.platform).sort()).toEqual(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK', 'YOUTUBE']);
      const fb = res.body.platforms.find((p: { platform: string }) => p.platform === 'FACEBOOK');
      expect(fb.redirectUri).toBe('https://api.touma.test/api/v1/social/oauth/callback/facebook');
      expect(fb.capabilities.supports.TEXT).toBe(true);
      expect(res.body.platforms.find((p: { platform: string }) => p.platform === 'INSTAGRAM').capabilities.supports.TEXT).toBe(false);
      expect(res.body.publishing.available).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/test-meta-app-secret|test-tiktok-client-secret/);
    });
  });

  describe('OAuth workflow and account selection', () => {
    it('only people who manage social accounts can start a connection', async () => {
      await h.post(editor, '/connections/facebook/start').expect(403);
      await h.post(viewer, '/connections/facebook/start').expect(403);
      await h.post(admin, '/connections/facebook/start').expect(200);
      await h.post(admin, '/connections/myspace/start').expect(404);
    });

    it('connects an account only after a real authorization returned it, through selection', async () => {
      const before = await h.get(owner, '/accounts').expect(200);
      const { start, location } = await authorize(owner, 'facebook');
      expect(start.authorizationUrl).toContain('state=');
      // Nothing is connected just because a flow was started or the platform redirected back.
      expect((await h.get(owner, '/accounts').expect(200)).body.items).toHaveLength(before.body.items.length);
      expect(location.pathname).toBe('/dashboard/social/accounts');
      const sessionId = location.searchParams.get('connect')!;
      expect(sessionId).toBe(start.sessionId);

      const pending = (await h.get(owner, `/connections/${sessionId}`).expect(200)).body;
      expect(pending.candidates.map((c: { externalAccountId: string }) => c.externalAccountId)).toEqual(['facebook-acc-1', 'facebook-acc-2']);
      expect(JSON.stringify(pending)).not.toMatch(/token|secret/i);
      await h.post(owner, `/connections/${sessionId}/select`, { externalAccountIds: ['not-offered'] }).expect(400);
      const done = (await h.post(owner, `/connections/${sessionId}/select`, { externalAccountIds: ['facebook-acc-2'] }).expect(200)).body;
      expect(done.items).toHaveLength(1);
      expect(done.items[0]).toMatchObject({ platform: 'FACEBOOK', externalAccountId: 'facebook-acc-2', status: 'CONNECTED', accountType: 'PAGE' });
      expect((await h.get(owner, '/accounts').expect(200)).body.items.some((a: { externalAccountId: string }) => a.externalAccountId === 'facebook-acc-2')).toBe(true);
      // The session cannot be used again.
      await h.post(owner, `/connections/${sessionId}/select`, { externalAccountIds: ['facebook-acc-1'] }).expect(409);
      await h.get(owner, `/connections/${sessionId}`).expect(409);
    });

    it('stores tokens encrypted, and never returns them', async () => {
      const { location } = await authorize(owner, 'youtube');
      const id = location.searchParams.get('connect')!;
      const res = await h.post(owner, `/connections/${id}/select`, { externalAccountIds: ['youtube-acc-1'] }).expect(200);
      const row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: res.body.items[0].id } });
      expect(row.accessTokenEnc).not.toContain('user-token');
      expect(row.refreshTokenEnc).not.toBeNull();
      expect(h.tokenOf(row)).toMatch(/^YOUTUBE-token-1$|^fresh-token|^YOUTUBE-token/);
      expect(h.cipher.decrypt(row.refreshTokenEnc!)).toBe('YOUTUBE-refresh-1');
      expect(row.tokenExpiresAt).not.toBeNull(); // YouTube tokens expire hourly
      const all = JSON.stringify([(await h.get(owner, '/accounts').expect(200)).body, (await h.get(owner, `/accounts/${row.id}`).expect(200)).body, res.body]);
      expect(all).not.toMatch(/YOUTUBE-token|YOUTUBE-refresh|accessTokenEnc|refreshTokenEnc|Enc"/);
      expect(Object.keys(res.body.items[0])).not.toEqual(expect.arrayContaining(['accessToken', 'refreshToken', 'accessTokenEnc']));
    });

    it('uses PKCE where the platform supports it and keeps the verifier encrypted until the callback', async () => {
      const start = await h.post(owner, '/connections/youtube/start').expect(200);
      const s = await prisma.socialConnectionSession.findUniqueOrThrow({ where: { id: start.body.sessionId } });
      expect(s.codeVerifierEnc).not.toBeNull();
      expect(s.codeVerifierEnc).not.toContain('fake-verifier');
      expect(s.stateHash).toHaveLength(64);
      expect(JSON.stringify(s)).not.toContain(stateOf(start.body.authorizationUrl)); // only a hash of the state is stored
      await request(h.http).get(`/api/v1/social/oauth/callback/youtube?code=valid-code&state=${stateOf(start.body.authorizationUrl)}`).expect(302);
      expect(h.hub.calls.find((c) => c.op === 'exchange')!.detail!.verifier).toBe('fake-verifier');
      expect((await prisma.socialConnectionSession.findUniqueOrThrow({ where: { id: s.id } })).codeVerifierEnc).toBeNull();
    });

    it('rejects forged, replayed, expired and cross-platform states, and platform errors, without connecting anything', async () => {
      const count = () => prisma.socialAccount.count({ where: { businessId: owner.businessId } });
      const n = await count();
      const go = async (path: string) => new URL((await request(h.http).get(path).expect(302)).headers.location!);
      expect((await go('/api/v1/social/oauth/callback/facebook?code=valid-code&state=forged')).searchParams.get('error')).toBe('STATE_INVALID');
      expect((await go('/api/v1/social/oauth/callback/facebook?code=valid-code')).searchParams.get('error')).toBe('STATE_INVALID');

      const a = await h.post(owner, '/connections/facebook/start').expect(200);
      const st = stateOf(a.body.authorizationUrl);
      expect((await go(`/api/v1/social/oauth/callback/instagram?code=valid-code&state=${st}`)).searchParams.get('error')).toBe('STATE_INVALID'); // wrong platform
      const ok = await go(`/api/v1/social/oauth/callback/facebook?code=valid-code&state=${st}`);
      expect(ok.searchParams.get('connect')).toBeTruthy();
      expect((await go(`/api/v1/social/oauth/callback/facebook?code=valid-code&state=${st}`)).searchParams.get('error')).toBe('STATE_INVALID'); // replay

      const b = await h.post(owner, '/connections/facebook/start').expect(200);
      await prisma.socialConnectionSession.update({ where: { id: b.body.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await go(`/api/v1/social/oauth/callback/facebook?code=valid-code&state=${stateOf(b.body.authorizationUrl)}`)).searchParams.get('error')).toBe('STATE_INVALID');

      const c = await h.post(owner, '/connections/tiktok/start').expect(200);
      const denied = await go(`/api/v1/social/oauth/callback/tiktok?error=access_denied&state=${stateOf(c.body.authorizationUrl)}`);
      expect(denied.searchParams.get('error')).toBe('ACCESS_DENIED');
      const d = await h.post(owner, '/connections/tiktok/start').expect(200);
      expect((await go(`/api/v1/social/oauth/callback/tiktok?code=bad-code&state=${stateOf(d.body.authorizationUrl)}`)).searchParams.get('error')).toBe('EXCHANGE_FAILED');
      const e = await h.post(owner, '/connections/linkedin/start').expect(200);
      h.hub.accounts.LINKEDIN = [];
      expect((await go(`/api/v1/social/oauth/callback/linkedin?code=valid-code&state=${stateOf(e.body.authorizationUrl)}`)).searchParams.get('error')).toBe('NO_ACCOUNTS');
      expect(await count()).toBe(n + 0); // none of these connected an account
      expect((await prisma.socialAccount.count({ where: { businessId: owner.businessId, platform: { in: ['TIKTOK', 'LINKEDIN'] } } }))).toBe(0);
    });

    it('binds a pending connection to the person and business that started it', async () => {
      const { location } = await authorize(admin, 'tiktok');
      const id = location.searchParams.get('connect')!;
      await h.get(owner, `/connections/${id}`).expect(404); // another person of the same business
      await h.get(other, `/connections/${id}`).expect(404);
      await h.post(other, `/connections/${id}/select`, { externalAccountIds: ['tiktok-acc-1'] }).expect(404);
      await request(h.http).delete(`/api/v1/social/connections/${id}`).set(as(admin)).expect(200);
      await h.get(admin, `/connections/${id}`).expect(409);
      expect(await prisma.socialAccount.count({ where: { platform: 'TIKTOK', businessId: { in: [owner.businessId, other.businessId] } } })).toBe(0);
    });

    it('records accounts with missing permissions as unable to publish, and says which', async () => {
      h.hub.accounts.INSTAGRAM = [{ ...h.hub.defaultAccounts('INSTAGRAM')[0]!, permissionsMissing: ['instagram_content_publish'] }, { ...h.hub.defaultAccounts('INSTAGRAM')[1]!, permissionsMissing: ['instagram_manage_insights'] }];
      const { location } = await authorize(owner, 'instagram');
      const id = location.searchParams.get('connect')!;
      const pending = (await h.get(owner, `/connections/${id}`).expect(200)).body;
      expect(pending.candidates[0].criticalPermissionsMissing).toEqual(['instagram_content_publish']);
      expect(pending.candidates[1].criticalPermissionsMissing).toEqual([]); // analytics-only: publishing still works
      const res = await h.post(owner, `/connections/${id}/select`, { externalAccountIds: ['instagram-acc-1', 'instagram-acc-2'] }).expect(200);
      const byId = Object.fromEntries(res.body.items.map((a: { externalAccountId: string }) => [a.externalAccountId, a]));
      expect(byId['instagram-acc-1']).toMatchObject({ status: 'PERMISSION_MISSING', criticalPermissionsMissing: ['instagram_content_publish'] });
      expect(byId['instagram-acc-2']).toMatchObject({ status: 'CONNECTED', permissionsMissing: ['instagram_manage_insights'] });
    });
  });

  describe('reconnection, disconnection and permissions', () => {
    it('reconnects an expired account in place, and only the same account', async () => {
      const acc = await h.connect(owner, 'TIKTOK', 1, { status: 'TOKEN_EXPIRED', tokenExpiresAt: new Date(Date.now() - 1000), externalAccountId: 'tiktok-acc-1' });
      await h.post(editor, '/connections/tiktok/start', { reconnectAccountId: acc.id }).expect(403);
      await h.post(admin, '/connections/instagram/start', { reconnectAccountId: acc.id }).expect(400); // wrong platform
      await h.post(other, '/connections/tiktok/start', { reconnectAccountId: acc.id }).expect(404); // another business's account
      const { location } = await authorize(admin, 'tiktok', 'valid-code', acc.id);
      const id = location.searchParams.get('connect')!;
      expect((await h.post(admin, `/connections/${id}/select`, { externalAccountIds: ['tiktok-acc-2'] }).expect(400)).body.code).toBe('RECONNECT_ACCOUNT_MISMATCH');
      const done = (await h.post(admin, `/connections/${id}/select`, { externalAccountIds: ['tiktok-acc-1'] }).expect(200)).body;
      expect(done.items[0]).toMatchObject({ id: acc.id, status: 'CONNECTED', lastError: null });
      expect(await prisma.socialAccount.count({ where: { businessId: owner.businessId, platform: 'TIKTOK', externalAccountId: 'tiktok-acc-1' } })).toBe(1); // renewed, not duplicated
      const row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(h.hub.calls.filter((c) => c.op === 'authorize').at(-1)).toBeDefined();
    });

    it('disconnects: revokes at the platform, wipes the tokens and stops publishing to it', async () => {
      const acc = await h.connect(owner, 'LINKEDIN', 1);
      await h.post(editor, `/accounts/${acc.id}/disconnect`).expect(403);
      await h.post(viewer, `/accounts/${acc.id}/disconnect`).expect(403);
      await h.post(other, `/accounts/${acc.id}/disconnect`).expect(404);
      const res = await h.post(admin, `/accounts/${acc.id}/disconnect`).expect(200);
      expect(res.body.status).toBe('DISCONNECTED');
      expect(h.hub.calls.some((c) => c.op === 'revoke' && c.platform === 'LINKEDIN')).toBe(true);
      const row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
      expect(h.tokenOf(row)).toBe('revoked');
      expect(row.refreshTokenEnc).toBeNull();
      const entry = await h.scheduled(editor, admin, { platform: 'LINKEDIN', title: 'To a disconnected account', localDate: h.day(4), localTime: '09:00' });
      await prisma.calendarEvent.update({ where: { id: entry.id }, data: { socialAccountId: acc.id } });
      await h.dispatch(entry.id);
      await h.waitFor(async () => (await h.entryRow(entry.id)).content?.status === 'FAILED');
      expect((await h.entryRow(entry.id)).lastError).toMatch(/ACCOUNT_NOT_CONNECTED/);
      expect(h.hub.count('LINKEDIN', 'publish')).toBe(0);
    });

    it('lets everyone read accounts but only managers change them', async () => {
      const acc = await h.connect(owner, 'FACEBOOK', 5);
      for (const c of [viewer, editor, admin, owner]) await h.get(c, `/accounts/${acc.id}`).expect(200);
      await h.post(editor, `/accounts/${acc.id}/refresh`).expect(403);
      await h.get(other, `/accounts/${acc.id}`).expect(404);
      expect((await h.get(other, '/accounts').expect(200)).body.items.map((a: { id: string }) => a.id)).not.toContain(acc.id);
      const spoof = { Authorization: `Bearer ${other.token}`, 'X-Business-Id': owner.businessId };
      for (const r of [await request(h.http).get('/api/v1/social/accounts').set(spoof), await request(h.http).get(`/api/v1/social/accounts/${acc.id}`).set(spoof)]) {
        expect([403, 404]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toContain(acc.externalAccountId);
      }
    });

    it('keeps an audit trail of connections', async () => {
      const actions = (await prisma.auditLog.findMany({ where: { businessId: owner.businessId, action: { startsWith: 'social.' } } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['social.connect_started', 'social.connected', 'social.reconnected', 'social.disconnected', 'social.connect_failed']));
      const log = await prisma.auditLog.findFirstOrThrow({ where: { businessId: owner.businessId, action: 'social.connected' } });
      expect(JSON.stringify(log.metadata)).not.toMatch(/token/i);
    });
  });

  describe('token refresh and expiration monitoring', () => {
    it('refreshes a token that is about to expire, and keeps the refresh token', async () => {
      const acc = await h.connect(owner, 'YOUTUBE', 7, { tokenExpiresAt: new Date(Date.now() + 5 * 60_000) });
      const before = h.tokenOf(acc);
      const res = await h.socialWorker.tick();
      expect(res.monitored!.refreshed).toBeGreaterThanOrEqual(1);
      const row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
      expect(h.tokenOf(row)).not.toBe(before);
      expect(h.tokenOf(row)).toMatch(/^fresh-token-/);
      expect(h.cipher.decrypt(row.refreshTokenEnc!)).toContain('YOUTUBE-refresh-');
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
      expect(row.tokenRefreshedAt).not.toBeNull();
      expect(row.status).toBe('CONNECTED');
      expect(h.hub.calls.filter((c) => c.op === 'refresh' && c.accessToken === before)).toHaveLength(1);
      // Not due again: a later tick does not refresh a fresh token.
      h.hub.calls = [];
      await h.socialWorker.tick();
      expect(h.hub.calls.filter((c) => c.op === 'refresh' && c.accessToken === h.tokenOf(row))).toHaveLength(0);
      await h.post(admin, `/accounts/${acc.id}/refresh`).expect(200);
    });

    it('marks the account for reconnection when the platform refuses the refresh, and tells the managers once', async () => {
      await prisma.socialAccount.updateMany({ where: { businessId: owner.businessId, platform: 'TIKTOK' }, data: { tokenExpiresAt: new Date(Date.now() + 10 * 86_400_000) } });
      const acc = await h.connect(owner, 'TIKTOK', 8, { tokenExpiresAt: new Date(Date.now() + 60_000) });
      h.hub.script('TIKTOK', 'refresh', new SocialApiError('auth', 'Refresh token is expired', { outcome: 'not_created' }));
      await h.socialWorker.tick();
      const row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
      expect(row.status).toBe('TOKEN_EXPIRED');
      expect(row.lastRefreshError).toMatch(/expired/);
      const notes = (await h.notifications(admin.userId, 'social.reconnect_needed')).filter((n) => (n.data as { accountId: string }).accountId === acc.id);
      expect(notes).toHaveLength(1);
      expect((await h.notifications(editor.userId, 'social.reconnect_needed')).filter((n) => (n.data as { accountId: string }).accountId === acc.id)).toHaveLength(0);
      await h.socialWorker.tick();
      expect((await h.notifications(admin.userId, 'social.reconnect_needed')).filter((n) => (n.data as { accountId: string }).accountId === acc.id)).toHaveLength(1);
      expect((await h.get(viewer, `/accounts/${acc.id}`).expect(200)).body).toMatchObject({ status: 'TOKEN_EXPIRED', tokenState: 'EXPIRED' });
    });

    it('keeps trying after a temporary refresh failure instead of disconnecting', async () => {
      const acc = await h.connect(owner, 'LINKEDIN', 9, { tokenExpiresAt: new Date(Date.now() + 60_000) });
      h.hub.script('LINKEDIN', 'refresh', new SocialApiError('transient', 'temporary', { outcome: 'unknown' }));
      await h.socialWorker.tick();
      let row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
      expect(row).toMatchObject({ status: 'CONNECTED', refreshFailures: 1 });
      await h.socialWorker.tick();
      row = await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } });
      expect(row).toMatchObject({ status: 'CONNECTED', refreshFailures: 0 });
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    });

    it('warns before a token that cannot be renewed expires, then flags it when it does', async () => {
      const acc = await h.connect(owner, 'FACEBOOK', 10, { tokenExpiresAt: new Date(Date.now() + 3 * 86_400_000) });
      const far = await h.connect(owner, 'FACEBOOK', 11, { tokenExpiresAt: new Date(Date.now() + 40 * 86_400_000) });
      await h.socialWorker.tick();
      await h.socialWorker.tick();
      const warns = (await h.notifications(admin.userId, 'social.token_expiring')).filter((n) => (n.data as { accountId: string }).accountId === acc.id);
      expect(warns).toHaveLength(1);
      expect((await h.notifications(admin.userId, 'social.token_expiring')).some((n) => (n.data as { accountId: string }).accountId === far.id)).toBe(false);
      expect((await h.get(owner, `/accounts/${acc.id}`).expect(200)).body.tokenState).toBe('EXPIRING');
      expect((await h.get(owner, `/accounts/${far.id}`).expect(200)).body.tokenState).toBe('VALID');
      await prisma.socialAccount.update({ where: { id: acc.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
      await h.socialWorker.tick();
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe('TOKEN_EXPIRED');
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: far.id } })).status).toBe('CONNECTED');
      expect(h.hub.calls.some((c) => c.op === 'refresh' && c.platform === 'FACEBOOK')).toBe(false); // never attempted where the platform does not allow it
    });

    it('detects an authorization the person revoked at the platform', async () => {
      const acc = await h.connect(owner, 'INSTAGRAM', 12);
      h.hub.rejectedTokens.add(h.tokenOf(acc));
      await h.socialWorker.tick();
      expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe('TOKEN_EXPIRED');
      const note = (await h.notifications(admin.userId, 'social.reconnect_needed')).find((n) => (n.data as { accountId: string }).accountId === acc.id);
      expect(note).toBeDefined();
    });
  });

  describe('webhooks are authenticated', () => {
    const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    it('Meta: verification needs the shared token; events need a valid signature and are stored once', async () => {
      await request(h.http).get('/api/v1/social/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc').expect(403);
      const ok = await request(h.http).get('/api/v1/social/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token-123456&hub.challenge=abc123').expect(200);
      expect(ok.text).toBe('abc123');
      const body = JSON.stringify({ object: 'page', entry: [{ id: 'p1', time: 1 }] });
      const send = (sig?: string) => request(h.http).post('/api/v1/social/webhooks/meta').set('content-type', 'application/json').set(sig ? { 'x-hub-signature-256': sig } : {}).send(body);
      await send().expect(401);
      await send('sha256=deadbeef').expect(401);
      await send(sign('another-secret', body)).expect(401);
      expect(await prisma.webhookEvent.count({ where: { provider: 'META' } })).toBe(0);
      expect((await send(sign('test-meta-app-secret', body)).expect(200)).body).toEqual({ received: true, duplicate: false });
      expect((await send(sign('test-meta-app-secret', body)).expect(200)).body).toEqual({ received: true, duplicate: true });
      expect(await prisma.webhookEvent.count({ where: { provider: 'META' } })).toBe(1);
    });

    it('TikTok: signature with timestamp, replay window, and publish events wake the poller', async () => {
      const acc = await h.connect(owner, 'TIKTOK', 20);
      const content = await prisma.content.create({ data: { businessId: owner.businessId, type: 'VIDEO', status: 'PUBLISHING', caption: 'x', targetPlatforms: ['TIKTOK'] } });
      const pub = await prisma.publication.create({ data: { businessId: owner.businessId, contentId: content.id, socialAccountId: acc.id, platform: 'TIKTOK', status: 'AWAITING_PROVIDER', scheduledAt: new Date(), timezone: 'UTC', idempotencyKey: `wh-${Date.now()}`, providerRef: 'pub-123', providerStage: 'PUBLISH_INIT', nextCheckAt: new Date(Date.now() + 3_600_000) } });
      const payload = JSON.stringify({ client_key: 'k', event: 'post.publish.complete', create_time: 1700000000, content: JSON.stringify({ publish_id: 'pub-123' }) });
      const header = (ts: number, secret = 'test-tiktok-client-secret') => `t=${ts},s=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
      const send = (sig?: string) => request(h.http).post('/api/v1/social/webhooks/tiktok').set('content-type', 'application/json').set(sig ? { 'tiktok-signature': sig } : {}).send(payload);
      const now = Math.floor(Date.now() / 1000);
      await send().expect(401);
      await send(header(now, 'wrong-secret')).expect(401);
      await send(header(now - 3600)).expect(401); // too old: a replay
      expect((await send(header(now)).expect(200)).body.duplicate).toBe(false);
      expect((await prisma.publication.findUniqueOrThrow({ where: { id: pub.id } })).nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await send(header(now)).expect(200)).body.duplicate).toBe(true);
      expect(await prisma.webhookEvent.count({ where: { provider: 'TIKTOK' } })).toBe(1);
    });
  });
});
