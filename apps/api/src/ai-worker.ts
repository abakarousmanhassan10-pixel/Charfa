import 'reflect-metadata';
import { createServer } from 'http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@touma/config';
import { EnvModule } from './app.module';
import { AuditModule } from './audit/audit.module';
import { AiCoreModule } from './ai/ai.module';
import { AiWorkerService } from './ai/ai-worker.service';
import { CreativeCoreModule } from './creative/creative.module';
import { CreativeWorkerService } from './creative/creative-worker.service';
import { StorageModule } from './storage/storage.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Standalone TOUMA AI worker: consumes the text-generation queue and the creative (image and video) queue
 * without serving HTTP.
 *   node dist/ai-worker.js
 * Scale it horizontally; BullMQ guarantees one worker per job.
 */
async function main() {
  const env = loadEnv();
  @Module({ imports: [EnvModule.forRoot(env), PrismaModule, AuditModule, StorageModule, AiCoreModule, CreativeCoreModule] })
  class AiWorkerRootModule {}

  const app = await NestFactory.createApplicationContext(AiWorkerRootModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const worker = app.get(AiWorkerService);
  const creativeWorker = app.get(CreativeWorkerService);
  // Both workers run in this process, whatever AI_WORKER_INLINE says (start() is idempotent).
  await worker.start();
  await creativeWorker.start();
  const health = createServer((req, res) => {
    const ok = worker.running && creativeWorker.running;
    res.writeHead(req.url === '/health' ? (ok ? 200 : 503) : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded' }));
  }).listen(env.AI_WORKER_HEALTH_PORT);
  const stop = async () => {
    health.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
