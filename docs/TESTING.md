# Testing

| Suite | Command | Needs |
|---|---|---|
| Unit (all packages) | `pnpm test` | nothing |
| API integration (real DB) | `pnpm test:e2e` | PostgreSQL + Redis; uses `aima_test` |
| Full-stack browser | `pnpm test:web-e2e` | built api + web; PostgreSQL + Redis |

## Test database

```bash
createdb -O aima aima_test   # docker compose creates it automatically
```
`apps/api/test/global-setup.js` runs `prisma migrate deploy` against `TEST_DATABASE_URL` (default `postgresql://aima:aima_dev_password@localhost:5432/aima_test`), the same way production applies migrations.

## Playwright

```bash
pnpm --filter @aima/api build
API_URL=http://localhost:4100 pnpm --filter @aima/web build
pnpm test:web-e2e
```
Playwright starts the API on :4100 and the web app on :3100 against the test database.

## Rules
- No mocked services in integration/E2E suites. Mocks are only used in unit tests.
- A feature is not done until its unit, authorization and tenant-isolation tests pass.
- CI (`.github/workflows/ci.yml`) also checks that migrations match the Prisma schema (`prisma migrate diff --exit-code`).
