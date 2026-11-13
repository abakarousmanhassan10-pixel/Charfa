# Release readiness for a private staging (Phase N13)

Audit and preparation only: nothing was deployed, no service was created, `render.yaml`, `ci.yml` and the dependencies were **not** modified (each needs approval, see section 9). Evidence comes from this repository and from local runs on disposable PostgreSQL 16 and Redis 7 containers. Prices could not be re-read in this session (`render.com` is outside the session's network allowlist): they are the values read from provider pages in earlier phases (`docs/STAGING-RUNBOOK.md`) and must be re-checked before any purchase.

## 1. Status of N9 to N12 (evidence)
| Phase | Status | Evidence |
| --- | --- | --- |
| N9 Workflow → Calendar | VERIFIED | `calendar-run-adapter.ts`; `calendar-workflow.e2e-spec` 6/6 (release gate run, N13); browser scenario in `n12-staging.e2e.ts` |
| N10 Chat token, tenant quotas | VERIFIED | `tenant-security.e2e-spec` 7/7, `log-safety` 3/3 (gate run, N13); gate rule "chat token never in a URL" passes |
| N11 Backup and restore | PARTIAL | `restore-drill.sh` passes (57 tables identical, 22/22 migrations; part of the gate). Managed backups, PITR and R2 recovery are **not configured or verified** |
| N12 Browser validation | VERIFIED (Chromium only) | `n12-staging.e2e.ts` 6/6 three times, full Playwright run 78/79 then fixed (N12 report). Not re-run in N13 |
Fresh N13 run (`release-gate.sh --with-tests`): API unit tests pass; e2e `auth`, `hardening`, `tenant-security`, `log-safety`, `runs`, `workflows`, `calendar-workflow`, `sales-assist`, `ops`, `integration` all pass.

## 2. Release gates (`infrastructure/scripts/release-gate.sh`)
Run: `ADMIN_DATABASE_URL=<local postgres> BASE_REF=<ref> infrastructure/scripts/release-gate.sh [--with-build] [--with-tests]`; report in `.release-gate/report.md`; exit 1 on any blocker failure; SKIP means "not verified".
| Gate | Level | Result now |
| --- | --- | --- |
| Type checks (api, web), lint with 0 warnings | BLOCKER | pass |
| No secrets in tracked files (key shapes, tracked `.env`) | BLOCKER | pass |
| Chat token never in a URL (web client, API) | BLOCKER | pass |
| No public endpoint outside `public-endpoints.allowlist` (8 reviewed files) | BLOCKER | pass |
| Dependency audit, production, high/critical | BLOCKER | **FAIL: 11 high** (section 3) |
| Migrations apply on an empty database; no drift (separate shadow database) | BLOCKER | pass |
| New migrations without destructive statements (or `-- release-gate: allow`) | BLOCKER | pass (needs `BASE_REF`) |
| Backup and restore drill | BLOCKER | pass |
| API liveness/readiness, worker health | BLOCKER | SKIP (needs a running stack: `API_URL`, `WORKER_HEALTH_URL`) |
| Security and integration suites, build | BLOCKER | pass with `--with-tests`; `--with-build` not run |
| No `console.log` in API source | WARN | pass |
Warnings to add later: moderate advisories, Docker image scan, bundle size, accessibility.

## 3. Release blockers, ranked
1. **High: 11 high-severity advisories in production dependencies** (`pnpm audit --prod`): `sharp` (libvips, libheif, librsvg; used on user uploads; fix ≥ 0.35.5), `nodemailer` (4 advisories; fix ≥ 10.0.6), `zod` (memory exhaustion on oversized constraints; fix ≥ 4.6.6), `postcss` via `next` (build time) and `deepmerge-ts` via Prisma CLI (tooling). 17 moderate. **Needs approval** (dependency upgrades) then the full regression.
2. **High: no managed backup configured, restore never done on the real provider** (N11). R2 versioning unconfirmed.
3. **High: private-staging access control not defined** (section 6): the API and the web app are reachable from the internet once deployed.
4. **Medium: Blueprint lacks the N2–N6 feature flags** (they stay off), no `connection_limit`, no ops sampler (section 4).
5. **Medium: Render, R2, Key Value, SMTP, Vercel never exercised for real**; BullMQ on Render Key Value not verified.
6. **Low: only Chromium tested; CSP `frame-ancestors 'none'` prevents embedding the chat in an iframe (by design, decide before merchants embed it).**

## 4. Infrastructure review
| Area | Finding |
| --- | --- |
| `render.yaml` | API, maintenance worker, AI worker, ClamAV (private), Key Value; `autoDeployTrigger: off`; secrets `sync: false`; health check on `/api/v1/health` (liveness only, on purpose). **Missing:** `ORCHESTRATOR_ENABLED`, `WORKFLOWS_ENABLED` (API **and** AI worker), `MARKET_INTELLIGENCE_ENABLED`, `SALES_ASSIST_ENABLED` (API and worker), `OPS_SAMPLER_INTERVAL_SECONDS` (e.g. 60), optional limits (`AI_MAX_INFLIGHT_PER_BUSINESS`, `CREATIVE_MAX_INFLIGHT_PER_BUSINESS`, `CHAT_TOKEN_IDLE_HOURS`). The AI worker is also the only place that runs the runs worker and the workflow scheduler |
| Dockerfiles | All three run as the `node` user with HEALTHCHECK; the production configuration is refused when insecure (CI step); migrations only through `migrate.Dockerfile` |
| Vercel | No `vercel.json`; `next.config.ts` proxies `/api/v1/*` to `API_URL` **at build time** (cookies stay first-party; set `API_URL` in the Vercel build environment). CSP is strict; Vercel proxies for at most 120 s (video limit set to 50 MB) |
| PostgreSQL | Direct connection required (advisory locks); `sslmode=require`; **pool not bounded**: measured 10 connections under load from one API process, Prisma's default pool grows with CPUs. Propose `connection_limit=10` per service (3 services ≈ 30 of 100 on the smallest plan) |
| Redis/BullMQ | Dedicated blocking connections with `maxRetriesPerRequest: null`; Key Value `noeviction` + persistence in the Blueprint; unauthenticated internal URL; **not verified on Render** |
| Object storage | Private bucket, API-signed URLs, durable deletion queue; checksum risk with R2 documented; `storage:check` to run before any deploy |
| SMTP | Startup validation of TLS and credentials, timeouts; Render blocks port 25 (587 on paid services) |
| Health/readiness | Liveness and readiness separated; worker health on `AI_WORKER_HEALTH_PORT`; ops overview shows heartbeats |
| Startup/shutdown | `enableShutdownHooks` (API), SIGTERM/SIGINT handlers closing workers (AI worker); the maintenance worker was not re-audited |
| Environment management | Validated at start with strict production rules; no secret in the repository (gate) |
Not verifiable here: compatibility of every Blueprint field with Render's current spec (site unreachable from this session), Key Value behaviour, R2 and Vercel limits.

## 5. CI/CD
`.github/workflows/ci.yml` already runs: lint, migration apply + drift check, build, typecheck, unit tests, API e2e, Playwright (including `n12-staging`), a MinIO storage round trip, Docker image builds and the insecure-production refusal. **Gaps:** no dependency audit, no secret scan, no public-endpoint review, no restore drill, no release report, no load check. Proposal (not applied): add one job after `test`:
```yaml
  release-gate:
    needs: test
    runs-on: ubuntu-latest
    services: { postgres: { image: "postgres:16-alpine", env: { POSTGRES_USER: touma, POSTGRES_PASSWORD: touma_dev_password, POSTGRES_DB: postgres }, ports: ["5432:5432"] } }
    steps:
      - { uses: actions/checkout@v4, with: { fetch-depth: 0 } }
      - uses: pnpm/action-setup@v4
      - { uses: actions/setup-node@v4, with: { node-version: 22, cache: pnpm } }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @touma/database db:generate
      - run: infrastructure/scripts/release-gate.sh
        env: { ADMIN_DATABASE_URL: "postgresql://touma:touma_dev_password@localhost:5432/postgres", BASE_REF: "origin/main" }
      - { if: always(), uses: actions/upload-artifact@v4, with: { name: release-gate, path: .release-gate/report.md } }
```
No paid CI feature is required (public runners; private repositories consume the free minutes).

## 6. Security and performance assessment
**Security:** tenant isolation, RBAC, chat token handling, log redaction, quotas, idempotent calendar step, approvals for outward steps are covered by tests (N7–N12). Open: dependency advisories, private-staging access, backup recovery. **Private staging access (proposal):** keep sign-up closed or limited to named e-mails, set the Vercel project to deployment protection, restrict the API with `CORS_ORIGINS` and a Render IP allowlist is not available for web services: rely on authentication + a staging-only registration allowlist (**not implemented**; needs approval) or an HTTP basic auth layer on the Vercel side.
**Performance (bounded local check, `infrastructure/scripts/load-check.mjs`, single API process with inline workers, local PostgreSQL/Redis, results of N13):**
| Measure | Result |
| --- | --- |
| `/health`, 300 requests, concurrency 20 | p50 10 ms, p95 22 ms, p99 96 ms, 0 error |
| Authenticated `GET /products`, 300 requests, concurrency 15 | p50 31 ms, p95 48 ms, p99 78 ms, 0 error |
| PostgreSQL connections | 2 idle, 10 under load |
| Concurrent workflow submissions | 30 submitted by one tenant: 5 accepted, 25 refused with 429; the other tenant's 5 accepted |
| BullMQ throughput (internal runs, 8 batches of 5) | 40 runs in 1.9 s (about 20 runs/s) |
| `kill -9` of the process holding the workers, 5 runs in flight | all 5 reached the approval state after the restart in about 60 s (bounded by the queue's stall detection), no step executed twice, no duplicate step, all completed after approval |
Limits: one machine, tiny data, no network latency, no real AI or storage; the 60 s recovery is the measured figure for a worker kill. Not run: unbounded stress, large uploads, real provider latency.

## 7. Cost model (USD, monthly)
| Item | Cost | Status |
| --- | --- | --- |
| PostgreSQL `0.1c-256mb` | 6 | price read earlier from Render's page; re-verify |
| Key Value `256mb` | 10 | same |
| API `0.5c-512mb` | 7 | same |
| Maintenance worker + AI worker `0.5c-512mb` | 14 | same |
| ClamAV `1c-2g` + 2 GB disk | 25.5 | same (can be started only for upload tests) |
| Render workspace | 0 (Hobby) or 25 (Professional) | read earlier; PITR 3 days on Hobby, 7 on Pro |
| Vercel | 0 (Hobby) or 20 per seat (Pro) | Hobby terms for this use **not verified** |
| Cloudflare R2 | 0 within the free tier, then 0.015 per GB-month, egress free | estimate from search results, not the page |
| SMTP (Brevo/Resend free tiers) | 0 to about 9–20 | estimate |
| Domain | registrar price (about 1–2/month) | estimate |
| **Fixed, full stack** | **62.5 + workspace + Vercel** | computed |
| **Smallest useful stack** (Postgres + Key Value + API) | **about 23** | computed |
| AI (OpenAI) | 0 while disabled. Worst case per tenant per month with the default quotas (3 M tokens, 100 images, 120 video seconds) and the **test** price table: about 0.9 text + 4 images + 12 video ≈ **17** | **estimate**: the prices in `AI_MODEL_PRICING` are test values, not verified |
**Proposed ceiling: 100 USD/month for staging** (62.5 compute with ClamAV and workers only while testing, workspace and Vercel at 0–25, AI capped at 20, margin for storage and mail). **Cost alerts (to set up by hand, not verified):** provider-side monthly spend limit on the AI account (20), Render/Cloudflare billing notifications, a calendar review of the Render invoice weekly; in-app: per-tenant monthly AI and creative quotas, the AI usage report and the Operations page. Render has no confirmed hard spending cap: stop services when idle (billing is prorated per second).

## 8. Deployment runbook (supplement)
The ordered, step-by-step procedure already exists in `docs/STAGING-RUNBOOK.md` and `docs/STAGING-CHECKLIST.md` (accounts, R2 token, SMTP, migrate image, order Postgres → Key Value → API → Vercel → ClamAV → workers). N13 additions:
1. **Before anything is paid:** `release-gate.sh --with-tests` must pass (after the dependency upgrade) and `storage:check` must pass against R2.
2. **Environment checklist (names only):** `DATABASE_URL` (internal, `sslmode=require`, `connection_limit=10`), `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `WEB_URL`, `CORS_ORIGINS`, `S3_*`, `SMTP_*`, `EMAIL_FROM`, `CLAMAV_HOST`; flags on **both** API and AI worker: `ORCHESTRATOR_ENABLED`, `WORKFLOWS_ENABLED`, `SALES_ASSIST_ENABLED`; API only: `MARKET_INTELLIGENCE_ENABLED`, `OPS_SAMPLER_INTERVAL_SECONDS=60`; Vercel build: `API_URL`. `OPENAI_API_KEY` stays empty until the AI pilot.
3. **Migration:** `migrate` image from a trusted machine, backup first (`pg_dump -Fc`), then `migrate deploy`; failure path: `docs/DISASTER-RECOVERY.md` section 5.
4. **Smoke tests after each deploy:** `/api/v1/health` and `/health/ready` 200; register and log in; create a business and a product; upload a 10 MB image (scan, signed URL); start the demo workflow, approve, see it completed; Operations page shows five measured queues and fresh heartbeats; chat message and customer handoff on a test business; calendar entry visible; one e-mail received.
5. **Rollback:** redeploy the previous image (autodeploy is off); migrations are forward-only: forward-fix or restore to a new instance (DISASTER-RECOVERY).
6. **Incident checklist:** open Operations (queues, heartbeats, alerts); check `/health/ready`; classify with the DISASTER-RECOVERY runbook table; stop external actions (disable `WORKFLOWS_ENABLED` and social publishing) before investigating; never retry an outward step with an unknown outcome; record the timeline.

## 9. Changes that need your approval
1. Upgrade `sharp`, `nodemailer`, `zod` (and `next`'s PostCSS, Prisma tooling if possible), then run the full regression (release gate, all e2e, Playwright).
2. Update `render.yaml`: feature flags, `connection_limit`, ops sampler.
3. Add the `release-gate` job to `.github/workflows/ci.yml`.
4. Decide the private-staging access control (registration allowlist or an access layer in front of the web app).
5. Create the external accounts and services in the order of `STAGING-RUNBOOK.md` (paid from step 1).
