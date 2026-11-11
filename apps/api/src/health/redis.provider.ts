import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_ENV, AppEnv } from '../config';

export const REDIS = Symbol('REDIS');

class RedisCloser implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) =>
        new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, connectTimeout: 5000 }),
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class RedisModule {}
