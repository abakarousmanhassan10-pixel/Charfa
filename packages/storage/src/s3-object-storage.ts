import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import { ObjectStorage, StorageError, StorageNotConfiguredError, StoredObject } from './object-storage';

export type S3Provider = 'aws' | 'r2' | 'minio' | 'custom';

export interface S3StorageConfig {
  provider: S3Provider;
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Create the bucket if missing (local MinIO only; managed buckets must be provisioned explicitly). */
  autoCreateBucket?: boolean;
}

/**
 * Provider presets:
 *  - aws:   regional endpoint chosen by the SDK, virtual-hosted style.
 *  - r2:    endpoint https://<account>.r2.cloudflarestorage.com, region "auto".
 *  - minio: custom endpoint, path-style addressing.
 */
export function resolveS3Config(c: S3StorageConfig): S3StorageConfig {
  const forcePathStyle = c.forcePathStyle ?? (c.provider === 'minio' || c.provider === 'custom');
  const region = c.region || (c.provider === 'r2' ? 'auto' : undefined);
  return { ...c, forcePathStyle, region };
}

export function mapS3Error(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  if (err instanceof StorageNotConfiguredError) throw err;
  const e = err as S3ServiceException & { code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  const name = e?.name ?? '';
  if (name === 'NoSuchKey' || name === 'NotFound' || (status === 404 && name !== 'NoSuchBucket')) return new StorageError('not_found', 'Object not found');
  if (name === 'NoSuchBucket') return new StorageError('bucket_missing', 'Bucket does not exist');
  if (status === 403 || name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return new StorageError('access_denied', `Storage denied access (${name || status})`);
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(e?.code ?? '') || name === 'TimeoutError' || (status !== undefined && status >= 500)) {
    return new StorageError('unavailable', `Storage unavailable (${e?.code ?? name ?? status})`);
  }
  return new StorageError('unknown', `Storage error (${name || 'unknown'})`);
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client?: S3Client;
  private readonly bucket?: string;
  private bucketReady?: Promise<void>;
  readonly configured: boolean;
  readonly description: string;

  constructor(private readonly cfg: S3StorageConfig) {
    const c = resolveS3Config(cfg);
    this.configured = Boolean(c.bucket && c.region && c.accessKeyId && c.secretAccessKey);
    this.description = `${c.provider}${c.bucket ? `:${c.bucket}` : ''}`;
    if (!this.configured) return;
    this.bucket = c.bucket;
    this.client = new S3Client({
      region: c.region,
      endpoint: c.endpoint || undefined,
      forcePathStyle: c.forcePathStyle,
      credentials: { accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! },
      maxAttempts: 3,
    });
  }

  private requireClient(): S3Client {
    if (!this.client) throw new StorageNotConfiguredError();
    return this.client;
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const client = this.requireClient();
      try {
        await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (err) {
        const mapped = mapS3Error(err);
        if ((mapped.kind === 'not_found' || mapped.kind === 'bucket_missing') && this.cfg.autoCreateBucket) {
          await client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          return;
        }
        throw mapped.kind === 'not_found' ? new StorageError('bucket_missing', 'Bucket does not exist') : mapped;
      }
    })().catch((err) => {
      this.bucketReady = undefined;
      throw mapS3Error(err);
    });
    return this.bucketReady;
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType: string; contentLength?: number }) {
    await this.ensureBucket();
    try {
      await new Upload({
        client: this.requireClient(),
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          ContentLength: opts.contentLength,
          CacheControl: 'private, max-age=31536000, immutable',
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
      }).done();
    } catch (err) {
      throw mapS3Error(err);
    }
  }

  async get(key: string, range?: string): Promise<StoredObject> {
    try {
      const res = await this.requireClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
      return { body: res.Body as Readable, contentType: res.ContentType, contentLength: res.ContentLength, contentRange: res.ContentRange, partial: Boolean(res.ContentRange) };
    } catch (err) {
      throw mapS3Error(err);
    }
  }

  async head(key: string) {
    try {
      const res = await this.requireClient().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      const mapped = mapS3Error(err);
      if (mapped.kind === 'not_found') return null;
      throw mapped;
    }
  }

  async delete(key: string) {
    try {
      await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      const mapped = mapS3Error(err);
      if (mapped.kind !== 'not_found') throw mapped; // deleting a missing object is a success
    }
  }

  async presignGet(key: string, expiresInSeconds: number) {
    return getSignedUrl(this.requireClient(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
}
