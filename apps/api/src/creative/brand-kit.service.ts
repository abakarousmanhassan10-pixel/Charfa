import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@touma/database';
import { BRAND_COLOR_ROLES } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { UpdateBrandKitDto } from './brand-kit.dto';

export interface BrandColor {
  name: string;
  hex: string;
  role: string;
}

/** The brand identity of a business: colours, fonts, visual style, guidelines, preferred tone and logo. */
@Injectable()
export class BrandKitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  private async logoOf(businessId: string) {
    const b = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { logo: true, logoMediaId: true } });
    return b.logo && !b.logo.deletedAt && b.logo.status === 'READY' ? b.logo : null;
  }

  async get(tenant: TenantContext) {
    const [kit, logo] = await Promise.all([this.prisma.brandKit.findUnique({ where: { businessId: tenant.businessId } }), this.logoOf(tenant.businessId)]);
    return {
      configured: Boolean(kit) || Boolean(logo),
      colors: ((kit?.colors as unknown as BrandColor[] | null) ?? []) as BrandColor[],
      headingFont: kit?.headingFont ?? null,
      bodyFont: kit?.bodyFont ?? null,
      visualStyle: kit?.visualStyle ?? null,
      guidelines: kit?.guidelines ?? null,
      preferredTone: kit?.preferredTone ?? null,
      logo: logo ? this.media.toDto(logo) : null,
      updatedAt: kit?.updatedAt ?? null,
    };
  }

  /** The kit as the creative pipeline uses it (null when the business has no brand kit data at all). */
  async forPrompt(businessId: string) {
    const kit = await this.prisma.brandKit.findUnique({ where: { businessId } });
    if (!kit) return null;
    return {
      colors: ((kit.colors as unknown as BrandColor[] | null) ?? []) as BrandColor[],
      headingFont: kit.headingFont,
      bodyFont: kit.bodyFont,
      visualStyle: kit.visualStyle,
      guidelines: kit.guidelines,
      preferredTone: kit.preferredTone,
    };
  }

  async update(tenant: TenantContext, dto: UpdateBrandKitDto) {
    if (dto.colors) {
      const count = (role: string) => dto.colors!.filter((c) => c.role === role).length;
      const bad = BRAND_COLOR_ROLES.find((r) => count(r) > (r === 'ACCENT' ? 3 : 1));
      if (bad) throw new BadRequestException({ code: 'INVALID_BRAND_COLORS', message: bad === 'ACCENT' ? 'At most 3 accent colours' : `Only one ${bad.toLowerCase()} colour` });
    }
    if (dto.logoMediaId) await this.media.assertUsable(tenant.businessId, [dto.logoMediaId], 'IMAGE');

    const data: Prisma.BrandKitUncheckedUpdateInput = {
      ...(dto.colors !== undefined ? { colors: dto.colors.map((c) => ({ name: c.name.trim(), hex: c.hex.toUpperCase(), role: c.role })) as unknown as Prisma.InputJsonValue } : {}),
      ...(dto.headingFont !== undefined ? { headingFont: dto.headingFont } : {}),
      ...(dto.bodyFont !== undefined ? { bodyFont: dto.bodyFont } : {}),
      ...(dto.visualStyle !== undefined ? { visualStyle: dto.visualStyle } : {}),
      ...(dto.guidelines !== undefined ? { guidelines: dto.guidelines } : {}),
      ...(dto.preferredTone !== undefined ? { preferredTone: dto.preferredTone } : {}),
      updatedById: tenant.userId,
    };
    await this.prisma.brandKit.upsert({
      where: { businessId: tenant.businessId },
      create: { ...(data as Prisma.BrandKitUncheckedCreateInput), businessId: tenant.businessId, colors: (data.colors as Prisma.InputJsonValue | undefined) ?? [] },
      update: data,
    });
    if (dto.logoMediaId !== undefined) await this.prisma.business.update({ where: { id: tenant.businessId }, data: { logoMediaId: dto.logoMediaId } });
    await this.audit.record({ action: 'creative.brand_kit_updated', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'BrandKit', metadata: { fields: Object.keys(dto) } });
    return this.get(tenant);
  }
}
