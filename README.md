# TOUMA AI

**Your Business. Your AI Marketing Team.**

TOUMA AI is the AI-powered marketing automation SaaS by **TOUMA**. It helps e-commerce stores, restaurants, retail shops, brands, agencies, freelancers and service providers run their marketing: product analysis, AI content and visuals, a 30-day content calendar, approval workflows, scheduled publishing through **official** social APIs, a unified inbox, analytics and subscriptions.

> **Status: Phase 6 (social accounts and automated publishing for Instagram, Facebook, TikTok, YouTube and LinkedIn) implemented and tested against a simulator; real platform publishing is unverified.** See [docs/SOCIAL-INTEGRATIONS.md](docs/SOCIAL-INTEGRATIONS.md), [docs/SOCIAL-PUBLISHING.md](docs/SOCIAL-PUBLISHING.md), [docs/SOCIAL-SECURITY.md](docs/SOCIAL-SECURITY.md) and [docs/phase-reports/PHASE-6-SOCIAL.md](docs/phase-reports/PHASE-6-SOCIAL.md).
>
> Phase 5 (smart content calendar, approvals, AI 30-day planner, scheduler) complete and tested; nothing is published yet (Phase 6).** See [docs/CALENDAR.md](docs/CALENDAR.md) and [docs/phase-reports/PHASE-5-CALENDAR.md](docs/phase-reports/PHASE-5-CALENDAR.md).
>
> Phase 4 (Creative Studio: AI images, videos, storyboards, brand kit) complete and tested; real provider generation is unverified.** See [docs/CREATIVE.md](docs/CREATIVE.md) and [docs/phase-reports/PHASE-4-CREATIVE-STUDIO.md](docs/phase-reports/PHASE-4-CREATIVE-STUDIO.md).
>
> Phase 3 (TOUMA AI marketing engine) complete and tested. Business and product analysis, marketing strategy and multilingual content generation with an orchestrator, strict output validation and token tracking (`docs/AI.md`).
>
> Phase 2 (Business & product management) complete and tested: Phase 1 delivered the foundation (auth, RBAC, tenant isolation, dashboard). Phase 2 adds businesses with logo and contacts, products, services, categories, a secure S3 media library and the business knowledge base for TOUMA AI. Phase 3 improvements (background AI generation, atomic usage limits, cost reports, accuracy checks, human approval): see [docs/phase-reports/PHASE-3-IMPROVEMENTS.md](docs/phase-reports/PHASE-3-IMPROVEMENTS.md). Phase 2 hardening (media processing, malware scanning, email verification, password reset, invitations, distributed rate limiting): see [docs/phase-reports/PHASE-2-HARDENING.md](docs/phase-reports/PHASE-2-HARDENING.md). See [docs/phase-reports](docs/phase-reports) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Pages
Landing · Registration · Login · Onboarding · Dashboard · `/dashboard/businesses` (+ `/new`, `/[id]`) · `/dashboard/products` (+ `/new`, `/[id]`) · `/dashboard/services` (+ `/new`, `/[id]`) · `/dashboard/categories` · `/dashboard/media` · `/dashboard/knowledge` · `/dashboard/ai` (+ `/business-analysis`, `/product-analysis`, `/marketing-strategy`, `/content-generator`, `/history`) · User profile

TOUMA AI needs `OPENAI_API_KEY` (see `docs/AI.md`); without it the AI pages show "not configured". Media uploads need S3-compatible storage: set the `S3_*` variables (Docker Compose wires local MinIO). Without them the media library reports "storage not configured".

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
| `packages/social-connectors` | Platform adapters (Instagram, Facebook, TikTok, YouTube, LinkedIn) and a test-only simulator (Phase 6). |
| `packages/creative` | Image/video provider contracts, OpenAI adapters, prompt building and image composition (Phase 4). |
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
pnpm lint           # ESLint (flat config, typescript-eslint, react-hooks, Next.js rules)
pnpm --filter @touma/api storage:check   # real S3/R2/MinIO round trip with your S3_* variables
```

See [docs/TESTING.md](docs/TESTING.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Database](docs/DATABASE.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Integrations & credentials](docs/INTEGRATIONS.md)
- [TOUMA AI engine](docs/AI.md)
- [Brand identity](docs/BRAND.md)
- [Roadmap](docs/ROADMAP.md)
- [OpenAPI spec](docs/api/openapi.json) — regenerate with `pnpm --filter @touma/api openapi`
