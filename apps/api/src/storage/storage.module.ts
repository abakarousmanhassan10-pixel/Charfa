import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { MemoryObjectStorage, OBJECT_STORAGE, S3ObjectStorage, verifyStorage, type ObjectStorage, type VerificationReport } from '@touma/storage';
import { APP_ENV, AppEnv } from '../config';
import { MediaUrlSigner } from './signed-url';
import { StorageDeletionQueue } from './deletion-queue';
import { ClamAvScanner, MALWARE_SCANNER, NoopScanner } from '../media/malware-scanner';

export function createObjectStorage(env: AppEnv): ObjectStorage {
  // The env loader guarantees "memory" can only be selected with APP_ENV=test.
  if (env.STORAGE_DRIVER === 'memory') return new MemoryObjectStorage();
  return new S3ObjectStorage({
    provider: env.S3_PROVIDER,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    autoCreateBucket: env.S3_AUTO_CREATE_BUCKET,
  });
}

/**
 * Storage is only reported as working after a real round trip (upload, download, presigned
 * download, delete) succeeded. Results are cached to keep health checks cheap.
 */
@Injectable()
export class StorageHealthService {
  private readonly logger = new Logger(StorageHealthService.name);
  private last?: VerificationReport;
  private running?: Promise<VerificationReport>;

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async status(maxAgeMs = 5 * 60_000) {
    if (!this.storage.configured) return { state: 'not_configured' as const, storage: this.storage.description };
    if (this.env.STORAGE_DRIVER === 'memory') return { state: 'test_only' as const, storage: this.storage.description };
    const fresh = this.last && Date.now() - Date.parse(this.last.checkedAt) < maxAgeMs;
    if (!fresh) {
      this.running ??= verifyStorage(this.storage).finally(() => (this.running = undefined));
      this.last = await this.running;
      if (!this.last.ok) this.logger.warn(`Storage verification failed: ${JSON.stringify(this.last.steps.filter((s) => !s.ok))}`);
    }
    return { state: this.last!.ok ? ('verified' as const) : ('failing' as const), storage: this.storage.description, checkedAt: this.last!.checkedAt, steps: this.last!.steps };
  }
}

@Global()
@Module({
  providers: [
    { provide: OBJECT_STORAGE, inject: [APP_ENV], useFactory: createObjectStorage },
    { provide: MediaUrlSigner, inject: [APP_ENV], useFactory: (env: AppEnv) => new MediaUrlSigner(env.TOKEN_ENCRYPTION_KEY, env.MEDIA_URL_TTL_SECONDS) },
    {
      provide: MALWARE_SCANNER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => (env.MALWARE_SCANNER === 'clamav' ? new ClamAvScanner(env.CLAMAV_HOST, env.CLAMAV_PORT, env.CLAMAV_TIMEOUT_MS) : new NoopScanner()),
    },
    StorageDeletionQueue,
    StorageHealthService,
  ],
  exports: [OBJECT_STORAGE, MediaUrlSigner, MALWARE_SCANNER, StorageDeletionQueue, StorageHealthService],
})
export class StorageModule {}
