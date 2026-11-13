import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import { SocialApiError, type PlatformAdapter } from '@touma/social-connectors';
import { FEATURE_KEYS, PLATFORM_FEATURES, featureStates, type FeatureKey, type FeatureResult, type SocialPlatformId } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { SocialAccountsService, SocialAuthError } from './social-accounts.service';
import { SOCIAL_ADAPTERS, type SocialAdapters } from './social-providers';

export type ReplyMode = 'AUTO' | 'MANUAL' | 'PAUSED';
const REPLY_MAX = 1000;
const USABLE = new Set(['AVAILABLE', 'UNVERIFIED']);

/**
 * Comments on the business's own published posts (Phase N19): capability checks, reading, and replying.
 * Nothing here talks to a platform unless the feature flag is on, the account is connected with the permissions the platform
 * requires, and, for an automatic reply, the merchant switched AUTO mode on. Every operation is scoped by business.
 */
@Injectable()
export class SocialInteractionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
    private readonly audit: AuditService,
    @Inject(SOCIAL_ADAPTERS) private readonly adapters: SocialAdapters,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  private adapter(platform: string): PlatformAdapter {
    return this.adapters[platform as SocialPlatformId];
  }
  private implemented(platform: string): FeatureKey[] {
    const a = this.adapter(platform);
    const out: FeatureKey[] = [];
    if (typeof a.fetchComments === 'function') out.push('commentsRead');
    if (typeof a.replyToComment === 'function') out.push('commentsReply');
    return out;
  }
  private get simulated() {
    return this.env.SOCIAL_PROVIDER_MODE === 'fake';
  }
  private featuresOf(a: { platform: string; scopes: string[] }): Record<FeatureKey, FeatureResult> {
    const platform = a.platform as SocialPlatformId;
    // The test simulator reports the pseudo-permission "all"; a real platform never does.
    const granted = this.simulated && a.scopes.includes('all') ? FEATURE_KEYS.flatMap((k) => [...PLATFORM_FEATURES[platform][k].scopes]) : a.scopes;
    return featureStates(platform, granted, this.implemented(a.platform));
  }

  async capabilities(tenant: TenantContext, accountId: string) {
    const a = await this.accounts.get(tenant, accountId);
    return this.view(a);
  }
  private view(a: { id: string; platform: string; status: string; scopes: string[]; lastSyncedAt: Date | null; lastError: string | null }) {
    const spec = PLATFORM_FEATURES[a.platform as SocialPlatformId];
    return {
      accountId: a.id, platform: a.platform, status: a.status, simulated: this.simulated, grantedScopes: this.simulated ? [] : a.scopes, lastVerifiedAt: a.lastSyncedAt?.toISOString() ?? null, lastError: a.lastError,
      features: this.featuresOf(a),
      enabled: { commentsRead: this.env.SOCIAL_COMMENTS_ENABLED, commentsReply: this.env.SOCIAL_COMMENT_REPLIES_ENABLED },
      platformNotes: { accountTypes: spec.accountTypes, appReview: spec.appReview, quota: spec.quota, sandbox: spec.sandbox },
    };
  }

  /** Asks the platform whether the authorization still works and records the answer (never changes a disconnected account). */
  async validate(tenant: TenantContext, accountId: string) {
    let a = await this.accounts.get(tenant, accountId);
    if (a.status === 'DISCONNECTED') return this.view(a);
    const adapter = this.adapter(a.platform);
    if (adapter.inspectToken) {
      try {
        const ins = await adapter.inspectToken(this.accounts.tokens(a));
        if (!ins.valid) await this.accounts.needsReconnect(a, 'The platform no longer accepts this authorization. Reconnect the account.');
        else {
          a = await this.prisma.socialAccount.update({ where: { id: a.id }, data: { lastSyncedAt: new Date(), ...(ins.expiresAt !== undefined ? { tokenExpiresAt: ins.expiresAt } : {}), ...(ins.scopes?.length && !this.simulated ? { scopes: ins.scopes } : {}) } });
        }
      } catch (e) {
        throw this.map(e, a);
      }
    }
    await this.audit.record({ action: 'social.account_validated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'SocialAccount', entityId: a.id });
    return this.view(await this.accounts.get(tenant, accountId));
  }

  private map(e: unknown, _a: { id: string; platform: string }): HttpException {
    if (e instanceof HttpException) return e;
    if (e instanceof SocialAuthError) return new ConflictException({ code: e.code, message: e.message });
    if (e instanceof SocialApiError) {
      switch (e.kind) {
        case 'rate_limit': return new HttpException({ code: 'PLATFORM_RATE_LIMIT', message: 'The platform asked us to slow down. Try again later.', retryAfterMs: e.opts.retryAfterMs ?? null }, HttpStatus.TOO_MANY_REQUESTS);
        case 'auth': return new ConflictException({ code: 'TOKEN_EXPIRED', message: 'The authorization expired or was revoked. Reconnect the account.' });
        case 'permission': return new ConflictException({ code: 'PERMISSION_MISSING', message: 'The platform refused: a permission is missing or not approved for this application.' });
        case 'unsupported': return new HttpException({ code: 'UNSUPPORTED_OPERATION', message: 'This platform does not offer this operation.' }, HttpStatus.NOT_IMPLEMENTED);
        default: return new ServiceUnavailableException({ code: 'PLATFORM_UNAVAILABLE', message: 'The platform is not answering. Nothing was changed; try again later.' });
      }
    }
    return new ServiceUnavailableException({ code: 'PLATFORM_UNAVAILABLE', message: 'The platform could not be reached.' });
  }
  private async handleAuth(e: unknown, a: { id: string; platform: string }) {
    if (e instanceof SocialApiError && e.kind === 'auth') {
      const row = await this.prisma.socialAccount.findUnique({ where: { id: a.id } });
      if (row) await this.accounts.needsReconnect(row, 'The platform rejected the authorization. Reconnect the account.');
    }
    return this.map(e, a);
  }
  private requireFeature(key: FeatureKey, f: FeatureResult) {
    if (f.state === 'UNSUPPORTED' || f.state === 'NOT_IMPLEMENTED') throw new HttpException({ code: 'UNSUPPORTED_OPERATION', message: f.note }, HttpStatus.NOT_IMPLEMENTED);
    if (f.state === 'PERMISSION_MISSING') throw new ConflictException({ code: 'PERMISSION_MISSING', message: `Reconnect the account and grant: ${f.missingScopes.join(', ')}`, missingScopes: f.missingScopes });
    if (!USABLE.has(f.state)) throw new ConflictException({ code: 'UNSUPPORTED_OPERATION', message: key });
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  /** Reads the comments of one published post of this business and stores the new ones. */
  async syncComments(tenant: TenantContext, publicationId: string) {
    if (!this.env.SOCIAL_COMMENTS_ENABLED) throw new HttpException({ code: 'FEATURE_DISABLED', message: 'Reading comments is switched off on this server' }, HttpStatus.FORBIDDEN);
    const pub = await this.prisma.publication.findFirst({ where: { id: publicationId, businessId: tenant.businessId } });
    if (!pub) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' });
    if (pub.status !== 'PUBLISHED' || !pub.externalPostId) throw new ConflictException({ code: 'NOT_PUBLISHED', message: 'Only a published post has comments to read' });
    const account = await this.accounts.get(tenant, pub.socialAccountId);
    this.requireFeature('commentsRead', this.featuresOf(account).commentsRead);
    let auth;
    try {
      auth = (await this.accounts.authorized(tenant.businessId, account.id)).auth;
    } catch (e) {
      throw this.map(e, account);
    }
    const adapter = this.adapter(account.platform);
    const fetched: Array<{ externalId: string; parentExternalId: string | null; authorExternalId: string | null; authorName: string | null; body: string; postedAt: Date | null; isFromBusiness: boolean }> = [];
    try {
      let cursor: string | null = null;
      for (let i = 0; i < 5; i++) {
        const page = await adapter.fetchComments!(auth, pub.externalPostId, { cursor, limit: 50 });
        fetched.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } catch (e) {
      throw await this.handleAuth(e, account);
    }
    const res = await this.prisma.comment.createMany({
      data: fetched.map((c) => ({ businessId: tenant.businessId, socialAccountId: account.id, publicationId: pub.id, externalCommentId: c.externalId, authorExternalId: c.authorExternalId, authorName: c.authorName, body: c.body.slice(0, 4000), isFromBusiness: c.isFromBusiness, postedAt: c.postedAt })),
      skipDuplicates: true,
    });
    for (const c of fetched.filter((x) => x.parentExternalId)) {
      const parent = await this.prisma.comment.findUnique({ where: { socialAccountId_externalCommentId: { socialAccountId: account.id, externalCommentId: c.parentExternalId! } }, select: { id: true } });
      if (parent) await this.prisma.comment.updateMany({ where: { socialAccountId: account.id, externalCommentId: c.externalId, parentId: null }, data: { parentId: parent.id } });
    }
    await this.prisma.socialAccount.update({ where: { id: account.id }, data: { lastSyncedAt: new Date() } });
    await this.audit.record({ action: 'social.comments_synced', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Publication', entityId: pub.id, metadata: { fetched: fetched.length, added: res.count } });
    return { fetched: fetched.length, added: res.count };
  }

  async list(tenant: TenantContext, q: { publicationId?: string; page: number; pageSize: number }) {
    const where: Prisma.CommentWhereInput = { businessId: tenant.businessId, ...(q.publicationId ? { publicationId: q.publicationId } : {}), NOT: { externalCommentId: { startsWith: 'pending:' } } };
    const [total, rows] = await Promise.all([
      this.prisma.comment.count({ where }),
      this.prisma.comment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((c) => ({ id: c.id, publicationId: c.publicationId, parentId: c.parentId, authorName: c.authorName, body: c.body, isFromBusiness: c.isFromBusiness, replyStatus: c.externalCommentId.startsWith('unknown:') ? 'OUTCOME_UNKNOWN' : null, postedAt: c.postedAt?.toISOString() ?? null })) };
  }

  // ─── Replying ───────────────────────────────────────────────────────────────

  /** AUTO only when the agent is on, set to answer without review, and the merchant authorized it; PAUSED when the agent is off. */
  async replyMode(businessId: string): Promise<ReplyMode> {
    const cfg = await this.prisma.salesAgentConfig.findUnique({ where: { businessId } });
    if (!cfg || !cfg.enabled) return 'PAUSED';
    return cfg.replyMode === 'AUTO' && cfg.autoReplyAuthorizedAt ? 'AUTO' : 'MANUAL';
  }

  /** A person answers a comment (an explicit human action: allowed in every mode). */
  reply(tenant: TenantContext, commentId: string, text: string) {
    return this.send(tenant, commentId, text, 'HUMAN');
  }
  /** The entry point for the automatic customer-service agent: refused unless the merchant's mode is AUTO. */
  autoReply(tenant: TenantContext, commentId: string, text: string) {
    return this.send(tenant, commentId, text, 'AUTO');
  }

  private async send(tenant: TenantContext, commentId: string, raw: string, by: 'HUMAN' | 'AUTO') {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || text.length > REPLY_MAX) throw new HttpException({ code: 'INVALID_REPLY', message: `A reply has 1 to ${REPLY_MAX} characters` }, HttpStatus.BAD_REQUEST);
    if (!this.env.SOCIAL_COMMENT_REPLIES_ENABLED) throw new HttpException({ code: 'FEATURE_DISABLED', message: 'Replying to comments is switched off on this server' }, HttpStatus.FORBIDDEN);
    const comment = await this.prisma.comment.findFirst({ where: { id: commentId, businessId: tenant.businessId } });
    if (!comment || comment.externalCommentId.startsWith('pending:') || comment.externalCommentId.startsWith('unknown:')) throw new NotFoundException({ code: 'COMMENT_NOT_FOUND', message: 'Comment not found' });
    if (comment.isFromBusiness) throw new ConflictException({ code: 'OWN_COMMENT', message: 'This comment was written by the business itself' });
    const mode = await this.replyMode(tenant.businessId);
    if (by === 'AUTO' && mode !== 'AUTO') {
      await this.audit.record({ action: 'social.auto_reply_refused', actorId: null, businessId: tenant.businessId, entityType: 'Comment', entityId: comment.id, metadata: { mode } });
      throw new ConflictException({ code: 'AUTO_NOT_ENABLED', message: `Automatic replies are off (mode ${mode}). Nothing was sent.`, mode });
    }
    const account = await this.accounts.get(tenant, comment.socialAccountId);
    this.requireFeature('commentsReply', this.featuresOf(account).commentsReply);
    let auth;
    try {
      auth = (await this.accounts.authorized(tenant.businessId, account.id)).auth;
    } catch (e) {
      throw this.map(e, account);
    }
    const since = new Date(Date.now() - 24 * 3_600_000);
    const sent = await this.prisma.comment.count({ where: { businessId: tenant.businessId, isFromBusiness: true, parentId: { not: null }, createdAt: { gte: since } } });
    if (sent >= this.env.SOCIAL_MAX_REPLIES_PER_DAY) throw new HttpException({ code: 'REPLY_LIMIT', message: `The daily limit of ${this.env.SOCIAL_MAX_REPLIES_PER_DAY} replies was reached for this business` }, HttpStatus.TOO_MANY_REQUESTS);
    if (await this.prisma.comment.count({ where: { parentId: comment.id, isFromBusiness: true } })) throw new ConflictException({ code: 'ALREADY_REPLIED', message: 'This comment already has a reply from the business' });

    // The intent is recorded before anything is sent: a deterministic key makes a second attempt (retry, double click) fail instead of posting twice.
    let pending;
    try {
      pending = await this.prisma.comment.create({ data: { businessId: tenant.businessId, socialAccountId: account.id, publicationId: comment.publicationId, parentId: comment.id, externalCommentId: `pending:${comment.id}`, authorName: null, body: text, isFromBusiness: true, approvalStatus: 'PENDING' } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'REPLY_IN_PROGRESS', message: 'A reply to this comment is already being sent or was sent' });
      throw e;
    }
    // Last check before the request: the merchant may have paused the agent or switched the account's replies off a moment ago.
    if (by === 'AUTO' && (await this.replyMode(tenant.businessId)) !== 'AUTO') {
      await this.prisma.comment.delete({ where: { id: pending.id } });
      throw new ConflictException({ code: 'AUTO_NOT_ENABLED', message: 'Automatic replies were switched off. Nothing was sent.' });
    }
    try {
      const out = await this.adapter(account.platform).replyToComment!(auth, comment.externalCommentId, text);
      await this.prisma.comment.update({ where: { id: pending.id }, data: { externalCommentId: out.externalId, postedAt: new Date(), approvalStatus: by === 'HUMAN' ? 'APPROVED' : 'NOT_REQUIRED' } });
      await this.audit.record({ action: 'social.comment_replied', actorId: by === 'HUMAN' ? tenant.userId : null, businessId: tenant.businessId, entityType: 'Comment', entityId: comment.id, metadata: { by, simulated: this.simulated, platform: account.platform } });
      return { id: pending.id, status: 'SENT' as const, simulated: this.simulated, by };
    } catch (e) {
      if (e instanceof SocialApiError && e.opts.outcome === 'unknown') {
        // The reply may be live: never sent again automatically; a person checks the platform.
        await this.prisma.comment.update({ where: { id: pending.id }, data: { externalCommentId: `unknown:${comment.id}`, approvalStatus: 'REJECTED' } });
        await this.audit.record({ action: 'social.comment_reply_unknown', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'Comment', entityId: comment.id, metadata: { by } });
        throw new HttpException({ code: 'REPLY_OUTCOME_UNKNOWN', message: 'The platform did not confirm the reply. It may have been posted: check the platform before trying again.' }, HttpStatus.BAD_GATEWAY);
      }
      await this.prisma.comment.delete({ where: { id: pending.id } }); // refused: nothing was posted, a retry is safe
      throw await this.handleAuth(e, account);
    }
  }
}
