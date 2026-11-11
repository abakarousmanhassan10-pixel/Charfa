import { createServer } from 'http';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadEnv } from '@touma/config';
import { PrismaClient } from '@touma/database';
import { MemoryObjectStorage, S3ObjectStorage, type ObjectStorage } from '@touma/storage';
import { DEFAULT_JOB_OPTIONS, MaintenanceJob, QUEUES } from './queues';
import { purgeExpiredSessions } from './jobs/purge-sessions';
import { processPendingDeletions, purgeAuthTokens } from './jobs/storage-cleanup';

const log = (msg: string) => console.log(`[worker] ${new Date().toISOString()} ${msg}`);
const HEARTBEAT_KEY = 'touma:worker:heartbeat';

async function main() {
  const env = loadEnv();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const prisma = new PrismaClient();
  const storage: ObjectStorage =
    env.STORAGE_DRIVER === 'memory'
      ? new MemoryObjectStorage()
      : new S3ObjectStorage({
          provider: env.S3_PROVIDER,
          bucket: env.S3_BUCKET,
          region: env.S3_REGION,
          endpoint: env.S3_ENDPOINT,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        });

  const maintenance = new Queue<MaintenanceJob>(QUEUES.maintenance, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  // Idempotent schedulers: safe across restarts and replicas.
  await maintenance.upsertJobScheduler('purge-expired-sessions', { pattern: '17 3 * * *', tz: 'UTC' }, { name: 'purge-expired-sessions', data: { type: 'purge-expired-sessions' } });
  await maintenance.upsertJobScheduler('storage-cleanup', { every: 10 * 60_000 }, { name: 'storage-cleanup', data: { type: 'storage-cleanup' } });
  await maintenance.upsertJobScheduler('purge-auth-tokens', { pattern: '43 4 * * *', tz: 'UTC' }, { name: 'purge-auth-tokens', data: { type: 'purge-auth-tokens' } });

  const worker = new Worker<MaintenanceJob>(
    QUEUES.maintenance,
    async (job) => {
      switch (job.data.type) {
        case 'purge-expired-sessions': {
          const n = await purgeExpiredSessions(prisma);
          log(`purged ${n} expired sessions`);
          return { purged: n };
        }
        case 'storage-cleanup': {
          if (!storage.configured) return { skipped: 'storage not configured' };
          const r = await processPendingDeletions(prisma, storage);
          if (r.processed) log(`storage cleanup: ${r.deleted} deleted, ${r.failed} still failing`);
          return r;
        }
        case 'purge-auth-tokens': {
          const n = await purgeAuthTokens(prisma);
          log(`purged ${n} auth tokens`);
          return { purged: n };
        }
        default:
          throw new Error(`Unknown maintenance job: ${(job.data as { type: string }).type}`);
      }
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => log(`job ${job?.id} (${job?.name}) failed: ${err.message}`));

  // Heartbeat read by the API readiness endpoint, and a tiny HTTP health endpoint for containers.
  const beat = () => connection.set(HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch(() => undefined);
  await beat();
  const heartbeat = setInterval(beat, 30_000);
  const health = createServer((req, res) => {
    const ok = connection.status === 'ready' && worker.isRunning();
    res.writeHead(req.url === '/health' && ok ? 200 : req.url === '/health' ? 503 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', redis: connection.status }));
  }).listen(env.WORKER_HEALTH_PORT);
  log(`listening on ${QUEUES.maintenance}; health on :${env.WORKER_HEALTH_PORT}`);

  const shutdown = async (signal: string) => {
    log(`${signal} received, draining`);
    clearInterval(heartbeat);
    health.close();
    await worker.close();
    await maintenance.close();
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
