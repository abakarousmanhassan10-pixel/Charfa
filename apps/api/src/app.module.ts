import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_ENV, AppEnv } from './config';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';
import { REDIS, RedisModule } from './health/redis.provider';
import { RedisThrottlerStorage } from './common/throttle/redis-throttler.storage';
import type Redis from 'ioredis';
import { TenancyModule } from './tenancy/tenancy.module';
import { BusinessesModule } from './businesses/businesses.module';
import { AdminModule } from './admin/admin.module';
import { StorageModule } from './storage/storage.module';
import { MediaModule } from './media/media.module';
import { CategoriesModule } from './categories/categories.module';
import { ProductsModule } from './products/products.module';
import { ServicesModule } from './services/services.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { AiModule } from './ai/ai.module';
import { CalendarModule } from './calendar/calendar.module';
import { CreativeModule } from './creative/creative.module';
import { SocialModule } from './social/social.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EmailModule } from './email/email.module';
import { InvitationsModule } from './invitations/invitations.module';

@Global()
@Module({})
export class EnvModule {
  static forRoot(env: AppEnv): DynamicModule {
    return { module: EnvModule, providers: [{ provide: APP_ENV, useValue: env }], exports: [APP_ENV] };
  }
}

@Module({})
export class AppModule {
  static forRoot(env: AppEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        ThrottlerModule.forRootAsync({
          inject: [REDIS],
          useFactory: (redis: Redis) => ({
            throttlers: [{ name: 'default', ttl: env.THROTTLE_TTL_MS, limit: env.THROTTLE_LIMIT }],
            // Shared counters across all API instances; memory only for single-instance development.
            storage: env.RATE_LIMIT_STORE === 'redis' ? new RedisThrottlerStorage(redis) : undefined,
          }),
        }),
        PrismaModule,
        RedisModule,
        CryptoModule,
        AuditModule,
        EmailModule,
        AuthModule,
        InvitationsModule,
        TenancyModule,
        UsersModule,
        StorageModule,
        MediaModule,
        CategoriesModule,
        BusinessesModule,
        ProductsModule,
        ServicesModule,
        KnowledgeModule,
        AiModule,
        CreativeModule,
        CalendarModule,
        NotificationsModule,
        SocialModule,
        AdminModule,
        HealthModule,
      ],
      providers: [
        // Order matters: rate limiting runs before authentication.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    };
  }
}
