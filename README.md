# TOUMA AI

**Your Business. Your AI Marketing Team.**

TOUMA AI is the AI-powered marketing automation SaaS by **TOUMA**. It helps e-commerce stores, restaurants, retail shops, brands, agencies, freelancers and service providers run their marketing: product analysis, AI content and visuals, a 30-day content calendar, approval workflows, scheduled publishing through **official** social APIs, a unified inbox, analytics and subscriptions.

> **Status: Phase 1 of 10 complete.** The foundations work: monorepo, infrastructure, full database schema and migrations, secure authentication, and the first dashboard. See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/phase-reports/PHASE-1.md](docs/phase-reports/PHASE-1.md).

## Monorepo

| Path | What it is |
|---|---|
| `apps/web` | Next.js 15 (App Router) + React 19 + Tailwind 4 + shadcn-style UI. i18n (EN/FR, RTL-ready). |
| `apps/api` | NestJS 11 REST API (`/api/v1/*`), Swagger at `/api/docs` (non-production). |
| `apps/worker` | BullMQ worker (Redis) for background and scheduled jobs. |
| `packages/database` | Prisma schema, migrations, seed (plans only — no fake data). |
| `packages/shared` | RBAC matrix, locales, validation schemas shared by web and api. |
| `packages/config` | Shared tsconfig and validated environment loader. |
| `packages/ai-engine` | AI orchestration contract (implemented in Phase 3). |
| `packages/social-connectors` | Social connector contract (implemented in Phase 6). |
| `infrastructure/docker` | Docker Compose (Postgres, Redis, MinIO, full stack) and Dockerfiles. |
| `tests/e2e` | Playwright full-stack tests. |
| `docs/` | Architecture, security, testing, deployment, roadmap, OpenAPI export. |

## Quick start

Requirements: Node 22+, pnpm 10, and either Docker or a local PostgreSQL 16 + Redis 7.

```bash
pnpm install
cp .env.example .env            # then replace the secrets (see comments in the file)
pnpm infra:up                   # Postgres + Redis + MinIO via Docker (skip if running locally)
pnpm db:deploy && pnpm db:seed  # apply migrations, seed the 3 plans
pnpm build
pnpm dev                        # web :3000, api :4000, worker
```

Open http://localhost:3000. API docs: http://localhost:4000/api/docs.

Full stack in Docker: `docker compose -f infrastructure/docker/docker-compose.yml --profile app up --build`.

## Tests

```bash
pnpm test           # unit tests (all packages)
pnpm test:e2e       # API integration tests against a real Postgres test DB
pnpm test:web-e2e   # Playwright full-stack tests (build with API_URL=http://localhost:4100 first)
```

See [docs/TESTING.md](docs/TESTING.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Integrations & credentials](docs/INTEGRATIONS.md)
- [Brand identity](docs/BRAND.md)
- [Roadmap](docs/ROADMAP.md)
- [OpenAPI spec](docs/api/openapi.json) — regenerate with `pnpm --filter @touma/api openapi`
