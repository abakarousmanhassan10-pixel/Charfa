import { Injectable } from '@nestjs/common';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/** Founder = an OWNER of the business whose VERIFIED, active account e-mail is on the server allow-list (FOUNDER_EMAILS). */
@Injectable()
export class FounderService {
  constructor(private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv) {}

  async isFounder(businessId: string): Promise<boolean> {
    if (this.env.FOUNDER_EMAILS.length === 0) return false;
    const owners = await this.prisma.membership.findMany({ where: { businessId, role: 'OWNER', status: 'ACTIVE', user: { status: 'ACTIVE', emailVerifiedAt: { not: null }, deletedAt: null } }, select: { user: { select: { email: true } } } });
    return owners.some((o) => this.env.FOUNDER_EMAILS.includes(o.user.email.toLowerCase()));
  }
}
