import {
  BadRequestException,
  HttpException,
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
import imageSize from 'image-size';
import { Prisma, type MediaAsset } from '@touma/database';
import { MEDIA_RULES, type AllowedMimeType } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Page, pageArgs, toPage } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage';
import { MediaUrlSigner } from '../storage/signed-url';
import { sanitizeFilename, sniffMime } from '../storage/file-sniffer';
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
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
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
    let width: number | null = null;
    let height: number | null = null;
    if (rule.type === 'IMAGE') {
      try {
        const dims = imageSize(await readFile(file.path));
        width = dims.width ?? null;
        height = dims.height ?? null;
      } catch {
        return { ok: false, error: new UnsupportedMediaTypeException({ code: 'IMAGE_CORRUPT', message: 'The image could not be read' }) };
      }
      if (!width || !height || width > 20000 || height > 20000) {
        return { ok: false, error: new UnsupportedMediaTypeException({ code: 'IMAGE_DIMENSIONS', message: 'Image dimensions are invalid or too large' }) };
      }
    }
    return { ok: true, mime: sniffed, rule, width, height };
  }

  async upload(tenant: TenantContext, req: Request): Promise<MediaDto> {
    this.requireStorage();
    const file = await this.receive(req);
    try {
      const result = await this.validate(file);
      if (!result.ok) {
        await this.audit.record({
          action: 'media.upload_rejected',
          actorId: tenant.userId,
          businessId: tenant.businessId,
          metadata: { reason: (result.error.getResponse() as { code: string }).code, declared: file.declaredMime, size: file.size },
        });
        throw result.error;
      }
      const folderRaw = normalizeFolder(file.fields.folder ?? '') as string;
      const folder = FOLDER_REGEX.test(folderRaw) ? folderRaw : '';
      const altText = file.fields.altText?.trim().slice(0, 300) || null;

      const id = randomUUID().replace(/-/g, '');
      // Server-generated key, always namespaced by tenant. Never derived from user input.
      const storageKey = `businesses/${tenant.businessId}/media/${id}.${result.rule.ext}`;
      await this.storage.put(storageKey, createReadStream(file.path), { contentType: result.mime, contentLength: file.size });

      try {
        const media = await this.prisma.mediaAsset.create({
          data: {
            businessId: tenant.businessId,
            type: result.rule.type,
            status: 'READY',
            storageKey,
            originalFilename: file.filename,
            folder,
            mimeType: result.mime,
            sizeBytes: BigInt(file.size),
            width: result.width,
            height: result.height,
            checksumSha256: file.sha256,
            altText,
            uploadedById: tenant.userId,
          },
        });
        await this.audit.record({
          action: 'media.upload',
          actorId: tenant.userId,
          businessId: tenant.businessId,
          entityType: 'MediaAsset',
          entityId: media.id,
          metadata: { mime: result.mime, size: file.size },
        });
        return this.toDto(media);
      } catch (err) {
        await this.storage.delete(storageKey).catch(() => undefined);
        throw err;
      }
    } finally {
      await rm(file.path, { force: true });
    }
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

  /** Soft-deletes the record, detaches it everywhere, then removes the stored object. */
  async remove(tenant: TenantContext, id: string) {
    const media = await this.find(tenant, id);
    await this.prisma.$transaction([
      this.prisma.productMedia.deleteMany({ where: { mediaId: id } }),
      this.prisma.business.updateMany({ where: { id: tenant.businessId, logoMediaId: id }, data: { logoMediaId: null } }),
      this.prisma.mediaAsset.update({ where: { id }, data: { deletedAt: new Date() } }),
    ]);
    await this.audit.record({ action: 'media.delete', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MediaAsset', entityId: id });
    try {
      await this.storage.delete(media.storageKey);
    } catch (err) {
      // Record stays soft-deleted; an orphaned object is cleaned up by the maintenance job later.
      this.logger.warn(`Could not delete object for media ${id}: ${(err as Error).message}`);
    }
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
  async openContent(id: string, exp: number, sig: string, range?: string) {
    if (!this.signer.verify(id, exp, sig)) {
      throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
    }
    this.requireStorage();
    const media = await this.prisma.mediaAsset.findFirst({ where: { id, deletedAt: null, status: 'READY' } });
    if (!media) throw new NotFoundException({ code: 'MEDIA_NOT_FOUND', message: 'Media not found' });
    const safeRange = range && /^bytes=\d*-\d*$/.test(range) ? range : undefined;
    const object = await this.storage.get(media.storageKey, safeRange);
    return { media, object, maxAgeSeconds: Math.max(0, Math.floor((exp - Date.now()) / 1000)) };
  }
}


