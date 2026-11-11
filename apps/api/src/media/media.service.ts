import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import Busboy from 'busboy';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { open, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import type { Request } from 'express';
import { Prisma, type MediaAsset } from '@touma/database';
import { MEDIA_RULES, type AllowedMimeType } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Page, pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import { OBJECT_STORAGE, sanitizeFilename, sniffMime, StorageError, type ObjectStorage } from '@touma/storage';
import { MediaUrlSigner, type MediaVariant } from '../storage/signed-url';
import { StorageDeletionQueue } from '../storage/deletion-queue';
import { ImageRejectedError, processImage } from './image-processor';
import { MALWARE_SCANNER, ScannerUnavailableError, type MalwareScanner } from './malware-scanner';
import { FOLDER_REGEX, normalizeFolder, type MediaQueryDto, type UpdateMediaDto } from './media.dto';

export interface MediaDto {
  id: string;
  type: MediaAsset['type'];
  status: MediaAsset['status'];
  mimeType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  originalFilename: string;
  folder: string;
  tags: string[];
  altText: string | null;
  createdAt: Date;
  url: string | null;
  thumbnailUrl: string | null;
  scanStatus: MediaAsset['scanStatus'];
}

interface ReceivedFile {
  path: string;
  declaredMime: string;
  filename: string;
  size: number;
  sha256: string;
  fields: Record<string, string>;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly signer: MediaUrlSigner,
    private readonly deletions: StorageDeletionQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  toDto(m: MediaAsset): MediaDto {
    return {
      id: m.id,
      type: m.type,
      status: m.status,
      mimeType: m.mimeType,
      sizeBytes: m.sizeBytes === null ? null : Number(m.sizeBytes),
      width: m.width,
      height: m.height,
      originalFilename: m.originalFilename,
      folder: m.folder,
      tags: m.tags,
      altText: m.altText,
      createdAt: m.createdAt,
      url: m.status === 'READY' && !m.deletedAt ? this.signer.url(m.id) : null,
      thumbnailUrl: m.status === 'READY' && !m.deletedAt && m.thumbnailKey ? this.signer.url(m.id, Date.now(), 'thumb') : null,
      scanStatus: m.scanStatus,
    };
  }

  private get maxImageBytes() {
    return Math.floor(this.env.MEDIA_MAX_IMAGE_MB * 1024 * 1024);
  }
  private get maxVideoBytes() {
    return Math.floor(this.env.MEDIA_MAX_VIDEO_MB * 1024 * 1024);
  }

  private requireStorage() {
    if (!this.storage.configured) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'Media storage is not configured on this server',
      });
    }
  }

  /** Streams the single multipart file to a private temp file, enforcing the absolute size cap. */
  private receive(req: Request): Promise<ReceivedFile> {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      throw new BadRequestException({ code: 'MULTIPART_REQUIRED', message: 'Send the file as multipart/form-data' });
    }
    const hardLimit = Math.max(this.maxImageBytes, this.maxVideoBytes);
    return new Promise<ReceivedFile>((resolve, reject) => {
      const fields: Record<string, string> = {};
      let file: Promise<Omit<ReceivedFile, 'fields'>> | null = null;
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        reject(err);
      };
      let bb: ReturnType<typeof Busboy>;
      try {
        bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: hardLimit, fields: 10, fieldSize: 2048, parts: 12 } });
      } catch {
        throw new BadRequestException({ code: 'MULTIPART_INVALID', message: 'Malformed multipart body' });
      }
      bb.on('field', (name, value) => {
        if (['folder', 'altText'].includes(name)) fields[name] = value;
      });
      bb.on('file', (_name, stream, info) => {
        const path = join(tmpdir(), `touma-upload-${randomUUID()}`);
        const hash = createHash('sha256');
        let size = 0;
        let truncated = false;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          hash.update(chunk);
        });
        stream.on('limit', () => {
          truncated = true;
        });
        file = pipeline(stream, createWriteStream(path, { mode: 0o600 })).then(async () => {
          if (truncated) {
            await rm(path, { force: true });
            throw new PayloadTooLargeException({ code: 'FILE_TOO_LARGE', message: `File exceeds ${Math.round(hardLimit / 1048576)} MB` });
          }
          return { path, declaredMime: info.mimeType, filename: sanitizeFilename(info.filename ?? 'file'), size, sha256: hash.digest('hex') };
        });
        file.catch(fail);
      });
      bb.on('error', () => fail(new BadRequestException({ code: 'MULTIPART_INVALID', message: 'Malformed multipart body' })));
      bb.on('partsLimit', () => fail(new BadRequestException({ code: 'MULTIPART_INVALID', message: 'Too many parts' })));
      bb.on('filesLimit', () => fail(new BadRequestException({ code: 'ONE_FILE_ONLY', message: 'Upload one file per request' })));
      bb.on('close', async () => {
        if (failed) return;
        if (!file) return fail(new BadRequestException({ code: 'FILE_REQUIRED', message: 'No file was uploaded' }));
        try {
          resolve({ ...(await file), fields });
        } catch (err) {
          fail(err as Error);
        }
      });
      req.on('aborted', () => fail(new BadRequestException({ code: 'UPLOAD_ABORTED', message: 'Upload aborted' })));
      req.pipe(bb);
    });
  }

  private async validate(file: ReceivedFile): Promise<{ ok: false; error: HttpException } | { ok: true; mime: AllowedMimeType; rule: (typeof MEDIA_RULES)[AllowedMimeType]; width: number | null; height: number | null }> {
    const fh = await open(file.path, 'r');
    const head = Buffer.alloc(4100);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    await fh.close();
    const sniffed = sniffMime(head.subarray(0, bytesRead));
    if (!sniffed) {
      return { ok: false, error: new UnsupportedMediaTypeException({ code: 'UNSUPPORTED_FILE_TYPE', message: 'Allowed: JPEG, PNG, WebP, GIF, MP4, MOV, WebM' }) };
    }
    if (file.declaredMime !== sniffed) {
      return {
        ok: false,
        error: new UnsupportedMediaTypeException({
          code: 'FILE_TYPE_MISMATCH',
          message: `File content (${sniffed}) does not match its declared type (${file.declaredMime})`,
        }),
      };
    }
    const rule = MEDIA_RULES[sniffed];
    const max = rule.type === 'IMAGE' ? this.maxImageBytes : this.maxVideoBytes;
    if (file.size === 0) return { ok: false, error: new BadRequestException({ code: 'FILE_EMPTY', message: 'The file is empty' }) };
    if (file.size > max) {
      return { ok: false, error: new PayloadTooLargeException({ code: 'FILE_TOO_LARGE', message: `${rule.type === 'IMAGE' ? 'Images' : 'Videos'} are limited to ${Math.round(max / 1048576)} MB` }) };
    }
    return { ok: true, mime: sniffed, rule, width: null, height: null };
  }

  /** Bytes used by a business (originals + thumbnails of live media) and its quota. */
  async usage(businessId: string) {
    const [agg, business] = await Promise.all([
      this.prisma.mediaAsset.aggregate({ where: { businessId, deletedAt: null }, _sum: { sizeBytes: true, thumbnailSizeBytes: true }, _count: { _all: true } }),
      this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { storageQuotaBytes: true } }),
    ]);
    const used = Number(agg._sum.sizeBytes ?? 0n) + Number(agg._sum.thumbnailSizeBytes ?? 0n);
    const quota = business.storageQuotaBytes !== null ? Number(business.storageQuotaBytes) : Math.floor(this.env.MEDIA_STORAGE_QUOTA_MB * 1024 * 1024);
    return { usedBytes: used, quotaBytes: quota, files: agg._count._all };
  }

  private quotaError(u: { usedBytes: number; quotaBytes: number }) {
    return new HttpException(
      { code: 'STORAGE_QUOTA_EXCEEDED', message: `Storage quota exceeded (${Math.round(u.usedBytes / 1048576)} of ${Math.round(u.quotaBytes / 1048576)} MB used)` },
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }

  private async reject(tenant: TenantContext, file: ReceivedFile, error: HttpException, extra: Record<string, unknown> = {}) {
    await this.audit.record({
      action: 'media.upload_rejected',
      actorId: tenant.userId,
      businessId: tenant.businessId,
      metadata: { reason: (error.getResponse() as { code: string }).code, declared: file.declaredMime, size: file.size, ...extra },
    });
    return error;
  }

  /**
   * Upload pipeline: receive (size cap) → magic-byte type check → per-type size limit →
   * quota pre-check → malware scan (fail closed) → images: decode, re-encode, strip metadata,
   * thumbnail → quota check on final sizes → private storage under the tenant prefix → record.
   */
  async upload(tenant: TenantContext, req: Request): Promise<MediaDto> {
    this.requireStorage();
    const declared = Number(req.headers['content-length'] ?? 0);
    const before = await this.usage(tenant.businessId);
    if (declared > 0 && before.usedBytes + declared > before.quotaBytes * 1.05) throw this.quotaError(before);

    const file = await this.receive(req);
    const keys: string[] = [];
    try {
      const result = await this.validate(file);
      if (!result.ok) throw await this.reject(tenant, file, result.error);

      // Malware scan of the bytes exactly as uploaded.
      let scan: Awaited<ReturnType<MalwareScanner['scanFile']>>;
      try {
        scan = await this.scanner.scanFile(file.path);
      } catch (err) {
        if (err instanceof ScannerUnavailableError) {
          this.logger.error(`Malware scan unavailable: ${err.message}`);
          throw await this.reject(tenant, file, new ServiceUnavailableException({ code: 'SCAN_UNAVAILABLE', message: 'Uploads are temporarily unavailable (virus scanning failed). Try again later.' }));
        }
        throw err;
      }
      if (scan.status === 'INFECTED') {
        throw await this.reject(tenant, file, new HttpException({ code: 'MALWARE_DETECTED', message: 'The file was rejected by the virus scanner' }, HttpStatus.UNPROCESSABLE_ENTITY), { signature: scan.signature });
      }

      let body: Buffer | null = null;
      let thumb: Buffer | null = null;
      let width: number | null = null;
      let height: number | null = null;
      if (result.rule.type === 'IMAGE') {
        try {
          const processed = await processImage(await readFile(file.path), result.mime, this.env.MEDIA_MAX_IMAGE_PIXELS);
          ({ data: body, thumbnail: thumb, width, height } = processed);
        } catch (err) {
          if (err instanceof ImageRejectedError) throw await this.reject(tenant, file, new UnsupportedMediaTypeException({ code: err.code, message: err.message }));
          throw err;
        }
      }
      const storedSize = body ? body.length : file.size;
      const thumbSize = thumb ? thumb.length : 0;
      const usage = await this.usage(tenant.businessId);
      if (usage.usedBytes + storedSize + thumbSize > usage.quotaBytes) throw await this.reject(tenant, file, this.quotaError(usage));

      const id = randomUUID().replace(/-/g, '');
      // Server-generated keys, always namespaced by tenant. Never derived from user input.
      const storageKey = `businesses/${tenant.businessId}/media/${id}.${result.rule.ext}`;
      const thumbnailKey = thumb ? `businesses/${tenant.businessId}/media/thumbs/${id}.webp` : null;
      try {
        await this.storage.put(storageKey, body ?? createReadStream(file.path), { contentType: result.mime, contentLength: storedSize });
        keys.push(storageKey);
        if (thumb && thumbnailKey) {
          await this.storage.put(thumbnailKey, thumb, { contentType: 'image/webp', contentLength: thumb.length });
          keys.push(thumbnailKey);
        }
      } catch (err) {
        throw this.storageFailure(err);
      }

      const folderRaw = normalizeFolder(file.fields.folder ?? '') as string;
      const media = await this.prisma.mediaAsset.create({
        data: {
          businessId: tenant.businessId,
          type: result.rule.type,
          status: 'READY',
          storageKey,
          thumbnailKey,
          originalFilename: file.filename,
          folder: FOLDER_REGEX.test(folderRaw) ? folderRaw : '',
          mimeType: result.mime,
          sizeBytes: BigInt(storedSize),
          originalSizeBytes: BigInt(file.size),
          thumbnailSizeBytes: thumb ? BigInt(thumbSize) : null,
          width,
          height,
          checksumSha256: body ? createHash('sha256').update(body).digest('hex') : file.sha256,
          altText: file.fields.altText?.trim().slice(0, 300) || null,
          scanStatus: scan.status,
          scanEngine: this.scanner.engine,
          scannedAt: scan.status === 'SKIPPED' ? null : new Date(),
          uploadedById: tenant.userId,
        },
      });
      keys.length = 0; // committed: keep the objects
      await this.audit.record({
        action: 'media.upload',
        actorId: tenant.userId,
        businessId: tenant.businessId,
        entityType: 'MediaAsset',
        entityId: media.id,
        metadata: { mime: result.mime, size: storedSize, originalSize: file.size, scan: scan.status },
      });
      return this.toDto(media);
    } finally {
      await rm(file.path, { force: true });
      // Anything stored but not committed is removed (via the durable queue if storage fails).
      if (keys.length) await this.deletions.deleteKeys(keys, { businessId: tenant.businessId, reason: 'upload-rollback' }).catch(() => undefined);
    }
  }

  private storageFailure(err: unknown) {
    if (err instanceof StorageError) {
      this.logger.error(`Storage ${err.kind}: ${err.message}`);
      return new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE', message: 'Media storage is temporarily unavailable' });
    }
    return err as Error;
  }

  async list(tenant: TenantContext, q: MediaQueryDto): Promise<Page<MediaDto>> {
    const where: Prisma.MediaAssetWhereInput = {
      businessId: tenant.businessId,
      deletedAt: null,
      status: 'READY',
      ...(q.type ? { type: q.type } : {}),
      ...(q.folder !== undefined ? { folder: q.folder } : {}),
      ...(q.q
        ? {
            OR: [
              { originalFilename: { contains: q.q, mode: 'insensitive' } },
              { altText: { contains: q.q, mode: 'insensitive' } },
              { tags: { has: q.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return toPage(items.map((m) => this.toDto(m)), total, q);
  }

  async folders(tenant: TenantContext) {
    const rows = await this.prisma.mediaAsset.groupBy({
      by: ['folder'],
      where: { businessId: tenant.businessId, deletedAt: null, status: 'READY' },
      _count: { _all: true },
      orderBy: { folder: 'asc' },
    });
    return rows.map((r) => ({ folder: r.folder, count: r._count._all }));
  }

  private async find(tenant: TenantContext, id: string) {
    const media = await this.prisma.mediaAsset.findFirst({ where: { id, businessId: tenant.businessId, deletedAt: null } });
    if (!media) throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
    return media;
  }

  async get(tenant: TenantContext, id: string) {
    const media = await this.find(tenant, id);
    const [products, logoOf] = await Promise.all([
      this.prisma.productMedia.findMany({
        where: { mediaId: id, product: { businessId: tenant.businessId, deletedAt: null } },
        select: { product: { select: { id: true, name: true } } },
      }),
      this.prisma.business.count({ where: { id: tenant.businessId, logoMediaId: id } }),
    ]);
    return { ...this.toDto(media), usage: { products: products.map((p) => p.product), businessLogo: logoOf > 0 } };
  }

  async update(tenant: TenantContext, id: string, dto: UpdateMediaDto) {
    await this.find(tenant, id);
    const media = await this.prisma.mediaAsset.update({
      where: { id },
      data: { altText: dto.altText, folder: dto.folder, tags: dto.tags?.map((t) => t.toLowerCase()) },
    });
    return this.toDto(media);
  }

  /** Soft-deletes the record, detaches it everywhere, then removes the stored objects through the durable deletion queue. */
  async remove(tenant: TenantContext, id: string) {
    const media = await this.find(tenant, id);
    await this.prisma.$transaction([
      this.prisma.productMedia.deleteMany({ where: { mediaId: id } }),
      this.prisma.business.updateMany({ where: { id: tenant.businessId, logoMediaId: id }, data: { logoMediaId: null } }),
      this.prisma.mediaAsset.update({ where: { id }, data: { deletedAt: new Date() } }),
    ]);
    await this.audit.record({ action: 'media.delete', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MediaAsset', entityId: id });
    await this.deletions.deleteKeys([media.storageKey, media.thumbnailKey], { businessId: tenant.businessId, reason: 'media-delete' });
  }

  /** Ownership check used by other modules before linking media (products, logo). */
  async assertUsable(businessId: string, ids: string[], type?: 'IMAGE' | 'VIDEO') {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await this.prisma.mediaAsset.findMany({
      where: { id: { in: unique }, businessId, deletedAt: null, status: 'READY', ...(type ? { type } : {}) },
    });
    if (found.length !== unique.length) {
      throw new BadRequestException({ code: 'INVALID_MEDIA', message: 'One or more media items do not exist in this business' });
    }
    return found;
  }

  urlFor(mediaId: string | null | undefined) {
    return mediaId ? this.signer.url(mediaId) : null;
  }

  /** Public (signature-authorised) content delivery. */
  async openContent(id: string, exp: number, sig: string, range?: string, variant: MediaVariant = 'original') {
    if (!this.signer.verify(id, exp, sig, Date.now(), variant)) {
      throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
    }
    this.requireStorage();
    const media = await this.prisma.mediaAsset.findFirst({ where: { id, deletedAt: null, status: 'READY' } });
    const key = variant === 'thumb' ? media?.thumbnailKey : media?.storageKey;
    if (!media || !key) throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
    const safeRange = range && /^bytes=\d*-\d*$/.test(range) ? range : undefined;
    let object;
    try {
      object = await this.storage.get(key, safeRange);
    } catch (err) {
      if (err instanceof StorageError && err.kind === 'not_found') throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
      throw this.storageFailure(err);
    }
    return { media, object, contentType: variant === 'thumb' ? 'image/webp' : media.mimeType, maxAgeSeconds: Math.max(0, Math.floor((exp - Date.now()) / 1000)) };
  }
}


