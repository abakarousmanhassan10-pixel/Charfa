import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { emails, EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthTokensService } from './auth-tokens.service';
import { PasswordService } from './password.service';

const RESEND_COOLDOWN_MS = 60_000;

/** Email verification and password reset. Responses never reveal whether an email is registered. */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokensService,
    private readonly email: EmailService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /** Sends a verification email. Delivery failures are logged, never fatal for registration. */
  async sendVerification(user: { id: string; email: string; locale: string }, meta: RequestMeta) {
    const token = await this.tokens.issue(user.id, 'EMAIL_VERIFICATION', user.email, meta.ipAddress);
    try {
      await this.email.send(emails.verification(user.email, user.locale, this.email.link('/verify-email', token)));
      await this.audit.record({ action: 'auth.verification_sent', actorId: user.id, ...meta });
    } catch (err) {
      this.logger.error(`Verification email to user ${user.id} failed: ${(err as Error).message}`);
    }
  }

  async resendVerification(userId: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) throw new BadRequestException({ code: 'ALREADY_VERIFIED', message: 'Your email is already verified' });
    const last = await this.tokens.lastIssuedAt(userId, 'EMAIL_VERIFICATION');
    if (last && Date.now() - last.getTime() < RESEND_COOLDOWN_MS) {
      throw new HttpException({ code: 'TOO_SOON', message: 'Please wait a minute before requesting another email' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.sendVerification(user, meta);
  }

  async verifyEmail(token: string, meta: RequestMeta) {
    const row = await this.tokens.consume(token, 'EMAIL_VERIFICATION');
    const invalid = () => new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' });
    if (!row) throw invalid();
    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    // The token is bound to the address it was sent to.
    if (!user || user.deletedAt || user.email.toLowerCase() !== row.email.toLowerCase()) throw invalid();
    if (!user.emailVerifiedAt) await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await this.audit.record({ action: 'auth.email_verified', actorId: user.id, ...meta });
    return { verified: true };
  }

  async forgotPassword(email: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    await this.audit.record({ action: 'auth.password_reset_requested', actorId: user?.id ?? null, ...meta, metadata: { known: Boolean(user) } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE') return;
    const last = await this.tokens.lastIssuedAt(user.id, 'PASSWORD_RESET');
    if (last && Date.now() - last.getTime() < RESEND_COOLDOWN_MS) return; // silent cooldown (no enumeration)
    const token = await this.tokens.issue(user.id, 'PASSWORD_RESET', user.email, meta.ipAddress);
    try {
      await this.email.send(emails.passwordReset(user.email, user.locale, this.email.link('/reset-password', token)));
    } catch (err) {
      this.logger.error(`Password reset email to user ${user.id} failed: ${(err as Error).message}`);
    }
  }

  /** Sets the new password, unlocks the account, revokes every session and notifies the user. */
  async resetPassword(token: string, newPassword: string, meta: RequestMeta) {
    const row = await this.tokens.consume(token, 'PASSWORD_RESET');
    const user = row ? await this.prisma.user.findUnique({ where: { id: row.userId } }) : null;
    if (!row || !user || user.deletedAt || user.status !== 'ACTIVE' || user.email.toLowerCase() !== row.email.toLowerCase()) {
      throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await this.passwords.hash(newPassword),
          failedLoginCount: 0,
          lockedUntil: null,
          // Receiving the reset email proves control of the address.
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      }),
      this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.authToken.updateMany({ where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null }, data: { expiresAt: new Date() } }),
    ]);
    await this.audit.record({ action: 'auth.password_reset', actorId: user.id, ...meta });
    await this.email.send(emails.passwordChanged(user.email, user.locale)).catch((err) => this.logger.error(`Password-changed notice failed: ${(err as Error).message}`));
  }
}
