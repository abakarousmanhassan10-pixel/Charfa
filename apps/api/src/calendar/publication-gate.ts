import { Injectable } from '@nestjs/common';
import { roleHasPermission } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { snapshotHash } from './approval-snapshot';

export type GateResult = { ok: true } | { ok: false; code: string; message: string; /** true: nothing is wrong with the entry, publishing is just not allowed right now */ blocked?: boolean; /** the person who authorized lost the right to */ revoked?: boolean };

/**
 * The single authorization gate in front of every publication attempt (Phase N18). It is called before the entry is handed to
 * the publisher and again, from the publisher, immediately before the platform request. It never contacts a platform.
 * A refusal is final for this attempt: the caller records the code and stops.
 */
@Injectable()
export class PublicationGate {
  constructor(private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv) {}

  async check(args: { businessId: string; entryId: string; expectedAccountId?: string | null; excludePublicationId?: string; allowPublishing?: boolean }): Promise<GateResult> {
    const no = (code: string, message: string, blocked = false, revoked = false): GateResult => ({ ok: false, code, message, blocked, revoked });
    if (!this.env.SOCIAL_PUBLISHING_ENABLED) return no('PUBLISHING_DISABLED', 'Publishing to social platforms is switched off on this server', true);
    // Tenant: the entry is read through the business id of the request, never through the entry id alone.
    const e = await this.prisma.calendarEvent.findFirst({ where: { id: args.entryId, businessId: args.businessId }, include: { content: { include: { media: { select: { mediaId: true }, orderBy: { position: 'asc' } } } } } });
    if (!e || e.deletedAt || e.status === 'CANCELLED' || !e.content) return no('ACCOUNT_NOT_AUTHORIZED', 'The calendar entry was cancelled or deleted');
    const c = e.content;
    const okStatus = c.status === 'SCHEDULED' || (args.allowPublishing && c.status === 'PUBLISHING');
    if (!okStatus || c.approvedVersion !== c.version || e.authorizedVersion !== c.version || !e.authorizedById || !e.authorizedHash || !e.platform) {
      return no('CONTENT_INVALID', 'The content changed or its approval or authorization was withdrawn after it was scheduled. It was not published.');
    }
    // The approval must still describe exactly what would be sent.
    const hash = snapshotHash({ contentId: c.id, version: c.version, type: c.type, title: c.title, caption: c.caption, hashtags: c.hashtags, callToAction: c.callToAction, platformOptions: c.platformOptions, mediaIds: c.media.map((m) => m.mediaId), platform: e.platform, socialAccountId: e.authorizedAccountId, scheduledAt: e.scheduledAt, timezone: e.timezone });
    if (hash !== e.authorizedHash) return no('APPROVAL_MISMATCH', 'What was approved (content, media, account or time) no longer matches what would be published. It was not published.');
    // Target account: the approved one, in this business, connected.
    if (!e.authorizedAccountId) {
      // Nothing was approved. Say why in the terms the person can act on.
      const connected = await this.prisma.socialAccount.count({ where: { businessId: args.businessId, platform: e.platform, status: 'CONNECTED', deletedAt: null } });
      if (connected === 0) return no('ACCOUNT_NOT_CONNECTED', 'No connected account for this platform. Connect one, then authorize the publication again.');
      if (connected > 1) return no('ACCOUNT_SELECTION_REQUIRED', 'Several accounts are connected for this platform and none was chosen for this entry. Choose one, then authorize again.');
      return no('ACCOUNT_NOT_AUTHORIZED', 'An account was connected after this publication was authorized, so none was approved. Authorize it again.');
    }
    if (args.expectedAccountId !== undefined && args.expectedAccountId !== null && args.expectedAccountId !== e.authorizedAccountId) return no('ACCOUNT_NOT_AUTHORIZED', 'The account is not the one that was approved. It was not published.');
    const account = await this.prisma.socialAccount.findFirst({ where: { id: e.authorizedAccountId, businessId: args.businessId, platform: e.platform, deletedAt: null } });
    if (!account) return no('ACCOUNT_NOT_AUTHORIZED', 'The approved account no longer exists in this business');
    if (['TOKEN_EXPIRED', 'PERMISSION_MISSING', 'DISCONNECTED'].includes(account.status)) return no(account.status === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'ACCOUNT_NOT_CONNECTED', 'The approved account is not connected (authorization expired or revoked). Reconnect it, then retry.');
    // The person who authorized must still be allowed to.
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: e.authorizedById, businessId: args.businessId } } });
    if (!m || m.status !== 'ACTIVE' || !roleHasPermission(m.role, 'publication.schedule')) return no('ACCOUNT_NOT_AUTHORIZED', 'The person who authorized this publication is no longer allowed to schedule publications', false, true);
    // Resource limit per business.
    const since = new Date(Date.now() - 24 * 3_600_000);
    const recent = await this.prisma.publication.count({ where: { businessId: args.businessId, createdAt: { gte: since }, status: { not: 'CANCELLED' }, ...(args.excludePublicationId ? { id: { not: args.excludePublicationId } } : {}) } });
    if (recent >= this.env.SOCIAL_MAX_PUBLICATIONS_PER_DAY) return no('PUBLICATION_LIMIT', `The daily limit of ${this.env.SOCIAL_MAX_PUBLICATIONS_PER_DAY} publications was reached for this business`);
    return { ok: true };
  }
}
