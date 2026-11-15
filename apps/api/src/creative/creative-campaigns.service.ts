import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@touma/database';
import type { ScriptProvider, ScriptResult } from '@touma/creative';
import { classifyPublication, DEFAULT_HOURS, roleHasPermission, type ContentKind } from '@touma/shared';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { CreateImageDto, CreateVideoDto } from './creative.dto';
import { CreativeService } from './creative.service';
import { CreativeUsageService } from './creative-usage.service';
import { SCRIPT_PROVIDER } from './creative-providers';

export type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE';
export interface CampaignInput {
  name: string; subject: string; objective: string; audience: string; platform: Platform; language: 'en' | 'fr';
  brand: { tone?: string; colors?: string[]; style?: string; tagline?: string };
  photoCount: number; videoCount: number; startAt: string; intervalHours: number; publishMode: 'AUTO' | 'HYBRID';
}
const AGENTS = { CAMPAIGN: 'Campaign Agent', SCRIPT: 'Script Agent', IMAGE: 'Image Agent', VIDEO: 'Video Agent', QUALITY: 'Quality Agent', SCHEDULE: 'Schedule Agent' } as const;
type Agent = keyof typeof AGENTS;
const IMAGE_ASPECT: Record<Platform, string> = { INSTAGRAM: '4:5', TIKTOK: '9:16', YOUTUBE: '16:9' };
const VIDEO_FORMAT: Record<Platform, string> = { INSTAGRAM: 'SHORT_VERTICAL', TIKTOK: 'SHORT_VERTICAL', YOUTUBE: 'LANDSCAPE' };
const CAPTION_MAX: Record<Platform, number> = { INSTAGRAM: 2200, TIKTOK: 2200, YOUTUBE: 5000 };
export const REFERENCE_VIDEO_SECONDS = 8;
const FINAL_CAMPAIGN = new Set(['COMPLETED', 'CANCELLED']);
const nf = (m: string) => new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND', message: m });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shape = (w?: number | null, h?: number | null) => (!w || !h ? 'unknown' : Math.abs(w / h - 1) < 0.05 ? 'square' : w > h ? 'landscape' : 'portrait');

/** The content version an approval is bound to: exact caption, media, platform and time. Any change gives another hash. */
export const contentHash = (p: { caption: string; hashtags: string[]; outputId: string; generationId: string; platform: string; scheduledAt: Date }) =>
  createHash('sha256').update(JSON.stringify([p.caption, p.hashtags, p.outputId, p.generationId, p.platform, p.scheduledAt.toISOString()])).digest('hex');

/**
 * N29 Free Creative Automation: a campaign is a fixed pipeline of six bounded agents (Campaign -> Script -> Image -> Video -> Quality -> Schedule). Every agent is a
 * resumable task row. Media is made through CreativeService, so manual and automatic creations share the same atomic daily quota; the idempotency key of each task
 * makes a retry unable to count twice. Scheduling and publication are FICTITIOUS: no social platform is ever contacted and simulated media is never publishable.
 */
@Injectable()
export class CreativeCampaignsService {
  private readonly logger = new Logger('CreativeCampaigns');
  private readonly running = new Set<string>();
  /** Test hook: the next run of this agent throws (to prove error handling and resume). */
  readonly faults = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
    private readonly creative: CreativeService,
    private readonly usage: CreativeUsageService,
    @Inject(SCRIPT_PROVIDER) private readonly script: ScriptProvider | null,
  ) {}

  private async find(t: TenantContext, id: string) {
    const c = await this.prisma.creativeCampaign.findFirst({ where: { id, businessId: t.businessId } });
    if (!c) throw nf('Campaign not found');
    return c;
  }
  private async event(c: { id: string; businessId: string }, level: 'INFO' | 'ERROR', type: string, detail?: object) {
    await this.prisma.creativeCampaignEvent.create({ data: { campaignId: c.id, businessId: c.businessId, level, type, detail: (detail ?? {}) as Prisma.InputJsonObject } });
  }

  // ─── Creation ──────────────────────────────────────────────────────────────

  async create(t: TenantContext, dto: CampaignInput, key: string) {
    if (!this.script) throw new ServiceUnavailableException({ code: 'SIMULATION_ONLY', message: 'Automated campaigns run in the free test mode only (CREATIVE_STUDIO_MODE=mock)' });
    if (dto.publishMode === 'AUTO' && !roleHasPermission(t.role, 'autopublish.manage')) throw new ForbiddenException({ code: 'AUTO_NOT_ALLOWED', message: 'Your role may not choose the automatic mode' });
    if (dto.photoCount + dto.videoCount < 1) throw new BadRequestException({ code: 'EMPTY_CAMPAIGN', message: 'Ask for at least one photo or one video' });
    const startAt = new Date(dto.startAt);
    if (Number.isNaN(startAt.getTime()) || startAt.getTime() < Date.now() - 60_000) throw new BadRequestException({ code: 'INVALID_TIME', message: 'Choose a start time in the future' });
    const existing = await this.prisma.creativeCampaign.findUnique({ where: { businessId_idempotencyKey: { businessId: t.businessId, idempotencyKey: key } } });
    if (existing) return { campaign: await this.detail(t, existing.id), replayed: true };
    const order: Array<[Agent, number]> = [['CAMPAIGN', 0], ['SCRIPT', 0], ...Array.from({ length: dto.photoCount }, (_, i): [Agent, number] => ['IMAGE', i]), ...Array.from({ length: dto.videoCount }, (_, i): [Agent, number] => ['VIDEO', i]), ['QUALITY', 0], ['SCHEDULE', 0]];
    const c = await this.prisma.creativeCampaign.create({
      data: {
        businessId: t.businessId, name: dto.name, subject: dto.subject, objective: dto.objective, audience: dto.audience, platform: dto.platform, language: dto.language, brand: dto.brand as Prisma.InputJsonObject,
        photoCount: dto.photoCount, videoCount: dto.videoCount, startAt, intervalHours: dto.intervalHours, publishMode: dto.publishMode, idempotencyKey: key, createdById: t.userId,
        tasks: { create: order.map(([agent, itemIndex], i) => ({ businessId: t.businessId, agent, itemIndex, seq: i + 1 })) },
      },
    });
    await this.event(c, 'INFO', 'CREATED', { photos: dto.photoCount, videos: dto.videoCount, mode: dto.publishMode });
    await this.audit.record({ action: 'creative.campaign_created', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeCampaign', entityId: c.id });
    return { campaign: await this.detail(t, c.id), replayed: false };
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  async start(t: TenantContext, id: string) {
    const c = await this.find(t, id);
    if (c.status !== 'DRAFT') throw new ConflictException({ code: 'CAMPAIGN_NOT_DRAFT', message: `A ${c.status.toLowerCase().replace('_', ' ')} campaign cannot be started` });
    await this.prisma.creativeCampaign.update({ where: { id }, data: { status: 'RUNNING' } });
    await this.event(c, 'INFO', 'STARTED');
    this.kick(t, id);
    return this.detail(t, id);
  }

  /** Runs in the background; every step is persisted, so a crash or a restart loses nothing (retry resumes). */
  private kick(t: TenantContext, id: string) { void this.advance(t, id).catch((e) => this.logger.error(`campaign ${id}: ${e instanceof Error ? e.message : e}`)); }

  /** Resolves when the campaign is idle (tests and the demo script use it; the API does not wait on it). */
  async advance(t: TenantContext, id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      for (;;) {
        const c = await this.prisma.creativeCampaign.findFirst({ where: { id, businessId: t.businessId } });
        if (!c || c.stoppedAt || c.status === 'CANCELLED') return;
        const task = await this.prisma.creativeCampaignTask.findFirst({ where: { campaignId: id, status: 'PENDING' }, orderBy: { seq: 'asc' } });
        if (!task) break;
        await this.runTask(t, c, task);
      }
      await this.refreshStatus(id);
    } finally { this.running.delete(id); }
  }

  private async runTask(t: TenantContext, c: Awaited<ReturnType<CreativeCampaignsService['find']>>, task: { id: string; agent: string; itemIndex: number; attempts: number; generationId: string | null }) {
    await this.prisma.creativeCampaignTask.update({ where: { id: task.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), errorCode: null, errorMessage: null } });
    try {
      const left = this.faults.get(`${c.id}:${task.agent}`) ?? this.faults.get(task.agent) ?? 0;
      if (left > 0) { this.faults.set(this.faults.has(`${c.id}:${task.agent}`) ? `${c.id}:${task.agent}` : task.agent, left - 1); throw Object.assign(new Error('Simulated agent failure'), { code: 'SIMULATED_AGENT_FAILURE' }); }
      const out = await this.agent(t, c, task);
      // A stop or a cancellation that arrived meanwhile wins: the result is kept (media already delivered) but nothing else moves.
      const now = await this.prisma.creativeCampaign.findUnique({ where: { id: c.id }, select: { stoppedAt: true, status: true } });
      const interrupted = !!now?.stoppedAt || now?.status === 'CANCELLED';
      await this.prisma.creativeCampaignTask.updateMany({ where: { id: task.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', finishedAt: new Date(), output: out as Prisma.InputJsonObject } });
      if (interrupted) await this.event(c, 'INFO', 'INTERRUPTED', { agent: task.agent });
    } catch (e) {
      const code = (e as { response?: { code?: string }; code?: string }).response?.code ?? (e as { code?: string }).code ?? 'AGENT_FAILED';
      const message = e instanceof Error ? e.message : String(e);
      await this.prisma.creativeCampaignTask.update({ where: { id: task.id }, data: { status: 'FAILED', finishedAt: new Date(), errorCode: code, errorMessage: message.slice(0, 300) } });
      await this.event(c, 'ERROR', 'TASK_FAILED', { agent: task.agent, itemIndex: task.itemIndex, code, message: message.slice(0, 300) });
    }
  }

  private async agent(t: TenantContext, c: Awaited<ReturnType<CreativeCampaignsService['find']>>, task: { id: string; agent: string; itemIndex: number; attempts: number; generationId: string | null }): Promise<object> {
    const platform = c.platform as Platform;
    const brand = c.brand as { style?: string };
    switch (task.agent as Agent) {
      case 'CAMPAIGN':
        return { plan: { platform, images: c.photoCount, videos: c.videoCount, referenceVideoSeconds: REFERENCE_VIDEO_SECONDS, startAt: c.startAt, intervalHours: c.intervalHours, publishMode: c.publishMode }, simulated: true };
      case 'SCRIPT': {
        const s = await this.script!.generate({ brief: `${c.subject}. ${c.objective}`, language: c.language === 'fr' ? 'fr' : 'en', seconds: REFERENCE_VIDEO_SECONDS, style: brand.style ?? 'MINIMAL', brandName: c.name });
        return s as unknown as object;
      }
      case 'IMAGE':
      case 'VIDEO': {
        const kind = task.agent === 'IMAGE' ? 'IMAGE' : 'VIDEO';
        let genId = task.generationId;
        const prior = genId ? await this.prisma.creativeGeneration.findFirst({ where: { id: genId, businessId: c.businessId } }) : null;
        // Resume: a generation already delivered is never made (or counted) again.
        if (!prior || prior.status === 'FAILED') {
          const text = `${c.subject}. ${c.objective}`.slice(0, 280);
          const key = `camp-${task.id}-${task.attempts + 1}`;
          const r = kind === 'IMAGE'
            ? await this.creative.submitImage(t, Object.assign(new CreateImageDto(), { type: 'PRODUCT_AD', aspectRatio: IMAGE_ASPECT[platform], count: 1, instructions: text, useBrandKit: true }), key)
            : await this.creative.submitVideo(t, Object.assign(new CreateVideoDto(), { format: VIDEO_FORMAT[platform], seconds: REFERENCE_VIDEO_SECONDS, instructions: text, useBrandKit: true }), key);
          genId = r.generation.id;
          await this.prisma.creativeCampaignTask.update({ where: { id: task.id }, data: { generationId: genId } });
        }
        const g = await this.waitFinal(t, genId!, c.id);
        if (g.status !== 'SUCCEEDED') throw Object.assign(new Error(g.errorMessage ?? 'The generation failed'), { code: g.errorCode ?? 'GENERATION_FAILED' });
        return { generationId: genId, provider: g.provider, simulated: ['mock', 'fake'].includes(g.provider) };
      }
      case 'QUALITY': return this.quality(c);
      case 'SCHEDULE': return this.schedule(c);
    }
  }

  private async waitFinal(t: TenantContext, generationId: string, campaignId: string) {
    const until = Date.now() + 120_000;
    for (;;) {
      const g = await this.prisma.creativeGeneration.findFirst({ where: { id: generationId, businessId: t.businessId } });
      if (!g) throw new NotFoundException({ code: 'CREATIVE_NOT_FOUND', message: 'Generation not found' });
      if (g.status === 'SUCCEEDED' || g.status === 'FAILED') return g;
      const stop = await this.prisma.creativeCampaign.findUnique({ where: { id: campaignId }, select: { stoppedAt: true, status: true } });
      if (stop?.stoppedAt || stop?.status === 'CANCELLED') await this.creative.cancel(t, generationId).catch(() => undefined);
      if (Date.now() > until) throw Object.assign(new Error('The generation took too long'), { code: 'GENERATION_TIMEOUT' });
      await sleep(40);
    }
  }

  /** Quality Agent: formats and rules, per delivered item. A failing item is excluded from scheduling. */
  private async quality(c: Awaited<ReturnType<CreativeCampaignsService['find']>>) {
    const platform = c.platform as Platform;
    const tasks = await this.prisma.creativeCampaignTask.findMany({ where: { campaignId: c.id, agent: { in: ['IMAGE', 'VIDEO'] }, status: 'SUCCEEDED' }, orderBy: { seq: 'asc' } });
    const scriptTask = await this.prisma.creativeCampaignTask.findFirst({ where: { campaignId: c.id, agent: 'SCRIPT', status: 'SUCCEEDED' } });
    const script = scriptTask?.output as unknown as ScriptResult | null;
    const items: Array<{ taskId: string; generationId: string; kind: string; ok: boolean; issues: string[] }> = [];
    for (const task of tasks) {
      const g = await this.prisma.creativeGeneration.findFirst({ where: { id: task.generationId!, businessId: c.businessId }, include: { outputs: true } });
      const issues: string[] = [];
      const o = g?.outputs[0];
      if (!g || !o) issues.push('NO_OUTPUT');
      else {
        const want = task.agent === 'IMAGE' ? IMAGE_ASPECT[platform] : VIDEO_FORMAT[platform] === 'LANDSCAPE' ? '16:9' : '9:16';
        const wantShape = want === '1:1' ? 'square' : Number(want.split(':')[0]) > Number(want.split(':')[1]) ? 'landscape' : 'portrait';
        const have = shape(o.width, o.height);
        if (have !== 'unknown' && have !== wantShape) issues.push(`FORMAT_MISMATCH:${have}!=${wantShape}`);
        if (task.agent === 'VIDEO' && g.producedUnits !== REFERENCE_VIDEO_SECONDS) issues.push(`VIDEO_LENGTH:${g.producedUnits}`);
        if (g.status !== 'SUCCEEDED') issues.push('NOT_DELIVERED');
      }
      items.push({ taskId: task.id, generationId: task.generationId!, kind: task.agent, ok: issues.length === 0, issues });
    }
    const captionIssues: string[] = [];
    if (!script?.caption?.trim()) captionIssues.push('NO_CAPTION');
    else if (script.caption.length > CAPTION_MAX[platform]) captionIssues.push('CAPTION_TOO_LONG');
    const verdict = classifyPublication({ mode: 'HYBRID', platform, contentKind: 'IMAGE', title: c.name, caption: script?.caption ?? '', hashtags: script?.hashtags ?? [], allowedContentTypes: ['IMAGE', 'VIDEO'], scheduledAt: new Date(Date.UTC(2030, 0, 1, 12)), timezone: 'UTC', hours: DEFAULT_HOURS, postsThatDay: 0, maxPostsPerDay: 99, platformConfirmationMissing: false });
    if (verdict.risk === 'BLOCKED') captionIssues.push(...verdict.reasons.filter((r) => r.severity === 'block').map((r) => r.code));
    return { items, captionIssues, passed: items.filter((i) => i.ok).length, failed: items.filter((i) => !i.ok).length + (captionIssues.length ? 1 : 0), simulated: true };
  }

  /** Schedule Agent: FICTITIOUS posts. The effective mode is never looser than the client's request, the role's rights or the account policy. */
  private async schedule(c: Awaited<ReturnType<CreativeCampaignsService['find']>>) {
    const platform = c.platform as Platform;
    const q = await this.prisma.creativeCampaignTask.findFirst({ where: { campaignId: c.id, agent: 'QUALITY', status: 'SUCCEEDED' } });
    const quality = q?.output as unknown as { items: Array<{ generationId: string; kind: string; ok: boolean }>; captionIssues: string[] } | null;
    const script = (await this.prisma.creativeCampaignTask.findFirst({ where: { campaignId: c.id, agent: 'SCRIPT', status: 'SUCCEEDED' } }))?.output as unknown as ScriptResult | null;
    if (!quality || !script || quality.captionIssues.length) throw Object.assign(new Error('The quality check did not pass: nothing is scheduled'), { code: 'QUALITY_NOT_PASSED' });
    const creator = c.createdById ? await this.prisma.membership.findFirst({ where: { userId: c.createdById, businessId: c.businessId, status: 'ACTIVE' }, select: { role: true } }) : null;
    const mayAuto = !!creator && roleHasPermission(creator.role, 'autopublish.manage');
    const account = await this.prisma.socialAccount.findFirst({ where: { businessId: c.businessId, platform, deletedAt: null }, include: { publishingPolicy: true } });
    const pol = account?.publishingPolicy;
    const policyBlocks = !!pol && (pol.mode === 'MANUAL' || !!pol.pausedAt || !!pol.consentRevokedAt || !pol.automationEnabled);
    const rank = { MANUAL: 0, HYBRID: 1, AUTO: 2 } as const;
    const ceiling = !mayAuto ? 'HYBRID' : policyBlocks ? (pol!.mode === 'MANUAL' || pol!.pausedAt || pol!.consentRevokedAt ? 'MANUAL' : 'HYBRID') : pol ? pol.mode : 'AUTO';
    const requested = c.publishMode as 'AUTO' | 'HYBRID';
    const effective = rank[requested] <= rank[ceiling as keyof typeof rank] ? requested : (ceiling as 'AUTO' | 'HYBRID' | 'MANUAL');
    const biz = await this.prisma.business.findUnique({ where: { id: c.businessId }, select: { timezone: true } });
    const tz = pol?.timezone ?? biz?.timezone ?? 'UTC';
    const hours = (pol?.allowedPublishingHours as typeof DEFAULT_HOURS | undefined) ?? DEFAULT_HOURS;
    const maxPerDay = pol?.maximumPostsPerDay ?? 3;
    const ok = quality.items.filter((i) => i.ok);
    const created: Array<{ id: string; status: string; risk: string }> = [];
    let idx = 0;
    for (const item of ok) {
      const gen = await this.prisma.creativeGeneration.findFirst({ where: { id: item.generationId, businessId: c.businessId }, include: { outputs: true } });
      const out = gen?.outputs[0];
      if (!gen || !out) continue;
      const when = new Date(c.startAt.getTime() + idx++ * c.intervalHours * 3_600_000);
      const dup = await this.prisma.creativeCampaignPost.findUnique({ where: { campaignId_outputId: { campaignId: c.id, outputId: out.id } } });
      if (dup) { created.push({ id: dup.id, status: dup.status, risk: dup.risk }); continue; }
      const dayStart = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
      const sameDay = await this.prisma.creativeCampaignPost.count({ where: { businessId: c.businessId, platform, status: { notIn: ['CANCELLED', 'REJECTED', 'STOPPED'] }, scheduledAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } } });
      const kind: ContentKind = item.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE';
      const cls = classifyPublication({ mode: effective, platform, contentKind: kind, title: c.name, caption: script.caption, hashtags: script.hashtags, allowedContentTypes: ['IMAGE', 'VIDEO', 'CAROUSEL', 'TEXT'], scheduledAt: when, timezone: tz, hours, postsThatDay: sameDay, maxPostsPerDay: maxPerDay, platformConfirmationMissing: false });
      if (cls.risk === 'BLOCKED') { await this.event(c, 'ERROR', 'POST_BLOCKED', { generationId: item.generationId, reasons: cls.reasons.map((r) => r.code) }); continue; }
      const status = cls.risk === 'REVIEW_REQUIRED' || effective === 'MANUAL' ? 'PENDING_APPROVAL' : 'SIMULATED_SCHEDULED';
      const base = { caption: script.caption, hashtags: script.hashtags, outputId: out.id, generationId: gen.id, platform, scheduledAt: when };
      const post = await this.prisma.creativeCampaignPost.create({ data: { campaignId: c.id, businessId: c.businessId, ...base, kind, contentHash: contentHash(base), status, requestedMode: requested, effectiveMode: effective, risk: cls.risk, reasons: cls.reasons as unknown as Prisma.InputJsonValue } });
      created.push({ id: post.id, status: post.status, risk: post.risk });
    }
    return { posts: created, requestedMode: requested, effectiveMode: effective, timezone: tz, simulated: true, publication: 'NONE' };
  }

  /** Derives the campaign status from its tasks and posts. */
  private async refreshStatus(id: string) {
    const c = await this.prisma.creativeCampaign.findUnique({ where: { id }, include: { tasks: true, posts: true } });
    if (!c || c.stoppedAt || c.status === 'CANCELLED') return;
    const active = c.tasks.some((t) => t.status === 'PENDING' || t.status === 'RUNNING');
    let status = c.status;
    if (active) status = 'RUNNING';
    else if (c.tasks.some((t) => t.status === 'FAILED')) status = 'NEEDS_ATTENTION';
    else if (c.posts.some((p) => p.status === 'PENDING_APPROVAL')) status = 'AWAITING_APPROVAL';
    else status = 'COMPLETED';
    // Conditional write: a stop or a cancellation that lands meanwhile always wins over a derived status.
    if (status !== c.status) { const r = await this.prisma.creativeCampaign.updateMany({ where: { id, status: c.status, stoppedAt: null }, data: { status } }); if (r.count) await this.event(c, 'INFO', `STATUS_${status}`); }
  }

  /** Resume after an error: failed tasks (and the quality and schedule steps that depend on them) run again; delivered media and existing posts are kept and never recounted. */
  async retry(t: TenantContext, id: string) {
    const c = await this.find(t, id);
    if (c.stoppedAt) throw new ConflictException({ code: 'CAMPAIGN_STOPPED', message: 'The campaign is stopped: resume it first' });
    if (c.status !== 'NEEDS_ATTENTION') throw new ConflictException({ code: 'NOTHING_TO_RETRY', message: 'Only a campaign that needs attention can be retried' });
    await this.prisma.creativeCampaignTask.updateMany({ where: { campaignId: id, OR: [{ status: 'FAILED' }, { agent: { in: ['QUALITY', 'SCHEDULE'] }, status: 'SUCCEEDED' }] }, data: { status: 'PENDING', errorCode: null, errorMessage: null } });
    await this.prisma.creativeCampaign.update({ where: { id }, data: { status: 'RUNNING' } });
    await this.event(c, 'INFO', 'RETRIED');
    this.kick(t, id);
    return this.detail(t, id);
  }

  // ─── Stop, resume, cancel ──────────────────────────────────────────────────

  private async halt(c: { id: string; businessId: string }, status: 'STOPPED' | 'CANCELLED', postStatus: 'STOPPED' | 'CANCELLED') {
    await this.prisma.creativeCampaign.update({ where: { id: c.id }, data: { status, ...(status === 'STOPPED' ? { stoppedAt: new Date() } : {}) } });
    await this.prisma.creativeCampaignTask.updateMany({ where: { campaignId: c.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    await this.prisma.creativeCampaignPost.updateMany({ where: { campaignId: c.id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SIMULATED_SCHEDULED'] } }, data: { status: postStatus } });
  }

  /** EMERGENCY STOP: nothing runs, nothing is scheduled, no simulated publication happens, until a person resumes the campaign. */
  async emergencyStop(t: TenantContext, id?: string) {
    const targets = await this.prisma.creativeCampaign.findMany({ where: { businessId: t.businessId, ...(id ? { id } : {}), stoppedAt: null, OR: [{ status: { notIn: ['COMPLETED', 'CANCELLED'] } }, { status: 'COMPLETED', posts: { some: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SIMULATED_SCHEDULED'] } } } }] } });
    if (id && !targets.length) { await this.find(t, id); throw new ConflictException({ code: 'NOTHING_TO_STOP', message: 'This campaign has nothing left to stop (finished, cancelled or already stopped)' }); }
    for (const c of targets) { await this.halt(c, 'STOPPED', 'STOPPED'); await this.event(c, 'INFO', 'EMERGENCY_STOP', { by: t.userId }); await this.audit.record({ action: 'creative.campaign_emergency_stop', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeCampaign', entityId: c.id }); }
    return { stopped: targets.length };
  }

  async resume(t: TenantContext, id: string) {
    const c = await this.find(t, id);
    if (!c.stoppedAt) throw new ConflictException({ code: 'NOT_STOPPED', message: 'This campaign is not stopped' });
    await this.prisma.creativeCampaignTask.updateMany({ where: { campaignId: id, status: 'CANCELLED' }, data: { status: 'PENDING' } });
    // Posts that were stopped come back as waiting for a person: an approval never survives a stop.
    await this.prisma.creativeCampaignPost.updateMany({ where: { campaignId: id, status: 'STOPPED' }, data: { status: 'PENDING_APPROVAL', approvedHash: null, approvedById: null, approvedAt: null } });
    await this.prisma.creativeCampaign.update({ where: { id }, data: { stoppedAt: null, stoppedById: null, status: 'RUNNING' } });
    await this.event(c, 'INFO', 'RESUMED', { by: t.userId });
    this.kick(t, id);
    return this.detail(t, id);
  }

  async cancel(t: TenantContext, id: string) {
    const c = await this.find(t, id);
    if (FINAL_CAMPAIGN.has(c.status)) throw new ConflictException({ code: 'CAMPAIGN_FINAL', message: `A ${c.status.toLowerCase()} campaign cannot be cancelled` });
    await this.halt(c, 'CANCELLED', 'CANCELLED');
    for (const task of await this.prisma.creativeCampaignTask.findMany({ where: { campaignId: id, status: 'RUNNING', generationId: { not: null } } })) await this.creative.cancel(t, task.generationId!).catch(() => undefined);
    await this.event(c, 'INFO', 'CANCELLED', { by: t.userId });
    await this.audit.record({ action: 'creative.campaign_cancelled', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeCampaign', entityId: id });
    return this.detail(t, id);
  }

  // ─── Approvals bound to the exact version ──────────────────────────────────

  private async post(t: TenantContext, campaignId: string, postId: string) {
    const c = await this.find(t, campaignId);
    const p = await this.prisma.creativeCampaignPost.findFirst({ where: { id: postId, campaignId, businessId: t.businessId } });
    if (!p) throw new NotFoundException({ code: 'POST_NOT_FOUND', message: 'Post not found' });
    if (c.stoppedAt || c.status === 'CANCELLED') throw new ConflictException({ code: 'CAMPAIGN_INACTIVE', message: 'The campaign is stopped or cancelled' });
    return { c, p };
  }

  /** The approval names the content version it covers. If the caption, media, platform or time changed since, it is refused (409) and nothing is approved. */
  async approve(t: TenantContext, campaignId: string, postId: string, hash: string) {
    const { c, p } = await this.post(t, campaignId, postId);
    if (p.status !== 'PENDING_APPROVAL') throw new ConflictException({ code: 'NOT_WAITING', message: 'This post is not waiting for approval' });
    const current = contentHash(p);
    if (hash !== current || p.contentHash !== current) throw new ConflictException({ code: 'APPROVAL_STALE', message: 'The content changed since you reviewed it: review the new version', contentHash: current });
    if (p.risk === 'BLOCKED') throw new ConflictException({ code: 'POST_BLOCKED', message: 'A blocked post cannot be approved' });
    await this.prisma.creativeCampaignPost.update({ where: { id: p.id }, data: { status: 'SIMULATED_SCHEDULED', approvedHash: current, approvedById: t.userId, approvedAt: new Date() } });
    await this.event(c, 'INFO', 'POST_APPROVED', { postId, contentHash: current });
    await this.audit.record({ action: 'creative.campaign_post_approved', actorId: t.userId, businessId: t.businessId, entityType: 'CreativeCampaignPost', entityId: p.id });
    await this.refreshStatus(campaignId);
    return this.detail(t, campaignId);
  }

  async reject(t: TenantContext, campaignId: string, postId: string) {
    const { c, p } = await this.post(t, campaignId, postId);
    if (p.status !== 'PENDING_APPROVAL') throw new ConflictException({ code: 'NOT_WAITING', message: 'This post is not waiting for approval' });
    await this.prisma.creativeCampaignPost.update({ where: { id: p.id }, data: { status: 'REJECTED' } });
    await this.event(c, 'INFO', 'POST_REJECTED', { postId });
    await this.refreshStatus(campaignId);
    return this.detail(t, campaignId);
  }

  /** Editing a scheduled or approved post makes a NEW version: the earlier approval is void and a person must approve again. */
  async editPost(t: TenantContext, campaignId: string, postId: string, dto: { caption?: string; scheduledAt?: string }) {
    const { c, p } = await this.post(t, campaignId, postId);
    if (!['PENDING_APPROVAL', 'SIMULATED_SCHEDULED'].includes(p.status)) throw new ConflictException({ code: 'POST_FINAL', message: 'This post can no longer be edited' });
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : p.scheduledAt;
    if (Number.isNaN(scheduledAt.getTime())) throw new BadRequestException({ code: 'INVALID_TIME', message: 'Invalid time' });
    const caption = dto.caption ?? p.caption;
    const next = { caption, hashtags: p.hashtags, outputId: p.outputId, generationId: p.generationId, platform: p.platform, scheduledAt };
    const cls = classifyPublication({ mode: p.effectiveMode as 'AUTO' | 'HYBRID' | 'MANUAL', platform: p.platform as Platform, contentKind: p.kind as ContentKind, title: c.name, caption, hashtags: p.hashtags, allowedContentTypes: ['IMAGE', 'VIDEO'], scheduledAt, timezone: 'UTC', hours: DEFAULT_HOURS, postsThatDay: 0, maxPostsPerDay: 99, platformConfirmationMissing: false });
    if (cls.risk === 'BLOCKED') throw new BadRequestException({ code: 'CONTENT_BLOCKED', message: 'This wording cannot be used', issues: cls.reasons.map((r) => r.code) });
    await this.prisma.creativeCampaignPost.update({ where: { id: p.id }, data: { ...next, contentHash: contentHash(next), status: 'PENDING_APPROVAL', approvedHash: null, approvedById: null, approvedAt: null, risk: cls.risk, reasons: cls.reasons as unknown as Prisma.InputJsonValue } });
    await this.event(c, 'INFO', 'POST_EDITED', { postId });
    await this.refreshStatus(campaignId);
    return this.detail(t, campaignId);
  }

  /** Fictitious publication of what is due: only posts that are scheduled AND whose approval (when one is needed) names the current version. Nothing leaves the server. */
  async simulateDue(t: TenantContext, id: string, asOf?: string) {
    const c = await this.find(t, id);
    if (c.stoppedAt || c.status === 'CANCELLED') throw new ConflictException({ code: 'CAMPAIGN_INACTIVE', message: 'The campaign is stopped or cancelled: nothing is published' });
    const now = asOf ? new Date(asOf) : new Date();
    if (Number.isNaN(now.getTime())) throw new BadRequestException({ code: 'INVALID_TIME', message: 'Invalid time' });
    const due = await this.prisma.creativeCampaignPost.findMany({ where: { campaignId: id, status: 'SIMULATED_SCHEDULED', scheduledAt: { lte: now } } });
    let published = 0;
    for (const p of due) {
      if (p.risk === 'REVIEW_REQUIRED' && p.approvedHash !== contentHash(p)) { await this.event(c, 'ERROR', 'PUBLISH_REFUSED_STALE_APPROVAL', { postId: p.id }); continue; }
      await this.prisma.creativeCampaignPost.update({ where: { id: p.id }, data: { status: 'SIMULATED_PUBLISHED', publishedAt: now } });
      published++;
    }
    if (published) await this.event(c, 'INFO', 'SIMULATED_PUBLISHED', { count: published });
    return { published, external: 0, note: 'Fictitious publication: no social platform was contacted.' };
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  private summary(c: { id: string; name: string; subject: string; objective: string; audience: string; platform: string; language: string; photoCount: number; videoCount: number; startAt: Date; intervalHours: number; publishMode: string; status: string; stoppedAt: Date | null; brand: unknown; createdAt: Date }) {
    return { id: c.id, name: c.name, subject: c.subject, objective: c.objective, audience: c.audience, platform: c.platform, language: c.language, brand: c.brand, photoCount: c.photoCount, videoCount: c.videoCount, startAt: c.startAt, intervalHours: c.intervalHours, publishMode: c.publishMode, status: c.status, stopped: !!c.stoppedAt, simulation: true, createdAt: c.createdAt };
  }

  async list(t: TenantContext) {
    const rows = await this.prisma.creativeCampaign.findMany({ where: { businessId: t.businessId }, orderBy: { createdAt: 'desc' }, take: 100, include: { tasks: { select: { status: true } }, posts: { select: { status: true } } } });
    return rows.map((c) => ({ ...this.summary(c), tasks: { total: c.tasks.length, done: c.tasks.filter((x) => x.status === 'SUCCEEDED').length, failed: c.tasks.filter((x) => x.status === 'FAILED').length }, posts: { total: c.posts.length, waiting: c.posts.filter((x) => x.status === 'PENDING_APPROVAL').length } }));
  }

  async detail(t: TenantContext, id: string) {
    const c = await this.prisma.creativeCampaign.findFirst({ where: { id, businessId: t.businessId }, include: { tasks: { orderBy: { seq: 'asc' } }, posts: { orderBy: { scheduledAt: 'asc' } }, events: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!c) throw nf('Campaign not found');
    const outputs = await this.prisma.creativeOutput.findMany({ where: { businessId: t.businessId, id: { in: c.posts.map((p) => p.outputId) } }, include: { media: true } });
    const mediaOf = new Map(outputs.map((o) => [o.id, o]));
    // Media made by tasks (also when no post exists, e.g. a failed quality check) so the client can preview everything that was produced.
    const genIds = c.tasks.map((x) => x.generationId).filter((x): x is string => !!x);
    const gens = await this.prisma.creativeGeneration.findMany({ where: { id: { in: genIds }, businessId: t.businessId, status: 'SUCCEEDED' }, include: { outputs: { include: { media: true } } } });
    return {
      ...this.summary(c),
      tasks: c.tasks.map((x) => ({ id: x.id, agent: x.agent, label: AGENTS[x.agent as Agent], seq: x.seq, itemIndex: x.itemIndex, status: x.status, attempts: x.attempts, generationId: x.generationId, errorCode: x.errorCode, errorMessage: x.errorMessage, startedAt: x.startedAt, finishedAt: x.finishedAt })),
      posts: c.posts.map((p) => ({ id: p.id, platform: p.platform, kind: p.kind, caption: p.caption, hashtags: p.hashtags, scheduledAt: p.scheduledAt, status: p.status, requestedMode: p.requestedMode, effectiveMode: p.effectiveMode, risk: p.risk, reasons: p.reasons, contentHash: contentHash(p), approved: !!p.approvedHash && p.approvedHash === contentHash(p), approvedAt: p.approvedAt, publishedAt: p.publishedAt, simulated: true, media: mediaOf.get(p.outputId) ? this.media.toDto(mediaOf.get(p.outputId)!.media) : null })),
      media: gens.flatMap((g) => g.outputs.map((o) => ({ generationId: g.id, kind: g.kind, simulated: ['mock', 'fake'].includes(g.provider), media: this.media.toDto(o.media) }))),
      events: c.events.map((e) => ({ id: e.id, level: e.level, type: e.type, detail: e.detail, createdAt: e.createdAt })),
    };
  }

  async get(t: TenantContext, id: string) { return this.detail(t, id); }

  /** Campaign Control Center figures. */
  async overview(t: TenantContext) {
    const b = t.businessId;
    const [campaigns, photos, videos, tasks, posts, waiting, errors, quota] = await Promise.all([
      this.prisma.creativeCampaign.groupBy({ by: ['status'], where: { businessId: b }, _count: { _all: true } }),
      this.prisma.creativeOutput.count({ where: { businessId: b, generation: { kind: 'IMAGE', status: 'SUCCEEDED' } } }),
      this.prisma.creativeOutput.count({ where: { businessId: b, generation: { kind: 'VIDEO', status: 'SUCCEEDED' } } }),
      this.prisma.creativeCampaignTask.groupBy({ by: ['status'], where: { businessId: b }, _count: { _all: true } }),
      this.prisma.creativeCampaignPost.groupBy({ by: ['status'], where: { businessId: b }, _count: { _all: true } }),
      this.prisma.creativeCampaignPost.findMany({ where: { businessId: b, status: 'PENDING_APPROVAL' }, orderBy: { scheduledAt: 'asc' }, take: 20, include: { campaign: { select: { id: true, name: true } } } }),
      this.prisma.creativeCampaignEvent.findMany({ where: { businessId: b, level: 'ERROR' }, orderBy: { createdAt: 'desc' }, take: 20, include: { campaign: { select: { id: true, name: true } } } }),
      this.usage.dailyStatus(b),
    ]);
    const n = (rows: Array<{ status: string; _count: { _all: number } }>, ...s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
    return {
      mode: 'SIMULATION', simulation: true, externalCalls: 0,
      campaigns: { total: campaigns.reduce((a, r) => a + r._count._all, 0), byStatus: Object.fromEntries(campaigns.map((r) => [r.status, r._count._all])) },
      media: { photos, videos },
      tasks: { running: n(tasks, 'PENDING', 'RUNNING'), completed: n(tasks, 'SUCCEEDED'), failed: n(tasks, 'FAILED') },
      posts: { scheduledSimulated: n(posts, 'SIMULATED_SCHEDULED'), publishedSimulated: n(posts, 'SIMULATED_PUBLISHED'), waitingApproval: n(posts, 'PENDING_APPROVAL') },
      waitingApproval: waiting.map((p) => ({ id: p.id, campaignId: p.campaign.id, campaignName: p.campaign.name, platform: p.platform, kind: p.kind, scheduledAt: p.scheduledAt, caption: p.caption, contentHash: contentHash(p), reasons: p.reasons })),
      errors: errors.map((e) => ({ id: e.id, campaignId: e.campaign.id, campaignName: e.campaign.name, type: e.type, detail: e.detail, createdAt: e.createdAt })),
      quota: { images: quota.images, videos: quota.videos, resetsAt: quota.resetsAt, timezone: quota.timezone },
    };
  }
}
