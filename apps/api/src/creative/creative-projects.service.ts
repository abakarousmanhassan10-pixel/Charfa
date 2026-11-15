import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import type { ScriptProvider } from '@touma/creative';
import { classifyPublication, DEFAULT_HOURS, roleHasPermission, type ContentKind } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { SCRIPT_PROVIDER } from './creative-providers';

export interface Brief { kind: 'IMAGE' | 'VIDEO'; description: string; aspectRatio: '1:1' | '4:5' | '9:16' | '16:9'; style: string; platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'; language: 'en' | 'fr' }
const nf = (m: string, c = 'NOT_FOUND') => new NotFoundException({ code: c, message: m });

/**
 * Studio projects (free test mode): the brief, a template script, the caption, which creation is kept, and a FICTITIOUS scheduling decision. The workflow is
 * brief -> script -> visuals (generations) -> preview -> caption -> permission check -> simulated scheduling. It never creates a calendar entry or a publication.
 */
@Injectable()
export class CreativeProjectsService {
  constructor(private readonly prisma: PrismaService, private readonly media: MediaService, private readonly audit: AuditService, @Inject(SCRIPT_PROVIDER) private readonly script: ScriptProvider | null) {}

  private async find(t: TenantContext, id: string) {
    const p = await this.prisma.creativeProject.findFirst({ where: { id, businessId: t.businessId, deletedAt: null } });
    if (!p) throw nf('Project not found');
    return p;
  }
  private view(p: Awaited<ReturnType<CreativeProjectsService['find']>>) {
    return { id: p.id, name: p.name, brief: p.brief, status: p.status, script: p.script, caption: p.caption, activeGenerationId: p.activeGenerationId, scheduleSim: p.scheduleSim, createdAt: p.createdAt, updatedAt: p.updatedAt };
  }

  async create(t: TenantContext, dto: { name: string; brief: Brief }) {
    const p = await this.prisma.creativeProject.create({ data: { businessId: t.businessId, name: dto.name, brief: dto.brief as unknown as Prisma.InputJsonObject, createdById: t.userId } });
    await this.audit.record({ action: 'creative.project_created', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeProject', entityId: p.id });
    return this.view(p);
  }

  async list(t: TenantContext) {
    const rows = await this.prisma.creativeProject.findMany({ where: { businessId: t.businessId, deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 100 });
    const counts = await this.prisma.creativeGeneration.groupBy({ by: ['projectId'], where: { businessId: t.businessId, projectId: { in: rows.map((r) => r.id) }, status: 'SUCCEEDED' }, _count: { _all: true } });
    return rows.map((r) => ({ ...this.view(r), creations: counts.find((c) => c.projectId === r.id)?._count._all ?? 0 }));
  }

  async get(t: TenantContext, id: string) {
    const p = await this.find(t, id);
    const gens = await this.prisma.creativeGeneration.findMany({ where: { businessId: t.businessId, projectId: id }, orderBy: { createdAt: 'desc' }, include: { outputs: { include: { media: true }, orderBy: { index: 'asc' } } }, take: 50 });
    return { ...this.view(p), generations: gens.map((g) => ({ id: g.id, kind: g.kind, status: g.status, provider: g.provider, simulated: ['mock', 'fake'].includes(g.provider), createdAt: g.createdAt, errorCode: g.errorCode, outputs: g.outputs.map((o) => ({ id: o.id, width: o.width, height: o.height, media: this.media.toDto(o.media) })) })) };
  }

  async update(t: TenantContext, id: string, dto: { name?: string; brief?: Brief; caption?: string }) {
    await this.find(t, id);
    const p = await this.prisma.creativeProject.update({ where: { id }, data: { ...(dto.name ? { name: dto.name } : {}), ...(dto.brief ? { brief: dto.brief as unknown as Prisma.InputJsonObject } : {}), ...(dto.caption !== undefined ? { caption: dto.caption } : {}) } });
    return this.view(p);
  }

  /** Deleting a project does not delete its media: the library keeps every creation until it is deleted there. */
  async remove(t: TenantContext, id: string) {
    await this.find(t, id);
    await this.prisma.creativeProject.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.prisma.creativeGeneration.updateMany({ where: { businessId: t.businessId, projectId: id }, data: { projectId: null } });
    await this.audit.record({ action: 'creative.project_deleted', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeProject', entityId: id });
  }

  /** Prepares the script and the caption from the brief with the template provider (free test mode only). The script says it is simulated. */
  async prepareScript(t: TenantContext, id: string) {
    if (!this.script) throw new ServiceUnavailableException({ code: 'SCRIPT_NOT_CONFIGURED', message: 'Script preparation is available in the free test mode only (CREATIVE_STUDIO_MODE=mock)' });
    const p = await this.find(t, id);
    const brief = p.brief as unknown as Brief;
    const biz = await this.prisma.business.findUnique({ where: { id: t.businessId }, select: { name: true } });
    const s = await this.script.generate({ brief: brief.description, language: brief.language ?? 'en', seconds: brief.kind === 'VIDEO' ? 8 : 6, style: brief.style, brandName: biz?.name });
    const u = await this.prisma.creativeProject.update({ where: { id }, data: { script: s as unknown as Prisma.InputJsonObject, caption: s.caption, status: p.status === 'DRAFT' ? 'SCRIPTED' : p.status } });
    return this.view(u);
  }

  /** Goes back to a previous creation of this project: the project keeps it as its current one. Nothing is deleted and no quota is used. */
  async restore(t: TenantContext, id: string, generationId: string) {
    await this.find(t, id);
    const g = await this.prisma.creativeGeneration.findFirst({ where: { id: generationId, businessId: t.businessId, projectId: id, status: 'SUCCEEDED' } });
    if (!g) throw nf('That creation does not belong to this project', 'GENERATION_NOT_IN_PROJECT');
    const u = await this.prisma.creativeProject.update({ where: { id }, data: { activeGenerationId: g.id, status: 'READY' } });
    return this.view(u);
  }

  /**
   * FICTITIOUS scheduling: checks the person's right to schedule, the project's readiness and the publishing policy (AUTO / HYBRID / MANUAL, never looser than the
   * account's policy), classifies the caption with the same rules as the real engine, and records the decision it WOULD take. Nothing is scheduled or published and the
   * media is a simulated demo file that can never be published.
   */
  async scheduleSim(t: TenantContext, id: string, dto: { platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'; scheduledAt: string; mode?: 'AUTO' | 'HYBRID' | 'MANUAL' }) {
    const p = await this.find(t, id);
    const when = new Date(dto.scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) throw new BadRequestException({ code: 'INVALID_TIME', message: 'Choose a time in the future' });
    const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
    const canSchedule = roleHasPermission(t.role, 'publication.schedule');
    checks.push({ check: 'ROLE_CAN_SCHEDULE', ok: canSchedule, detail: canSchedule ? 'Your role may schedule publications' : 'Your role may not schedule publications' });
    const gen = p.activeGenerationId ? await this.prisma.creativeGeneration.findFirst({ where: { id: p.activeGenerationId, businessId: t.businessId, status: 'SUCCEEDED' }, include: { outputs: true } }) : null;
    checks.push({ check: 'CREATION_SELECTED', ok: Boolean(gen?.outputs.length), detail: gen?.outputs.length ? 'A delivered creation is selected' : 'Select a delivered creation first' });
    checks.push({ check: 'CAPTION_READY', ok: Boolean(p.caption?.trim()), detail: p.caption?.trim() ? 'A caption is ready' : 'Prepare a caption first' });
    const account = await this.prisma.socialAccount.findFirst({ where: { businessId: t.businessId, platform: dto.platform, deletedAt: null }, include: { publishingPolicy: true } });
    const pol = account?.publishingPolicy;
    const policyActive = !!pol && pol.automationEnabled && !pol.pausedAt && !pol.consentRevokedAt && !!pol.consentGrantedAt && pol.mode !== 'MANUAL';
    checks.push({ check: 'ACCOUNT_CONNECTED', ok: account?.status === 'CONNECTED', detail: account ? `Account status: ${account.status}` : 'No account is connected for this platform (the simulation continues; a real schedule would need one)' });
    checks.push({ check: 'AUTOMATION_CONSENT', ok: policyActive, detail: policyActive ? `The account policy is ${pol!.mode}` : 'No active automation consent: posts would wait for a person' });
    const requested = dto.mode ?? 'HYBRID';
    // Never looser than the account policy: the effective mode is the stricter of the request and the policy (MANUAL < HYBRID < AUTO).
    const rank = { MANUAL: 0, HYBRID: 1, AUTO: 2 } as const;
    const policyMode = policyActive ? pol!.mode : 'MANUAL';
    const mode = rank[requested] <= rank[policyMode] ? requested : policyMode;
    const kind = (gen?.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE') as ContentKind;
    const cls = classifyPublication({ mode, platform: dto.platform, contentKind: kind, title: p.name, caption: p.caption, hashtags: (p.script as { hashtags?: string[] } | null)?.hashtags ?? [], allowedContentTypes: ['IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT'], scheduledAt: when, timezone: pol?.timezone ?? 'UTC', hours: DEFAULT_HOURS, postsThatDay: 0, maxPostsPerDay: pol?.maximumPostsPerDay ?? 3, platformConfirmationMissing: false });
    const blockedByChecks = !canSchedule || !gen?.outputs.length || !p.caption?.trim();
    const outcome = blockedByChecks || cls.risk === 'BLOCKED' ? 'BLOCKED' : cls.risk === 'REVIEW_REQUIRED' || mode === 'MANUAL' ? 'WOULD_WAIT_FOR_APPROVAL' : 'WOULD_AUTO_SCHEDULE';
    const sim = { simulated: true, publication: 'NONE', outcome, requestedMode: requested, effectiveMode: mode, platform: dto.platform, scheduledAt: when.toISOString(), checks, risk: cls.risk, reasons: cls.reasons, note: 'Fictitious scheduling: no calendar entry or publication was created, and a simulated demo media can never be published.', decidedAt: new Date().toISOString() };
    const u = await this.prisma.creativeProject.update({ where: { id }, data: { scheduleSim: sim as unknown as Prisma.InputJsonObject, status: outcome === 'BLOCKED' ? p.status : 'SCHEDULED_SIMULATED' } });
    await this.audit.record({ action: 'creative.schedule_simulated', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeProject', entityId: id, metadata: { outcome, mode } });
    return { ...this.view(u), scheduleSim: sim };
  }

  /** The media library of the Studio: delivered images and videos, filterable by type and project. Signed, tenant-scoped URLs. */
  async library(t: TenantContext, q: { type?: 'IMAGE' | 'VIDEO'; projectId?: string; page: number; pageSize: number }) {
    const where: Prisma.CreativeOutputWhereInput = { businessId: t.businessId, generation: { businessId: t.businessId, status: 'SUCCEEDED', ...(q.type ? { kind: q.type } : {}), ...(q.projectId ? { projectId: q.projectId } : {}) } };
    const [rows, total] = await Promise.all([
      this.prisma.creativeOutput.findMany({ where, include: { media: true, generation: { select: { id: true, kind: true, provider: true, projectId: true, prompt: true, createdAt: true } } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.creativeOutput.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((o) => ({ outputId: o.id, generationId: o.generation.id, type: o.generation.kind, projectId: o.generation.projectId, simulated: ['mock', 'fake'].includes(o.generation.provider), provider: o.generation.provider, createdAt: o.createdAt, width: o.width, height: o.height, media: this.media.toDto(o.media) })) };
  }
}
