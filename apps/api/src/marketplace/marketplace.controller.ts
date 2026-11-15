import { BadRequestException, CanActivate, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AGENT_CATEGORIES } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { MarketplaceService } from './marketplace.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
/** Feature flag: the marketplace endpoints do not exist (404) unless MARKETPLACE_ENABLED=true. */
@Injectable()
export class MarketplaceEnabledGuard implements CanActivate {
  constructor(@InjectEnv() private readonly env: AppEnv) {}
  canActivate(): boolean { if (!this.env.MARKETPLACE_ENABLED) throw new NotFoundException({ code: 'FEATURE_DISABLED', message: 'Not found' }); return true; }
}
const catalogQuery = z.object({
  q: z.string().trim().max(80).optional(), category: z.enum(AGENT_CATEGORIES as unknown as [string, ...string[]]).optional(), pricing: z.enum(['FREE', 'PREMIUM']).optional(), model: z.string().max(100).optional(),
  sort: z.enum(['newest', 'name']).default('newest'), page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
const slug = z.string().min(3).max(80).regex(/^[a-z0-9-]+$/);
const rl = () => ({ default: { limit: Number(process.env.MARKETPLACE_RATE_LIMIT_PER_MINUTE ?? 60), ttl: 60_000 } });

/** Browsing the catalog needs a signed-in member of a business (`agents.read`); the catalog itself holds no client data. */
@ApiTags('marketplace')
@ApiBearerAuth()
@UseGuards(MarketplaceEnabledGuard)
@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly svc: MarketplaceService) {}
  @Get('catalog') @Throttle(rl()) @RequireTenantPermission('agents.read') catalog(@Query() q: Record<string, string>) { return this.svc.catalog(parse(catalogQuery, q)); }
  @Get('categories') @RequireTenantPermission('agents.read') categories() { return this.svc.categories(); }
  @Get('listings/:slug') @Throttle(rl()) @RequireTenantPermission('agents.read') detail(@Param('slug') s: string) { return this.svc.detail(parse(slug, s)); }
}

/** Platform administrators only. */
@ApiTags('admin-marketplace')
@ApiBearerAuth()
@UseGuards(MarketplaceEnabledGuard)
@RequirePlatformRole('SUPER_ADMIN')
@Controller('admin/marketplace')
export class MarketplaceAdminController {
  constructor(private readonly svc: MarketplaceService) {}
  @Post('demo-seed') @HttpCode(200) seed(@CurrentUser() u: AuthenticatedUser) { return this.svc.seedDemo(u.id); }
}
