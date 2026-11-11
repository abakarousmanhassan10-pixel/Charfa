import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma, type SocialAccount } from '@touma/database';
import { PLATFORM_CAPABILITIES, SOCIAL_PLATFORMS, type SocialPlatformId } from '@touma/shared';
import { SocialApiError, type AuthorizedAccount, type PlatformAdapter, type TokenSet } from '@touma/social-connectors';
import { AuditService } from '../audit/audit.service';
import { TokenCipher } from '../common/crypto/token-cipher';
import { AppEnv, InjectEnv } from '../config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { SOCIAL_ADAPTERS, type SocialAdapters } from './social-providers';

/** Missing permissions that only affect analytics do not stop an account from publishing. */
const ANALYTICS_ONLY = new Set(['read_insights', 'instagram_manage_insights', 'pages_read_engagement', 'r_organization_social', 'video.list', 'https://www.googleapis.com/auth/youtube.readonly']);

interface StoredCandidate {
  externalAccountId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  accountType: string;
  parentExternalId: string | null;
  permissionsMissing: string[];
  scopesGranted: string[];
  metadata: Record<string, unknown>;
  /** Encrypted JSON of this account's TokenSet. Never returned by the API. */
  tokensEnc: string;
}

export type TokenState = 'NON_EXPIRING' | 'VALID' | 'EXPIRING' | 'EXPIRED';

export class SocialAuthError extends Error {
  constructor(readonly code: 'ACCOUNT_NOT_CONNECTED' | 'TOKEN_EXPIRED' | 'PERMISSION_MISSING' | 'ACCOUNT_NOT_AUTHORIZED', message: string) {
    super(message);
  }
}

/**
 * Connected social accounts: the OAuth 2.0 connection workflow, account selection, encrypted token storage, token refresh and
 * expiration monitoring, reconnection and disconnection. Tokens are encrypted at rest (AES-256-GCM) and never leave this service
 * except as an AuthorizedAccount handed to an adapter for the duration of one call.
 */
@Injectable()
export class SocialAccountsService {
  private readonly logger = new Logger('SocialAccounts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(SOCIAL_ADAPTERS) private readonly adapters: SocialAdapters,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  adapter(platform: SocialPlatformId): PlatformAdapter {
    return this.adapters[platform];
  }

  get apiBase() {
    return (this.env.PUBLIC_API_URL ?? `http://localhost:${this.env.API_PORT}`).replace(/\/$/, '');
  }

  /** The address registered in each developer portal as the OAuth redirect URI. */
  redirectUri(platform: SocialPlatformId) {
    return `${this.apiBase}/api/v1/social/oauth/callback/${platform.toLowerCase()}`;
  }

  /** Which platforms the server can connect, and what is missing (names of settings only, never values). */
  platforms() {
    return SOCIAL_PLATFORMS.map((p) => {
      const a = this.adapters[p];
      return {
        platform: p, label: PLATFORM_CAPABILITIES[p].label, configured: a.isConfigured(), missingConfiguration: a.missingConfiguration(), requiredScopes: [...a.requiredScopes], supportsRefresh: a.supportsRefresh,
        redirectUri: this.redirectUri(p), capabilities: PLATFORM_CAPABILITIES[p], mode: this.env.SOCIAL_PROVIDER_MODE, variants: a.variants?.() ?? null,
      };
    });
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  tokenState(a: Pick<SocialAccount, 'tokenExpiresAt'>, now = Date.now()): TokenState {
    if (!a.tokenExpiresAt) return 'NON_EXPIRING';
    const left = a.tokenExpiresAt.getTime() - now;
    if (left <= 0) return 'EXPIRED';
    return left < this.env.SOCIAL_TOKEN_WARN_DAYS * 86_400_000 ? 'EXPIRING' : 'VALID';
  }

  /** The API representation of an account. It has no token fields by construction. */
  dto(a: SocialAccount) {
    const meta = (a.metadata ?? {}) as { permissionsMissing?: string[]; criticalMissing?: string[] };
    return {
      id: a.id, platform: a.platform, externalAccountId: a.externalAccountId, displayName: a.displayName, username: a.username, avatarUrl: a.avatarUrl, accountType: a.accountType, parentExternalId: a.parentExternalId,
      status: a.status, scopes: a.scopes, permissionsMissing: meta.permissionsMissing ?? [], criticalPermissionsMissing: meta.criticalMissing ?? [], tokenExpiresAt: a.tokenExpiresAt?.toISOString() ?? null, tokenState: a.status === 'TOKEN_EXPIRED' ? 'EXPIRED' : this.tokenState(a),
      canRefresh: Boolean(a.refreshTokenEnc) && this.adapters[a.platform as SocialPlatformId].supportsRefresh, connectedAt: a.connectedAt?.toISOString() ?? null, lastError: a.lastError, lastRefreshError: a.lastRefreshError,
      tokenRefreshedAt: a.tokenRefreshedAt?.toISOString() ?? null, lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
    };
  }

  async list(tenant: TenantContext) {
    const rows = await this.prisma.socialAccount.findMany({ where: { businessId: tenant.businessId, deletedAt: null }, orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }] });
    return { items: rows.map((r) => this.dto(r)) };
  }

  async get(tenant: TenantContext, id: string) {
    const a = await this.prisma.socialAccount.findFirst({ where: { id, businessId: tenant.businessId, deletedAt: null } });
    if (!a) throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'Social account not found' });
    return a;
  }

  // ─── OAuth connection ───────────────────────────────────────────────────────

  /** The connection variant to use: the one asked for, or the first enabled one. A disabled or unconfigured variant is refused with the reason. */
  private chooseVariant(platform: SocialPlatformId, asked?: string): string | null {
    const adapter = this.adapters[platform];
    const variants = adapter.variants?.();
    if (!variants) {
      if (asked) throw new BadRequestException({ code: 'VARIANT_UNKNOWN', message: `${PLATFORM_CAPABILITIES[platform].label} has one way of connecting only` });
      return null;
    }
    const v = variants.find((x) => x.id === (asked ?? 'personal'));
    if (!v) throw new BadRequestException({ code: 'VARIANT_UNKNOWN', message: `Unknown connection type "${asked}"` });
    if (!v.enabled) throw new ConflictException({ code: 'VARIANT_DISABLED', message: v.reason ?? 'This connection type is disabled' });
    if (!v.configured) throw new ServiceUnavailableException({ code: 'PLATFORM_NOT_CONFIGURED', message: `This connection type is not configured on this server.`, missing: v.missingConfiguration });
    return v.id;
  }

  async start(tenant: TenantContext, platform: SocialPlatformId, reconnectAccountId?: string, variantAsked?: string) {
    const adapter = this.adapters[platform];
    const variant = this.chooseVariant(platform, variantAsked);
    if (!adapter.variants && !adapter.isConfigured()) throw new ServiceUnavailableException({ code: 'PLATFORM_NOT_CONFIGURED', message: `${PLATFORM_CAPABILITIES[platform].label} is not configured on this server. An administrator must add the developer application credentials.`, missing: adapter.missingConfiguration() });
    if (this.env.SOCIAL_PROVIDER_MODE === 'live' && !this.env.PUBLIC_API_URL) throw new ServiceUnavailableException({ code: 'PUBLIC_API_URL_MISSING', message: 'PUBLIC_API_URL is not set, so the platform cannot redirect back to TOUMA.' });
    if (reconnectAccountId) {
      const acc = await this.get(tenant, reconnectAccountId);
      if (acc.platform !== platform) throw new BadRequestException({ code: 'PLATFORM_MISMATCH', message: 'This account belongs to another platform' });
    }
    const state = randomBytes(32).toString('base64url');
    const { url, codeVerifier } = adapter.buildAuthorizationUrl({ state, redirectUri: this.redirectUri(platform), reconnect: Boolean(reconnectAccountId), variant: variant ?? undefined });
    // Sessions that were never completed are not kept.
    await this.prisma.socialConnectionSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } });
    const session = await this.prisma.socialConnectionSession.create({
      data: {
        businessId: tenant.businessId, userId: tenant.userId, platform, stateHash: createHash('sha256').update(state).digest('hex'), codeVerifierEnc: codeVerifier ? this.cipher.encrypt(codeVerifier) : null,
        reconnectAccountId: reconnectAccountId ?? null, variant, expiresAt: new Date(Date.now() + this.env.SOCIAL_STATE_TTL_MINUTES * 60_000),
      },
    });
    await this.audit.record({ action: 'social.connect_started', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SocialConnectionSession', entityId: session.id, metadata: { platform, reconnect: Boolean(reconnectAccountId), variant } });
    return { sessionId: session.id, authorizationUrl: url, expiresAt: session.expiresAt.toISOString() };
  }

  /**
   * The platform redirects the browser here (public route). The state proves the request belongs to a connection a signed-in person
   * started; it is single use and expires. Returns the web address to send the browser to.
   */
  async callback(platform: SocialPlatformId, q: { code?: string; state?: string; error?: string; error_description?: string }): Promise<string> {
    const back = (params: Record<string, string>) => `${this.env.WEB_URL.replace(/\/$/, '')}/dashboard/social/accounts?${new URLSearchParams(params).toString()}`;
    if (!q.state) return back({ error: 'STATE_INVALID' });
    const hash = createHash('sha256').update(q.state).digest('hex');
    // Single use: the first request claims the session, a replay finds it already taken.
    const claimed = await this.prisma.socialConnectionSession.updateMany({ where: { stateHash: hash, platform, status: 'PENDING_AUTH', expiresAt: { gt: new Date() } }, data: { status: 'EXCHANGING' } });
    if (!claimed.count) return back({ error: 'STATE_INVALID' });
    const session = await this.prisma.socialConnectionSession.findUniqueOrThrow({ where: { stateHash: hash } });
    const fail = async (code: string, message: string) => {
      await this.prisma.socialConnectionSession.update({ where: { id: session.id }, data: { status: 'FAILED', error: `${code}: ${message}`.slice(0, 500), candidates: Prisma.DbNull, codeVerifierEnc: null } });
      await this.audit.record({ action: 'social.connect_failed', actorId: session.userId, businessId: session.businessId, entityType: 'SocialConnectionSession', entityId: session.id, metadata: { platform, code } });
      return back({ error: code, platform });
    };
    if (q.error) return fail(q.error === 'access_denied' ? 'ACCESS_DENIED' : 'PROVIDER_ERROR', q.error_description ?? q.error);
    if (!q.code) return fail('CODE_MISSING', 'The platform returned no authorization code');
    const adapter = this.adapters[platform];
    try {
      const verifier = session.codeVerifierEnc ? this.cipher.decrypt(session.codeVerifierEnc) : null;
      const tokens = await adapter.exchangeCode({ code: q.code, redirectUri: this.redirectUri(platform), codeVerifier: verifier, variant: session.variant ?? undefined });
      const candidates = await adapter.listAccounts(tokens, { variant: session.variant ?? undefined });
      if (!candidates.length) return fail('NO_ACCOUNTS', 'No account that can publish was found for this login');
      const stored: StoredCandidate[] = candidates.map((c) => ({
        externalAccountId: c.externalAccountId, displayName: c.displayName ?? null, username: c.username ?? null, avatarUrl: c.avatarUrl ?? null, accountType: c.accountType, parentExternalId: c.parentExternalId ?? null,
        permissionsMissing: c.permissionsMissing, scopesGranted: c.scopesGranted, metadata: c.metadata ?? {}, tokensEnc: this.cipher.encrypt(JSON.stringify(this.serialize(c.tokens))),
      }));
      await this.prisma.socialConnectionSession.update({ where: { id: session.id }, data: { status: 'AWAITING_SELECTION', candidates: stored as unknown as Prisma.InputJsonValue, codeVerifierEnc: null } });
      return back({ connect: session.id, platform });
    } catch (err) {
      const e = err as SocialApiError;
      this.logger.warn(`OAuth callback for ${platform} failed: ${e.kind ?? 'error'}`);
      return fail(e instanceof SocialApiError ? (e.kind === 'permission' ? 'PERMISSION_DENIED' : 'EXCHANGE_FAILED') : 'EXCHANGE_FAILED', e.message ?? 'failed');
    }
  }

  private async session(tenant: TenantContext, id: string) {
    const s = await this.prisma.socialConnectionSession.findFirst({ where: { id, businessId: tenant.businessId, userId: tenant.userId } });
    if (!s) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'Connection not found' });
    return s;
  }

  /** The accounts the person can choose from (public details only). */
  async pending(tenant: TenantContext, id: string) {
    const s = await this.session(tenant, id);
    if (s.status !== 'AWAITING_SELECTION' || s.expiresAt.getTime() + 20 * 60_000 < Date.now()) throw new ConflictException({ code: 'CONNECTION_NOT_READY', message: 'This connection is not waiting for a selection' });
    const existing = await this.prisma.socialAccount.findMany({ where: { businessId: tenant.businessId, platform: s.platform, deletedAt: null }, select: { externalAccountId: true, status: true } });
    const known = new Map(existing.map((e) => [e.externalAccountId, e.status]));
    return {
      id: s.id, platform: s.platform, variant: s.variant, reconnectAccountId: s.reconnectAccountId,
      candidates: ((s.candidates ?? []) as unknown as StoredCandidate[]).map((c) => ({
        externalAccountId: c.externalAccountId, displayName: c.displayName, username: c.username, avatarUrl: c.avatarUrl, accountType: c.accountType, permissionsMissing: c.permissionsMissing,
        criticalPermissionsMissing: c.permissionsMissing.filter((p) => !ANALYTICS_ONLY.has(p)), alreadyConnected: known.has(c.externalAccountId) && known.get(c.externalAccountId) !== 'DISCONNECTED',
      })),
    };
  }

  /** Connects the chosen accounts. An account is "connected" only here, after a real OAuth authorization returned it. */
  async select(tenant: TenantContext, id: string, externalIds: string[]) {
    const s = await this.session(tenant, id);
    const claimed = await this.prisma.socialConnectionSession.updateMany({ where: { id: s.id, status: 'AWAITING_SELECTION' }, data: { status: 'COMPLETING' } });
    if (!claimed.count) throw new ConflictException({ code: 'CONNECTION_NOT_READY', message: 'This connection is not waiting for a selection' });
    const candidates = (s.candidates ?? []) as unknown as StoredCandidate[];
    const chosen = candidates.filter((c) => externalIds.includes(c.externalAccountId));
    const release = () => this.prisma.socialConnectionSession.updateMany({ where: { id: s.id, status: 'COMPLETING' }, data: { status: 'AWAITING_SELECTION' } });
    if (chosen.length !== externalIds.length) {
      await release();
      throw new BadRequestException({ code: 'ACCOUNT_NOT_OFFERED', message: 'One of the accounts was not offered by the platform' });
    }
    if (s.reconnectAccountId) {
      const target = await this.prisma.socialAccount.findFirst({ where: { id: s.reconnectAccountId, businessId: tenant.businessId } });
      if (!target || chosen.length !== 1 || chosen[0]!.externalAccountId !== target.externalAccountId) {
        await release();
        throw new BadRequestException({ code: 'RECONNECT_ACCOUNT_MISMATCH', message: 'Reconnecting must use the same account. Choose the account you are renewing.' });
      }
    }
    const saved: SocialAccount[] = [];
    for (const c of chosen) {
      const tokens = JSON.parse(this.cipher.decrypt(c.tokensEnc)) as ReturnType<SocialAccountsService['serialize']>;
      const critical = c.permissionsMissing.filter((p) => !ANALYTICS_ONLY.has(p));
      const data = {
        displayName: c.displayName, username: c.username, avatarUrl: c.avatarUrl, accountType: c.accountType, parentExternalId: c.parentExternalId,
        status: (critical.length ? 'PERMISSION_MISSING' : 'CONNECTED') as 'CONNECTED' | 'PERMISSION_MISSING', accessTokenEnc: this.cipher.encrypt(tokens.accessToken), refreshTokenEnc: tokens.refreshToken ? this.cipher.encrypt(tokens.refreshToken) : null,
        tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null, scopes: c.scopesGranted, lastError: critical.length ? `Missing permissions: ${critical.join(', ')}` : null, connectedAt: new Date(), tokenRefreshedAt: new Date(),
        refreshFailures: 0, lastRefreshError: null, expiryWarnedFor: null, deletedAt: null, connectedById: tenant.userId, metadata: { permissionsMissing: c.permissionsMissing, criticalMissing: critical, ...c.metadata } as Prisma.InputJsonValue,
      };
      saved.push(await this.prisma.socialAccount.upsert({
        where: { businessId_platform_externalAccountId: { businessId: tenant.businessId, platform: s.platform, externalAccountId: c.externalAccountId } },
        create: { businessId: tenant.businessId, platform: s.platform, externalAccountId: c.externalAccountId, ...data }, update: data,
      }));
    }
    await this.prisma.socialConnectionSession.update({ where: { id: s.id }, data: { status: 'COMPLETED', completedAt: new Date(), candidates: Prisma.DbNull } });
    for (const a of saved) await this.audit.record({ action: s.reconnectAccountId ? 'social.reconnected' : 'social.connected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SocialAccount', entityId: a.id, metadata: { platform: a.platform, accountType: a.accountType, status: a.status } });
    return { items: saved.map((a) => this.dto(a)) };
  }

  async cancelPending(tenant: TenantContext, id: string) {
    const s = await this.session(tenant, id);
    await this.prisma.socialConnectionSession.update({ where: { id: s.id }, data: { status: 'FAILED', error: 'CANCELLED', candidates: Prisma.DbNull, codeVerifierEnc: null } });
    return { ok: true };
  }

  /** Revokes access at the platform (best effort) and wipes the stored tokens. Publications to this account will fail until it is reconnected. */
  async disconnect(tenant: TenantContext, id: string) {
    const a = await this.get(tenant, id);
    try {
      const adapter = this.adapters[a.platform as SocialPlatformId];
      if (a.status !== 'DISCONNECTED' && adapter.revoke) await adapter.revoke(this.tokens(a));
    } catch {
      // The platform could not be told; the tokens are wiped here regardless.
    }
    const updated = await this.prisma.socialAccount.update({ where: { id: a.id }, data: { status: 'DISCONNECTED', accessTokenEnc: this.cipher.encrypt('revoked'), refreshTokenEnc: null, tokenExpiresAt: null, lastError: null, lastRefreshError: null } });
    await this.audit.record({ action: 'social.disconnected', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SocialAccount', entityId: a.id, metadata: { platform: a.platform } });
    return this.dto(updated);
  }

  // ─── Tokens ─────────────────────────────────────────────────────────────────

  serialize(t: TokenSet) {
    return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? null, expiresAt: t.expiresAt?.toISOString() ?? null, scopes: t.scopes };
  }

  tokens(a: SocialAccount): TokenSet {
    return { accessToken: this.cipher.decrypt(a.accessTokenEnc), refreshToken: a.refreshTokenEnc ? this.cipher.decrypt(a.refreshTokenEnc) : null, expiresAt: a.tokenExpiresAt, scopes: a.scopes };
  }

  private async saveTokens(a: SocialAccount, t: TokenSet) {
    return this.prisma.socialAccount.update({
      where: { id: a.id },
      data: { accessTokenEnc: this.cipher.encrypt(t.accessToken), refreshTokenEnc: t.refreshToken ? this.cipher.encrypt(t.refreshToken) : a.refreshTokenEnc, tokenExpiresAt: t.expiresAt ?? null, tokenRefreshedAt: new Date(), refreshFailures: 0, lastRefreshError: null, expiryWarnedFor: null, status: a.status === 'TOKEN_EXPIRED' ? 'CONNECTED' : a.status },
    });
  }

  /** Marks the account as needing the person (expired or revoked authorization) and tells the people who can reconnect it. */
  async needsReconnect(a: SocialAccount, reason: string) {
    if (a.status === 'TOKEN_EXPIRED') return;
    await this.prisma.socialAccount.update({ where: { id: a.id }, data: { status: 'TOKEN_EXPIRED', lastError: reason.slice(0, 500) } });
    await this.audit.record({ action: 'social.token_expired', actorId: null, businessId: a.businessId, entityType: 'SocialAccount', entityId: a.id, metadata: { platform: a.platform, reason: reason.slice(0, 200) } });
    await this.notifications.notify({
      businessId: a.businessId, permission: 'social.manage', type: 'social.reconnect_needed', title: `Reconnect ${a.displayName ?? a.platform}`, body: reason.slice(0, 300),
      data: { accountId: a.id, platform: a.platform, accountName: a.displayName }, dedupeKey: `reconnect:${a.id}:${a.tokenExpiresAt?.getTime() ?? 0}:${a.refreshFailures}`,
    });
  }

  /** Refreshes the token of one account. Returns the account as stored afterwards. */
  async refresh(a: SocialAccount): Promise<SocialAccount> {
    const adapter = this.adapters[a.platform as SocialPlatformId];
    try {
      const fresh = await adapter.refresh(this.tokens(a));
      const saved = await this.saveTokens(a, fresh);
      await this.audit.record({ action: 'social.token_refreshed', actorId: null, businessId: a.businessId, entityType: 'SocialAccount', entityId: a.id, metadata: { platform: a.platform } });
      return saved;
    } catch (err) {
      const e = err as SocialApiError;
      const permanent = !(e instanceof SocialApiError) || e.kind === 'auth' || e.kind === 'unsupported' || e.kind === 'permission' || e.kind === 'validation';
      const updated = await this.prisma.socialAccount.update({ where: { id: a.id }, data: { refreshFailures: { increment: 1 }, lastRefreshError: String(e.message).slice(0, 500) } });
      if (permanent || updated.refreshFailures >= 5) {
        await this.needsReconnect(updated, `The ${PLATFORM_CAPABILITIES[a.platform as SocialPlatformId].label} authorization could not be renewed. Reconnect the account.`);
      }
      throw err;
    }
  }

  /**
   * The account with a token that works now, as the adapter needs it. Refreshes first when the token is about to expire.
   * Throws SocialAuthError when the account is not allowed to publish (not connected, expired, missing permissions).
   */
  /**
   * TikTok: what the creator may do right now (nickname, visibility options, disabled interactions, maximum duration).
   * Asked of TikTok every time, never cached: TikTok requires the posting screen to reflect the current state of the account.
   */
  async tiktokCreatorInfo(businessId: string, accountId: string) {
    const { account, auth } = await this.authorized(businessId, accountId).catch((e) => {
      if (e instanceof SocialAuthError) throw new UnprocessableEntityException({ code: e.code, message: e.message });
      throw e;
    });
    const adapter = this.adapters.TIKTOK;
    if (account.platform !== 'TIKTOK' || !adapter.creatorInfo) throw new UnprocessableEntityException({ code: 'NOT_TIKTOK', message: 'This is not a TikTok account' });
    try {
      return { ...(await adapter.creatorInfo(auth)), accountId: account.id, queriedAt: new Date().toISOString() };
    } catch (err) {
      if (err instanceof SocialApiError) {
        if (err.kind === 'auth') await this.needsReconnect(account, 'The platform rejected the access token. Reconnect the account.');
        throw new UnprocessableEntityException({ code: err.kind === 'auth' ? 'TOKEN_EXPIRED' : err.kind === 'permission' ? 'PERMISSION_MISSING' : 'PLATFORM_UNAVAILABLE', message: err.message });
      }
      throw err;
    }
  }

  async authorized(businessId: string, accountId: string): Promise<{ account: SocialAccount; auth: AuthorizedAccount }> {
    let a = await this.prisma.socialAccount.findFirst({ where: { id: accountId, businessId, deletedAt: null } });
    if (!a) throw new SocialAuthError('ACCOUNT_NOT_CONNECTED', 'The social account does not exist for this business');
    if (a.status === 'DISCONNECTED') throw new SocialAuthError('ACCOUNT_NOT_CONNECTED', 'The social account is disconnected');
    if (a.status === 'TOKEN_EXPIRED') throw new SocialAuthError('TOKEN_EXPIRED', 'The authorization expired. Reconnect the account.');
    if (a.status === 'PERMISSION_MISSING') throw new SocialAuthError('PERMISSION_MISSING', 'The account is missing permissions required to publish. Reconnect it and accept all permissions.');
    if (a.status !== 'CONNECTED') throw new SocialAuthError('ACCOUNT_NOT_AUTHORIZED', 'The account is not authorized for publishing');
    const adapter = this.adapters[a.platform as SocialPlatformId];
    const left = a.tokenExpiresAt ? a.tokenExpiresAt.getTime() - Date.now() : Infinity;
    if (left < 60_000) {
      if (adapter.supportsRefresh && a.refreshTokenEnc) {
        try {
          a = await this.refresh(a);
        } catch (err) {
          const e = err as SocialApiError;
          if (!(e instanceof SocialApiError) || e.kind === 'auth' || e.kind === 'unsupported' || e.kind === 'permission' || e.kind === 'validation') throw new SocialAuthError('TOKEN_EXPIRED', 'The authorization expired and could not be renewed. Reconnect the account.');
          throw err; // transient: the caller retries later
        }
      } else {
        await this.needsReconnect(a, 'The access token expired and this platform does not allow renewing it automatically. Reconnect the account.');
        throw new SocialAuthError('TOKEN_EXPIRED', 'The authorization expired. Reconnect the account.');
      }
    }
    return { account: a, auth: { externalAccountId: a.externalAccountId, accountType: a.accountType ?? '', parentExternalId: a.parentExternalId, tokens: this.tokens(a) } };
  }

  // ─── Monitoring (called by the social worker) ───────────────────────────────

  /** Refreshes tokens that are about to expire, warns about the ones that cannot be refreshed, and detects revoked authorizations. */
  async monitor(now = new Date()) {
    let refreshed = 0;
    let warned = 0;
    let expired = 0;
    const accounts = await this.prisma.socialAccount.findMany({ where: { status: { in: ['CONNECTED', 'PERMISSION_MISSING'] }, deletedAt: null }, take: 500 });
    for (const a of accounts) {
      const adapter = this.adapters[a.platform as SocialPlatformId];
      const left = a.tokenExpiresAt ? a.tokenExpiresAt.getTime() - now.getTime() : Infinity;
      try {
        if (adapter.supportsRefresh && a.refreshTokenEnc && left < adapter.refreshLeadMs) {
          await this.refresh(a);
          refreshed++;
          continue;
        }
        if (left <= 0) {
          await this.needsReconnect(a, 'The access token expired. Reconnect the account.');
          expired++;
          continue;
        }
        const refreshable = adapter.supportsRefresh && Boolean(a.refreshTokenEnc);
        if (!refreshable && a.tokenExpiresAt && left < this.env.SOCIAL_TOKEN_WARN_DAYS * 86_400_000 && a.expiryWarnedFor?.getTime() !== a.tokenExpiresAt.getTime()) {
          await this.prisma.socialAccount.update({ where: { id: a.id }, data: { expiryWarnedFor: a.tokenExpiresAt } });
          await this.notifications.notify({
            businessId: a.businessId, permission: 'social.manage', type: 'social.token_expiring', title: `${a.displayName ?? a.platform} needs to be reconnected soon`, data: { accountId: a.id, platform: a.platform, accountName: a.displayName, expiresAt: a.tokenExpiresAt.toISOString() },
            dedupeKey: `expiring:${a.id}:${a.tokenExpiresAt.getTime()}`,
          });
          warned++;
        }
        // Authorizations can be revoked by the person at the platform: check once a day where the platform allows it.
        if (adapter.inspectToken && (!a.lastSyncedAt || now.getTime() - a.lastSyncedAt.getTime() > 86_400_000)) {
          const info = await adapter.inspectToken(this.tokens(a));
          await this.prisma.socialAccount.update({ where: { id: a.id }, data: { lastSyncedAt: now } });
          if (!info.valid) {
            await this.needsReconnect(a, `${PLATFORM_CAPABILITIES[a.platform as SocialPlatformId].label} no longer accepts this authorization. Reconnect the account.`);
            expired++;
          }
        }
      } catch (err) {
        this.logger.warn(`monitoring account ${a.id} failed: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    return { refreshed, warned, expired };
  }
}
