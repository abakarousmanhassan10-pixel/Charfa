# Testing

| Suite | Command | Needs |
|---|---|---|
| Unit (all packages) | `pnpm test` | nothing |
| API integration (real DB) | `pnpm test:e2e` | PostgreSQL + Redis; uses `touma_test` |
| Full-stack browser | `pnpm test:web-e2e` | built api + web; PostgreSQL + Redis |
| Malware scanning (part of `test:e2e`) | `infrastructure/clamav/start-test-clamd.sh` first | `clamav-daemon` installed; fails (not skips) if clamd is down |
| Real object storage | `pnpm --filter @touma/api storage:check` and `pnpm --filter @touma/api test:real-storage` | a real AWS S3 / R2 / MinIO bucket and `S3_*` variables; skipped and reported as NOT RUN otherwise |
| Lint | `pnpm lint` | nothing |

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
