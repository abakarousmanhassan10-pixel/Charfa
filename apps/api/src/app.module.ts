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
import { RedisModule } from './health/redis.provider';
import { TenancyModule } from './tenancy/tenancy.module';
import { BusinessesModule } from './businesses/businesses.module';
import { AdminModule } from './admin/admin.module';

@Global()
@Module({})
class EnvModule {
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
        ThrottlerModule.forRoot([{ name: 'default', ttl: env.THROTTLE_TTL_MS, limit: env.THROTTLE_LIMIT }]),
        PrismaModule,
        RedisModule,
        CryptoModule,
        AuditModule,
        AuthModule,
        TenancyModule,
        UsersModule,
        BusinessesModule,
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
