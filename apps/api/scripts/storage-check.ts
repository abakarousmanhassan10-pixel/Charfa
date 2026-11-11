/**
 * Real storage verification (no mocks): upload → head → download (bytes compared) →
 * provider-presigned HTTP download → unsigned access must be denied → delete → confirm deletion.
 *   pnpm --filter @touma/api storage:check
 * Uses the S3_* variables (AWS S3, Cloudflare R2, MinIO). Exit code 0 only if every step passed.
 */
import { loadEnv } from '@touma/config';
import { verifyStorage } from '@touma/storage';
import { loadDotEnv } from '../src/load-dotenv';
import { createObjectStorage } from '../src/storage/storage.module';

async function main() {
  loadDotEnv();
  const env = loadEnv();
  if (env.STORAGE_DRIVER !== 's3') throw new Error('STORAGE_DRIVER must be s3 for a real storage check');
  const storage = createObjectStorage(env);
  if (!storage.configured) throw new Error('S3 storage is not configured (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)');
  const report = await verifyStorage(storage, { prefix: '_storage-check' });
  console.log(JSON.stringify({ provider: env.S3_PROVIDER, endpoint: env.S3_ENDPOINT ?? '(provider default)', ...report }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`Storage check failed: ${(err as Error).message}`);
  process.exit(1);
});
