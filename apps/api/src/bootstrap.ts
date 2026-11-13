import { INestApplication, Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppEnv } from '@touma/config';
import { BRAND } from '@touma/shared';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { CSRF_HEADER } from './auth/csrf.guard';

export const API_PREFIX = 'api';

export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle(`${BRAND.productName} API`)
    .setDescription(`${BRAND.slogan.en} — ${BRAND.name} REST API v1`)
    .setVersion('1.0.0')
    .addBearerAuth()
    .addCookieAuth('touma_rt')
    .build();
  return SwaggerModule.createDocument(app, config);
}

export async function createApp(env: AppEnv, opts: { logger?: false } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    logger: opts.logger === false ? false : ['error', 'warn', 'log'],
    bufferLogs: false,
    // Webhook signatures are computed over the exact bytes the platform sent.
    rawBody: true,
  });

  // Only the configured number of proxy hops is believed (TRUST_PROXY_HOPS); client-supplied X-Forwarded-For entries beyond it are ignored.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER, 'x-request-id', 'x-business-id', 'x-chat-token', 'range'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (env.APP_ENV !== 'production') {
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, buildOpenApi(app));
    Logger.log(`Swagger UI available at /${API_PREFIX}/docs`, 'Bootstrap');
  }
  return app;
}
