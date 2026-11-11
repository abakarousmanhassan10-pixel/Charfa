import { HttpException, Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import {
  compositeProduct, CreativeNotConfiguredError, CreativeProviderError, extractProduct, fontFamily, imageCostUsd, nearestNativeSize, placeLogo, renderOverlay, resizeExact, toJpeg, videoCostUsd,
  type ImageProvider, type ProductCutout, type VideoProvider,
} from '@touma/creative';
import { MEDIA_RULES, roleHasPermission, type AllowedMimeType, type LogoPlacement, type OverlayPosition } from '@touma/shared';
import { Prisma, type CreativeGeneration } from '@touma/database';
import { AppEnv, InjectEnv } from '../config';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { bullConnection } from '../ai/ai-queue';
import { IMAGE_PROVIDER, VIDEO_PROVIDER } from './creative-providers';
import { CREATIVE_QUEUE, CREATIVE_WORKER_HEARTBEAT_KEY, CreativeQueueService, type CreativeJobData } from './creative-queue';
import { CreativeUsageService } from './creative-usage.service';
import type { ImageParams, VideoParams } from './creative.service';

const FINAL = ['SUCCEEDED', 'FAILED'] as const;

/** A classified failure: whether the queue should retry it, and the code stored on the generation. */
export class CreativeJobError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'CreativeJobError';
  }
}

const KIND_CODE = (kind: 'IMAGE' | 'VIDEO') => (kind === 'IMAGE' ? 'IMAGE' : 'VIDEO');

/**
 * Consumer side of the creative queue (images and videos).
 *
 *  Image job:  QUEUED → RUNNING → SUCCEEDED / FAILED. One provider call per attempt; results are stored through the
 *              media pipeline (scan, re-encode, thumbnail, quota) and linked as outputs.
 *  Video job:  a resumable state machine. The provider job is submitted ONCE (its id is saved before anything else
 *              happens) and then polled with delayed re-queueing until it completes, fails or times out, so a retry or
 *              a worker restart can never submit (and pay for) the same video twice.
 *
 * The usage reservation taken at submission is settled exactly once: units the provider produced (and billed) are
 * committed, everything else is released. Failed generations remove whatever they stored.
 */
@Injectable()
export class CreativeWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CreativeWorker');
  private worker?: Worker<CreativeJobData>;
  private connection?: IORedis;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly usage: CreativeUsageService,
    private readonly queue: CreativeQueueService,
    @Inject(IMAGE_PROVIDER) private readonly image: ImageProvider | null,
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider | null,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  async onApplicationBootstrap() {
    if (this.env.AI_WORKER_INLINE) await this.start();
  }

  get running() {
    return Boolean(this.worker?.isRunning());
  }

  async start() {
    if (this.worker) return;
    this.connection = bullConnection(this.env);
    this.worker = new Worker<CreativeJobData>(CREATIVE_QUEUE, (job, token) => this.handle(job, token), { connection: this.connection, concurrency: this.env.CREATIVE_WORKER_CONCURRENCY });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.logger.error(`worker error: ${err.message}`));
    const beat = () => this.connection?.set(CREATIVE_WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch(() => undefined);
    await beat();
    this.timers.push(setInterval(beat, 30_000).unref());
    this.timers.push(setInterval(() => void this.reconcile().catch((e) => this.logger.error(`reconcile failed: ${(e as Error).message}`)), 60_000).unref());
    this.logger.log(`Creative worker listening on ${CREATIVE_QUEUE} (concurrency ${this.env.CREATIVE_WORKER_CONCURRENCY})`);
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => undefined);
  }

  // ─── Job handling ───────────────────────────────────────────────────────────

  private async tenantFor(gen: { businessId: string; userId: string | null }): Promise<TenantContext> {
    if (!gen.userId) throw new CreativeJobError('CREATIVE_FORBIDDEN', 'The requesting user no longer exists');
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: gen.userId, businessId: gen.businessId } } });
    if (!m || m.status !== 'ACTIVE' || !roleHasPermission(m.role, 'ai.use')) throw new CreativeJobError('CREATIVE_FORBIDDEN', 'The requesting user is no longer allowed to use the Creative Studio for this business');
    return { businessId: gen.businessId, userId: gen.userId, membershipId: m.id, role: m.role };
  }

  classify(err: unknown, kind: 'IMAGE' | 'VIDEO'): CreativeJobError {
    if (err instanceof CreativeJobError) return err;
    const k = KIND_CODE(kind);
    if (err instanceof CreativeNotConfiguredError) return new CreativeJobError(`${k}_NOT_CONFIGURED`, err.message);
    if (err instanceof CreativeProviderError) {
      const map: Record<string, string> = {
        auth: 'PROVIDER_AUTH', billing: 'PROVIDER_BILLING', rate_limit: 'PROVIDER_RATE_LIMIT', timeout: 'PROVIDER_TIMEOUT', server: 'PROVIDER_ERROR', network: 'PROVIDER_ERROR',
        bad_request: 'PROVIDER_BAD_REQUEST', refusal: 'PROVIDER_REFUSED', unsupported: 'PROVIDER_UNSUPPORTED', invalid_output: 'PROVIDER_INVALID_OUTPUT',
      };
      return new CreativeJobError(`${k}_${map[err.kind] ?? 'PROVIDER_ERROR'}`, err.message, err.retryable);
    }
    if (err instanceof HttpException) {
      const body = err.getResponse() as { code?: string; message?: unknown };
      // A storage or scanner outage is transient; quota, type and malware verdicts are final.
      return new CreativeJobError(body.code ?? 'CREATIVE_ERROR', typeof body.message === 'string' ? body.message : err.message, err.getStatus() === 503);
    }
    return new CreativeJobError('CREATIVE_ERROR', 'Unexpected error while generating');
  }

  async handle(job: Job<CreativeJobData>, token?: string) {
    const attempt = job.attemptsMade + 1;
    const max = job.opts.attempts ?? 1;
    const gen = await this.prisma.creativeGeneration.findUnique({ where: { id: job.data.generationId } });
    if (!gen || (FINAL as readonly string[]).includes(gen.status)) return; // missing, or a duplicate delivery of a finished job
    await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { status: 'RUNNING', startedAt: gen.startedAt ?? new Date(), jobAttempts: attempt } });
    try {
      await this.tenantFor(gen);
      if (gen.kind === 'IMAGE') await this.runImage(gen);
      else await this.runVideo(gen, job, token);
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      const e = this.classify(err, gen.kind);
      const fresh = await this.prisma.creativeGeneration.findUnique({ where: { id: gen.id }, select: { producedUnits: true } });
      // Never retry once the provider has produced (and billed) something: a retry would pay again.
      if (e.retryable && attempt < max && (fresh?.producedUnits ?? 0) === 0) {
        await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { status: 'QUEUED', errorCode: e.code, errorMessage: e.message.slice(0, 500) } });
        this.logger.warn(`generation ${gen.id}: ${e.code}, retrying (attempt ${attempt}/${max})`);
        throw err;
      }
      await this.fail(gen.id, e.code, e.message);
      throw new UnrecoverableError(`${e.code}: ${e.message}`);
    }
  }

  /** Final failure: remove what was stored, record the error, settle the reservation (billed units stay counted). */
  async fail(id: string, code: string, message: string) {
    const g = await this.prisma.creativeGeneration.findUnique({ where: { id }, include: { outputs: true } });
    if (!g || g.status === 'SUCCEEDED') return;
    if (g.outputs.length) {
      await this.media.removeGenerated(g.businessId, g.outputs.map((o) => o.mediaId), 'creative-failed').catch((e) => this.logger.error(`cleanup failed for ${id}: ${(e as Error).message}`));
      await this.prisma.creativeOutput.deleteMany({ where: { generationId: id } });
    }
    await this.prisma.creativeGeneration.updateMany({ where: { id, status: { notIn: [...FINAL] } }, data: { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), completedAt: new Date() } });
    await this.usage.settle(id);
  }

  private async onFailed(job: Job<CreativeJobData> | undefined, err: Error) {
    if (!job) return;
    this.logger.warn(`job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${err.message.slice(0, 200)}`);
    if (job.attemptsMade < (job.opts.attempts ?? 1) && !(err instanceof UnrecoverableError)) return;
    const g = await this.prisma.creativeGeneration.findUnique({ where: { id: job.data.generationId }, select: { status: true } });
    if (g && !(FINAL as readonly string[]).includes(g.status)) await this.fail(job.data.generationId, 'CREATIVE_JOB_FAILED', 'The generation job stopped unexpectedly').catch(() => undefined);
  }

  // ─── Usage rows (shared with the AI usage report) ───────────────────────────

  private async recordUsage(g: CreativeGeneration, r: { operation: 'IMAGE_GENERATION' | 'VIDEO_GENERATION'; model: string; success: boolean; error?: string; inputTokens?: number; outputTokens?: number; images?: number; videoSeconds?: number; costUsd?: number; latencyMs: number }) {
    await this.prisma.aIUsage.create({
      data: {
        businessId: g.businessId, userId: g.userId, agent: r.operation === 'IMAGE_GENERATION' ? 'VISUAL_CREATOR' : 'VIDEO_CREATOR', provider: g.provider, model: r.model, operation: r.operation,
        inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, imageCount: r.images ?? 0, videoSeconds: new Prisma.Decimal(r.videoSeconds ?? 0), costUsd: new Prisma.Decimal((r.costUsd ?? 0).toFixed(6)),
        success: r.success, error: r.error?.slice(0, 300) ?? null, latencyMs: r.latencyMs, attemptKind: 'creative',
      },
    });
  }

  /** Storage and scanner outages are retried briefly in place, so a billed result is not lost to a blip. */
  private async ingestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof HttpException) || err.getStatus() !== 503 || i >= 2) throw err;
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
  }

  // ─── Images ─────────────────────────────────────────────────────────────────

  private brandColors(snapshot: unknown, useBrandKit: boolean) {
    const kit = useBrandKit ? (snapshot as { colors?: Array<{ hex: string; role: string }>; headingFont?: string | null } | null) : null;
    const byRole = (role: string) => kit?.colors?.find((c) => c.role === role)?.hex ?? null;
    const text = byRole('TEXT');
    const band = byRole('BACKGROUND');
    return { font: fontFamily(kit?.headingFont), textColor: text && band ? text : null, bandColor: text && band ? band : null };
  }

  private async finishImage(raw: Buffer, p: ImageParams, cutout: ProductCutout | null, snapshot: unknown, logo: Buffer | null) {
    let canvas: Buffer;
    let upscaled = false;
    if (p.mode === 'SCENE_ONLY' && cutout) {
      const bg = await resizeExact(raw, p.width, p.height);
      upscaled = bg.upscaled; // only the generated scene is enlarged; the product's own pixels are placed, not repainted
      const avoid: OverlayPosition | null = p.overlayText ? (p.overlayPosition as OverlayPosition) : null;
      canvas = (await compositeProduct({ background: bg.data, cutout, width: p.width, height: p.height, avoid: avoid === 'CENTER' ? null : avoid, anchor: 'CENTER', shadow: true })).image;
    } else {
      const r = await resizeExact(raw, p.width, p.height);
      canvas = r.data;
      upscaled = r.upscaled;
    }
    if (p.overlayText) {
      const c = this.brandColors(snapshot, p.useBrandKit);
      canvas = await renderOverlay(canvas, { text: p.overlayText, position: p.overlayPosition as OverlayPosition, width: p.width, height: p.height, fontFamily: c.font, textColor: c.textColor, bandColor: c.bandColor });
    }
    if (logo && p.logoPlacement !== 'NONE') canvas = await placeLogo(canvas, logo, p.logoPlacement as Exclude<LogoPlacement, 'NONE'>, p.width, p.height);
    return { data: await toJpeg(canvas), upscaled };
  }

  private async runImage(gen: CreativeGeneration) {
    const provider = this.image;
    if (!provider || !provider.isConfigured()) throw new CreativeNotConfiguredError('image');
    const p = gen.params as unknown as ImageParams;
    const stored = await this.prisma.creativeOutput.count({ where: { generationId: gen.id } });
    const remaining = gen.requestedUnits - stored;
    if (remaining > 0) {
      const source = gen.sourceMediaId ? await this.media.readOriginal(gen.businessId, gen.sourceMediaId) : null;
      let cutout: ProductCutout | null = null;
      if (p.mode === 'SCENE_ONLY') {
        cutout = source ? await extractProduct(source.data, this.env.MEDIA_MAX_IMAGE_PIXELS).catch(() => null) : null;
        if (!cutout) throw new CreativeJobError('PRODUCT_CUTOUT_FAILED', 'The product could not be separated from its background');
      }
      let logo: Buffer | null = null;
      if (p.logoPlacement !== 'NONE') {
        const b = await this.prisma.business.findUniqueOrThrow({ where: { id: gen.businessId }, select: { logoMediaId: true } });
        if (!b.logoMediaId) throw new CreativeJobError('NO_LOGO', 'The business has no logo');
        logo = (await this.media.readOriginal(gen.businessId, b.logoMediaId)).data;
      }
      const t0 = Date.now();
      let res;
      try {
        res = await provider.generate({
          model: gen.model, prompt: gen.prompt, count: remaining, size: nearestNativeSize(provider.capabilities, { width: p.width, height: p.height }), quality: p.resolution === 'HD' ? 'high' : 'medium',
          source: p.mode === 'EDIT' && source ? { data: source.data, mime: source.mime, filename: source.filename } : undefined, fidelity: 'high', timeoutMs: this.env.CREATIVE_PROVIDER_TIMEOUT_MS,
        });
      } catch (err) {
        await this.recordUsage(gen, { operation: 'IMAGE_GENERATION', model: gen.model, success: false, error: (err as Error).message, latencyMs: Date.now() - t0 });
        throw err;
      }
      const ms = Date.now() - t0;
      const billed = res.images.length;
      const cost = imageCostUsd(this.usage.priceFor(res.model), billed);
      await this.prisma.creativeGeneration.update({
        where: { id: gen.id },
        data: { producedUnits: { increment: billed }, model: res.model, inputTokens: { increment: res.usage?.inputTokens ?? 0 }, outputTokens: { increment: res.usage?.outputTokens ?? 0 }, costUsd: { increment: new Prisma.Decimal(cost.toFixed(6)) }, processingMs: { increment: ms } },
      });
      await this.recordUsage(gen, { operation: 'IMAGE_GENERATION', model: res.model, success: true, inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, images: billed, costUsd: cost, latencyMs: ms });

      for (const [i, img] of res.images.entries()) {
        const done = await this.finishImage(img.data, p, cutout, gen.brandSnapshot, logo);
        const label = (p.type as string).toLowerCase().replace(/_/g, '-');
        const m = await this.ingestWithRetry(() =>
          this.media.ingestGenerated({ businessId: gen.businessId, userId: gen.userId }, { data: done.data, mime: 'image/jpeg', filename: `ai-${label}-${gen.id.slice(-6)}-${stored + i + 1}.jpg`, folder: 'ai-studio/images', altText: `AI-generated ${label.replace(/-/g, ' ')}`, tags: ['ai-generated'] }),
        );
        await this.prisma.creativeOutput.create({
          data: { generationId: gen.id, businessId: gen.businessId, mediaId: m.id, index: stored + i, width: p.width, height: p.height, preservation: p.preservation, upscaled: done.upscaled, revisedPrompt: res.revisedPrompt ?? null },
        });
      }
    }
    await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { status: 'SUCCEEDED', completedAt: new Date(), errorCode: null, errorMessage: null } });
    await this.usage.settle(gen.id);
  }

  // ─── Videos ─────────────────────────────────────────────────────────────────

  private async later(job: Job<CreativeJobData>, token?: string): Promise<never> {
    await job.moveToDelayed(Date.now() + this.env.CREATIVE_VIDEO_POLL_MS, token);
    throw new DelayedError();
  }

  private async runVideo(gen: CreativeGeneration, job: Job<CreativeJobData>, token?: string) {
    const provider = this.video;
    if (!provider || !provider.isConfigured()) throw new CreativeNotConfiguredError('video');
    const p = gen.params as unknown as VideoParams;
    const size = provider.capabilities.sizes[p.aspectRatio];
    if (!size) throw new CreativeJobError('VIDEO_FORMAT_UNSUPPORTED', `The video provider does not render ${p.aspectRatio}`);
    const timeoutMs = this.env.CREATIVE_PROVIDER_TIMEOUT_MS;

    if (!gen.providerRef) {
      if (gen.providerStatus === 'SUBMITTING') {
        // A previous attempt may have started the provider job but crashed before saving its id: resubmitting could bill twice.
        throw new CreativeJobError('VIDEO_SUBMIT_UNKNOWN', 'It is unknown whether the provider accepted this video job. Nothing was charged by TOUMA; check your provider dashboard before trying again.');
      }
      const source = gen.sourceMediaId && provider.capabilities.imageToVideo ? await this.media.readOriginal(gen.businessId, gen.sourceMediaId) : null;
      await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { providerStatus: 'SUBMITTING' } });
      let ref: string;
      const t0 = Date.now();
      try {
        ({ ref } = await provider.submit({ model: gen.model, prompt: gen.prompt, seconds: p.seconds, size, source: source ? { data: source.data, mime: source.mime, filename: source.filename } : undefined, timeoutMs }));
      } catch (err) {
        await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { providerStatus: null } }); // not accepted: a retry may submit again
        await this.recordUsage(gen, { operation: 'VIDEO_GENERATION', model: gen.model, success: false, error: (err as Error).message, latencyMs: Date.now() - t0 });
        throw err;
      }
      await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { providerRef: ref, providerStatus: 'SUBMITTED', processingMs: { increment: Date.now() - t0 } } });
      return this.later(job, token);
    }

    const deadline = (gen.startedAt ?? gen.queuedAt ?? gen.createdAt).getTime() + this.env.CREATIVE_VIDEO_TIMEOUT_MINUTES * 60_000;
    const st = await provider.status(gen.providerRef, timeoutMs);
    await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { pollCount: { increment: 1 }, providerStatus: st.state } });
    if (st.state === 'failed') {
      const refused = /moderation|policy|safety/i.test(`${st.error?.code} ${st.error?.message}`);
      await this.recordUsage(gen, { operation: 'VIDEO_GENERATION', model: gen.model, success: false, error: st.error?.message, latencyMs: 0 });
      throw new CreativeJobError(refused ? 'VIDEO_PROVIDER_REFUSED' : 'VIDEO_PROVIDER_FAILED', st.error?.message ?? 'The video provider could not generate this video');
    }
    if (st.state !== 'completed') {
      if (Date.now() > deadline) throw new CreativeJobError('VIDEO_TIMEOUT', `The video was not ready after ${this.env.CREATIVE_VIDEO_TIMEOUT_MINUTES} minutes and was cancelled`);
      return this.later(job, token);
    }

    const t0 = Date.now();
    const file = await provider.download(gen.providerRef, Math.floor(this.env.MEDIA_MAX_VIDEO_MB * 1024 * 1024), timeoutMs);
    const poster = provider.capabilities.thumbnail && provider.thumbnail ? await provider.thumbnail(gen.providerRef, timeoutMs).catch(() => null) : null;
    const cost = videoCostUsd(this.usage.priceFor(gen.model), p.seconds);
    // The provider has delivered (and bills) the video: count it now, so losing it to a storage problem is still accounted for
    // and the job is never retried (a retry would pay again).
    await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { producedUnits: p.seconds, costUsd: new Prisma.Decimal(cost.toFixed(6)) } });
    const mime = (file.mime in MEDIA_RULES ? file.mime : 'video/mp4') as AllowedMimeType;
    const m = await this.ingestWithRetry(() =>
      this.media.ingestGenerated({ businessId: gen.businessId, userId: gen.userId }, { data: file.data, mime, filename: `ai-video-${gen.id.slice(-6)}.${MEDIA_RULES[mime].ext}`, folder: 'ai-studio/videos', altText: 'AI-generated promotional video', poster, tags: ['ai-generated'] }),
    );
    const ms = Date.now() - t0;
    await this.prisma.creativeOutput.create({ data: { generationId: gen.id, businessId: gen.businessId, mediaId: m.id, index: 0, width: size.width, height: size.height, preservation: 'NONE' } });
    await this.prisma.creativeGeneration.update({ where: { id: gen.id }, data: { processingMs: { increment: ms }, status: 'SUCCEEDED', completedAt: new Date(), errorCode: null, errorMessage: null } });
    await this.recordUsage(gen, { operation: 'VIDEO_GENERATION', model: gen.model, success: true, videoSeconds: p.seconds, costUsd: cost, latencyMs: ms });
    await this.usage.settle(gen.id);
  }

  // ─── Self-healing ───────────────────────────────────────────────────────────

  async reconcile() {
    // Finished generations whose reservation was never settled (a crash between the last write and settle).
    const unsettled = await this.prisma.creativeGeneration.findMany({ where: { settledAt: null, status: { in: [...FINAL] } }, select: { id: true }, take: 100 });
    let settled = 0;
    for (const g of unsettled) if (await this.usage.settle(g.id)) settled++;

    // Accepted generations whose job was never created (the API crashed after the commit).
    const orphans = await this.prisma.creativeGeneration.findMany({ where: { status: 'QUEUED', queuedAt: { lt: new Date(Date.now() - 60_000) } }, select: { id: true }, take: 100 });
    let requeued = 0;
    for (const o of orphans) {
      if (!(await this.queue.getJob(o.id))) {
        await this.queue.enqueue(o.id);
        requeued++;
      }
    }
    // Generations that vanished from the queue long ago.
    const staleBefore = new Date(Date.now() - (this.env.CREATIVE_VIDEO_TIMEOUT_MINUTES + 10) * 60_000);
    const stale = await this.prisma.creativeGeneration.findMany({ where: { status: { in: ['QUEUED', 'RUNNING'] }, queuedAt: { lt: staleBefore } }, select: { id: true }, take: 100 });
    let failed = 0;
    for (const s of stale) {
      const job = await this.queue.getJob(s.id);
      const state = job ? await job.getState() : 'missing';
      if (state === 'missing' || state === 'failed' || state === 'completed') {
        await this.fail(s.id, 'CREATIVE_JOB_STALLED', 'The generation did not finish and was cancelled');
        failed++;
      }
    }
    if (settled || requeued || failed) this.logger.warn(`reconcile: settled ${settled}, re-enqueued ${requeued}, stalled ${failed}`);
    return { settled, requeued, failed };
  }
}
