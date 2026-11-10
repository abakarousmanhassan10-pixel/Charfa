import { Global, Module } from '@nestjs/common';
import { APP_ENV, AppEnv } from '../config';
import { OBJECT_STORAGE } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';
import { MemoryObjectStorage } from './memory-object-storage';
import { MediaUrlSigner } from './signed-url';

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [APP_ENV],
      // The env loader guarantees "memory" can only be selected with APP_ENV=test.
      useFactory: (env: AppEnv) => (env.STORAGE_DRIVER === 'memory' ? new MemoryObjectStorage() : new S3ObjectStorage(env)),
    },
    {
      provide: MediaUrlSigner,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => new MediaUrlSigner(env.TOKEN_ENCRYPTION_KEY, env.MEDIA_URL_TTL_SECONDS),
    },
  ],
  exports: [OBJECT_STORAGE, MediaUrlSigner],
})
export class StorageModule {}
