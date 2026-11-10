import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { loadEnv } from '@aima/config';
import { PrismaClient } from '@aima/database';
import { DEFAULT_JOB_OPTIONS, MaintenanceJob, QUEUES } from './queues';
import { purgeExpiredSessions } from './jobs/purge-sessions';

const log = (msg: string) => console.log(`[worker] ${new Date().toISOString()} ${msg}`);

async function main() {
  const env = loadEnv();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const prisma = new PrismaClient();

  const maintenance = new Queue<MaintenanceJob>(QUEUES.maintenance, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  // Repeatable job scheduler: idempotent upsert by scheduler id, safe across restarts and replicas.
  await maintenance.upsertJobScheduler(
    'purge-expired-sessions',
    { pattern: '17 3 * * *', tz: 'UTC' },
    { name: 'purge-expired-sessions', data: { type: 'purge-expired-sessions' } },
  );

  const worker = new Worker<MaintenanceJob>(
    QUEUES.maintenance,
    async (job) => {
      switch (job.data.type) {
        case 'purge-expired-sessions': {
          const n = await purgeExpiredSessions(prisma);
          log(`purged ${n} expired sessions`);
          return { purged: n };
        }
        default:
          throw new Error(`Unknown maintenance job: ${(job.data as { type: string }).type}`);
      }
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => log(`job ${job?.id} (${job?.name}) failed: ${err.message}`));
  log(`listening on ${QUEUES.maintenance}`);

  const shutdown = async (signal: string) => {
    log(`${signal} received, draining`);
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
