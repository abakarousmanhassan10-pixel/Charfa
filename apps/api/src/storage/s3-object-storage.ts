import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Logger } from '@nestjs/common';
import type { Readable } from 'stream';
import type { AppEnv } from '@touma/config';
import { ObjectStorage, StorageNotConfiguredError, StoredObject } from './object-storage';

export class S3ObjectStorage implements ObjectStorage {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly client?: S3Client;
  private readonly bucket?: string;
  private bucketReady?: Promise<void>;
  readonly configured: boolean;

  constructor(env: AppEnv) {
    this.configured = Boolean(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
    if (!this.configured) return;
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    });
  }

  private requireClient(): S3Client {
    if (!this.client) throw new StorageNotConfiguredError();
    return this.client;
  }

  /** Creates the bucket on first use when allowed (local MinIO); managed buckets must already exist. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const client = this.requireClient();
      try {
        await client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket ${this.bucket}`);
      }
    })().catch((err) => {
      this.bucketReady = undefined;
      throw err;
    });
    return this.bucketReady;
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType: string; contentLength?: number }) {
    await this.ensureBucket();
    const upload = new Upload({
      client: this.requireClient(),
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
        // Objects are never public; access only through signed API URLs.
        CacheControl: 'private, max-age=31536000, immutable',
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
  }

  async get(key: string, range?: string): Promise<StoredObject> {
    const res = await this.requireClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
    return {
      body: res.Body as Readable,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      contentRange: res.ContentRange,
      partial: Boolean(res.ContentRange),
    };
  }

  async delete(key: string) {
    await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
