# Testing

| Suite | Command | Needs |
|---|---|---|
| Unit (all packages) | `pnpm test` | nothing |
| API integration (real DB) | `pnpm test:e2e` | PostgreSQL + Redis; uses `touma_test` |
| Full-stack browser | `pnpm test:web-e2e` | built api + web; PostgreSQL + Redis |
| Malware scanning (part of `test:e2e`) | `infrastructure/clamav/start-test-clamd.sh` first | `clamav-daemon` installed; fails (not skips) if clamd is down |
| Real object storage | `pnpm --filter @touma/api storage:check` and `pnpm --filter @touma/api test:real-storage` | a real AWS S3 / R2 / MinIO bucket and `S3_*` variables; skipped and reported as NOT RUN otherwise |
| AI jobs, usage and quality (part of `test:e2e`) | `ai-jobs`, `ai-quality`, `ai` specs | PostgreSQL + Redis (BullMQ); the worker runs inline (`AI_WORKER_INLINE=true`); the AI provider is the test-only deterministic one |
| Lint | `pnpm lint` | nothing |

### Real storage with local MinIO
```bash
docker compose -f infrastructure/docker/docker-compose.yml -f infrastructure/docker/docker-compose.minio-bitnami.yml \
  --env-file <file with MINIO_ROOT_USER / MINIO_ROOT_PASSWORD> up -d minio
export STORAGE_DRIVER=s3 S3_PROVIDER=minio S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1 \
  S3_BUCKET=touma-media-dev S3_ACCESS_KEY_ID=<user> S3_SECRET_ACCESS_KEY=<password> S3_AUTO_CREATE_BUCKET=true
pnpm --filter @touma/api storage:check
pnpm --filter @touma/api test:real-storage
```
The real-storage suite checks the bytes in the bucket with an independent client, bucket privacy, tenant isolation and role permissions on stored files, and typed errors (wrong credentials, missing bucket, missing object). Use development-only credentials.

## Test database

```bash
createdb -O touma touma_test   # docker compose creates it automatically
```
`apps/api/test/global-setup.js` runs `prisma migrate deploy` against `TEST_DATABASE_URL` (default `postgresql://touma:touma_dev_password@localhost:5432/touma_test`), the same way production applies migrations.

## Playwright

```bash
pnpm --filter @touma/api build
API_URL=http://localhost:4100 pnpm --filter @touma/web build
pnpm test:web-e2e
```
Playwright starts the API on :4100 and the web app on :3100 against the test database.

## Email in tests
Email flows use real SMTP: API integration tests and `tests/e2e/account.e2e.ts` start a local capture server (`apps/api/test/mailbox.ts`, `smtp-server`) and follow the links from the delivered messages. During the Playwright run, other spec files log `ECONNREFUSED 127.0.0.1:2626` for the verification email sent at registration. That's expected: sending is non-fatal and only `account.e2e.ts` listens.

## Rules
- No mocked services in integration/E2E suites. Mocks are only used in unit tests.
- A feature is not done until its unit, authorization and tenant-isolation tests pass.
- CI (`.github/workflows/ci.yml`) also checks that migrations match the Prisma schema (`prisma migrate diff --exit-code`).

## Creative Studio tests
API: `apps/api/test/creative-{images,video,throttle}.e2e-spec.ts` run with the test-only fake providers (stubbed HTTP for the OpenAI adapters in `packages/creative`). Browser: `tests/e2e/creative.e2e.ts` including 390×844 mobile checks. These prove the workflows, not real provider output.

## Calendar tests
API: `apps/api/test/calendar{,-plan,-worker}.e2e-spec.ts` (real PostgreSQL, Redis, BullMQ; test-only AI provider; the publisher is scripted, there is no real one). Unit: `packages/shared/src/timezone.spec.ts`, `packages/ai-engine/src/content-plan.spec.ts`. Browser: `tests/e2e/calendar.e2e.ts` (includes 390×844 phone checks). The scheduler tick is driven by the tests (`CALENDAR_TICK_MS` is set very high).

## Social tests
Unit: `packages/social-connectors/src/adapters.spec.ts` (stubbed network). API: `apps/api/test/social-{accounts,publishing}.e2e-spec.ts` with the test-only simulator (run the e2e suite serially: `--runInBand`, the AI, calendar and social queues are shared). Browser: `tests/e2e/social.e2e.ts` (the platform sign-in is simulated by intercepting the redirect). Real platform verification is manual: see [SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md#verifying-against-real-platforms).
