import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { makeVariants, PLATFORM_ANALYTICS } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { RequireTenantPermission } from '../tenancy/business-access.guard';
import { Tenant, type TenantContext } from '../tenancy/tenant-context';
import { seedHistory } from './demo-history';
import { LearningEnabledGuard } from './learning.guard';
import { LearningProfileService } from './learning-profile.service';
import { PerformanceService } from './performance.service';
import { PreferencesService } from './preferences.service';
import { RecommendService } from './recommend.service';

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') });
  return r.data;
}
const perfQuery = z.object({ platform: z.enum(['INSTAGRAM', 'TIKTOK', 'YOUTUBE']).optional(), days: z.coerce.number().int().min(1).max(365).optional(), weeks: z.coerce.number().int().min(1).max(52).optional() });
const idParam = z.string().min(1).max(190);
const consentBody = z.object({ accept: z.literal(true), consentVersion: z.string().max(30) }).strict();
const settingsBody = z.object({ enabled: z.boolean().optional(), autoPlan: z.boolean().optional(), maxRunsPerDay: z.number().int().min(1).max(24).optional() }).strict();
const prefBody = z.object({ value: z.unknown(), reason: z.string().max(300).optional() }).strict();
const rejectPref = z.object({ origin: z.enum(['INFERRED', 'HYPOTHESIS']) }).strict();
const decideBody = z.object({ decision: z.enum(['ACCEPT', 'REJECT']), reason: z.string().max(300).optional() }).strict();
const feedbackBody = z.object({ decision: z.enum(['USEFUL', 'NOT_USEFUL']), reason: z.string().max(300).optional() }).strict();
const variantBody = z.object({ title: z.string().trim().min(1).max(120), caption: z.string().trim().min(1).max(2200), hashtags: z.array(z.string().max(60)).max(30).default([]) }).strict();
export const rl = () => ({ default: { limit: Number(process.env.LEARNING_RATE_LIMIT_PER_MINUTE ?? 30), ttl: 60_000 } });

/** Adaptive learning (N22). Off by default (404). Reading needs `learning.read`; collecting, consent, settings and applying changes need `learning.manage`. */
@ApiTags('learning')
@ApiBearerAuth()
@UseGuards(LearningEnabledGuard)
@Controller('learning')
export class LearningController {
  constructor(private readonly perf: PerformanceService, private readonly prisma: PrismaService, private readonly profile: LearningProfileService, private readonly prefs: PreferencesService, private readonly recs: RecommendService, @InjectEnv() private readonly env: AppEnv) {}

  @Get('analytics-capabilities') @RequireTenantPermission('learning.read')
  capabilities() { return { platforms: PLATFORM_ANALYTICS, provider: this.env.ANALYTICS_PROVIDER, simulated: this.env.ANALYTICS_PROVIDER === 'mock', maturityHours: this.env.ANALYTICS_MATURITY_HOURS, note: 'Statements about the platforms come from official documentation read by TOUMA; none was tested against a real account. A metric a platform does not give stays null.' }; }

  @Get('performance') @RequireTenantPermission('learning.read')
  report(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { const p = parse(perfQuery, q); return this.perf.report(t.businessId, p); }
  @Get('performance/posts') @RequireTenantPermission('learning.read')
  posts(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { const p = parse(perfQuery, q); return this.perf.posts(t.businessId, p); }
  @Get('performance/series') @RequireTenantPermission('learning.read')
  series(@Tenant() t: TenantContext, @Query() q: Record<string, string>) { const p = parse(perfQuery, q); return this.perf.series(t.businessId, p); }

  @Post('performance/collect') @HttpCode(200) @Throttle(rl()) @RequireTenantPermission('learning.manage')
  collect(@Tenant() t: TenantContext) { return this.perf.collect(t.businessId); }

  /** Fictitious history (30 simulated posts) for the demo. Only available with the simulated analytics provider, which exists in tests only. */
  @Post('demo/history') @HttpCode(201) @RequireTenantPermission('learning.manage')
  async demo(@Tenant() t: TenantContext) {
    if (this.env.ANALYTICS_PROVIDER !== 'mock') throw new ForbiddenException({ code: 'DEMO_DISABLED', message: 'Demo data is available only with the simulated analytics provider' });
    const account = await this.prisma.socialAccount.findFirst({ where: { businessId: t.businessId, platform: 'INSTAGRAM', status: 'CONNECTED', deletedAt: null } });
    if (!account) throw new BadRequestException({ code: 'NO_ACCOUNT', message: 'Connect an Instagram account first' });
    const ids = await seedHistory(this.prisma, { businessId: t.businessId, socialAccountId: account.id, platform: 'INSTAGRAM' });
    return { created: ids.length, simulated: true };
  }

  // ─── Consent and settings ──────────────────────────────────────────────
  @Get('profile') @RequireTenantPermission('learning.read') getProfile(@Tenant() t: TenantContext) { return this.profile.get(t.businessId); }
  @Post('consent') @HttpCode(200) @RequireTenantPermission('learning.manage') consent(@Tenant() t: TenantContext, @Body() b: unknown) { return this.profile.consent(t, parse(consentBody, b).consentVersion); }
  @Post('consent/revoke') @HttpCode(200) @RequireTenantPermission('learning.manage') revoke(@Tenant() t: TenantContext) { return this.profile.revoke(t); }
  @Put('settings') @RequireTenantPermission('learning.manage') settings(@Tenant() t: TenantContext, @Body() b: unknown) { return this.profile.update(t, parse(settingsBody, b)); }

  // ─── Preferences: declared, inferred, hypotheses ───────────────────────
  @Get('preferences') @RequireTenantPermission('learning.read') preferences(@Tenant() t: TenantContext) { return this.prefs.list(t.businessId); }
  @Get('preferences/export') @RequireTenantPermission('learning.read') exportPrefs(@Tenant() t: TenantContext) { return this.prefs.export(t.businessId); }
  @Get('preferences/revisions') @RequireTenantPermission('learning.read') revisions(@Tenant() t: TenantContext, @Query('key') key?: string) { return this.prefs.revisions(t.businessId, key ? parse(idParam, key) : undefined); }
  @Put('preferences/:key') @RequireTenantPermission('learning.manage') setPref(@Tenant() t: TenantContext, @Param('key') key: string, @Body() b: unknown) { const p = parse(prefBody, b); return this.prefs.setDeclared(t, parse(idParam, key), p.value, p.reason); }
  @Post('preferences/:key/confirm') @HttpCode(200) @RequireTenantPermission('learning.manage') confirmPref(@Tenant() t: TenantContext, @Param('key') key: string) { return this.prefs.confirm(t, parse(idParam, key)); }
  @Post('preferences/:key/reject') @HttpCode(200) @RequireTenantPermission('learning.manage') rejectPref(@Tenant() t: TenantContext, @Param('key') key: string, @Body() b: unknown) { return this.prefs.reject(t, parse(idParam, key), parse(rejectPref, b).origin); }
  @Delete('preferences/:key') @RequireTenantPermission('learning.manage') erasePref(@Tenant() t: TenantContext, @Param('key') key: string) { return this.prefs.erase(t, parse(idParam, key)); }
  @Delete('preferences') @RequireTenantPermission('learning.manage') eraseAll(@Tenant() t: TenantContext) { return this.prefs.erase(t); }

  // ─── Recommendations ───────────────────────────────────────────────────
  @Get('recommendations') @RequireTenantPermission('learning.read') recommendations(@Tenant() t: TenantContext, @Query('status') status?: string) { return this.recs.list(t.businessId, status); }
  @Post('recommendations/generate') @HttpCode(200) @Throttle(rl()) @RequireTenantPermission('learning.manage')
  async generate(@Tenant() t: TenantContext) { await this.profile.assertActive(t.businessId); const { results: _r, ...summary } = await this.recs.generate(t.businessId, null); void _r; return summary; }
  @Post('recommendations/:id/decision') @HttpCode(200) @RequireTenantPermission('learning.manage') decide(@Tenant() t: TenantContext, @Param('id') id: string, @Body() b: unknown) { const d = parse(decideBody, b); return this.recs.decide(t, parse(idParam, id), d.decision, d.reason); }
  @Post('recommendations/:id/feedback') @HttpCode(200) @RequireTenantPermission('learning.read') feedback(@Tenant() t: TenantContext, @Param('id') id: string, @Body() b: unknown) { const d = parse(feedbackBody, b); return this.recs.feedback(t, parse(idParam, id), d.decision, d.reason); }

  /** Two variants of a post that differ in one element, built from templates (no AI call). They are only returned: nothing is created or published. */
  @Post('variants') @HttpCode(200) @RequireTenantPermission('learning.read')
  async variants(@Tenant() t: TenantContext, @Body() b: unknown) {
    const base = parse(variantBody, b);
    const eff = await this.prefs.effective(t.businessId);
    try { return makeVariants(base, { language: (eff.language?.value as string) ?? 'en', restrictions: (eff['editorial.restrictions']?.value as string[]) ?? [] }); } catch (e) { throw new BadRequestException({ code: 'RESTRICTED_CONTENT', message: (e as Error).message }); }
  }
}
