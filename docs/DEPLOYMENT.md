# Deployment

| Component | Recommended target | Notes |
|---|---|---|
| Web | Vercel | Root `apps/web`; build `pnpm turbo run build --filter=@touma/web...`; env `API_URL` = public API origin |
| API | Render / Fly.io / AWS ECS (container) | `infrastructure/docker/api.Dockerfile` target `runtime`; health check `/api/v1/health/ready` |
| Worker | Same platform as API (background worker) | `infrastructure/docker/worker.Dockerfile`; scale horizontally, since BullMQ handles locking; liveness `GET :4001/health` |
| AI worker | Same platform as API (background worker), same image | `api.Dockerfile` target `runtime` with command `node dist/ai-worker.js`; consumes the `touma.ai` queue; scale horizontally; health `GET :4002/health`; keep `AI_WORKER_INLINE=false` on the API |
| Migrations | One-off job before each API release | `api.Dockerfile` target `migrate` (local/compose) or, for hosted staging/production, `infrastructure/docker/migrate.Dockerfile` (see "Staging on Render and Vercel"). The `runtime` images do not contain the Prisma CLI |
| PostgreSQL | Managed (Neon, RDS, Render, Supabase) | PITR on, TLS required (`?sslmode=require`) |
| Redis | Managed (Upstash, ElastiCache, Render) | `maxmemory-policy noeviction` (required by BullMQ) |
| Media | AWS S3 / Cloudflare R2 / MinIO | Private bucket, served only through API-signed URLs; verify with `pnpm --filter @touma/api storage:check` |
| Malware scanning | clamd (ClamAV) next to the API | `MALWARE_SCANNER=clamav`; uploads fail closed if clamd is down |
| Email | Any SMTP provider (SES, Postmark, Mailgun, …) | `EMAIL_TRANSPORT=smtp`; TLS required in production |

## Release steps
1. CI green (unit, integration, Playwright, migration drift check).
2. Run the migration job (`prisma migrate deploy`). Migrations must be backward compatible with the running API version (expand → migrate → contract).
3. Deploy the API, then the workers (maintenance worker and AI worker), then the web app. Jobs accepted while no AI worker runs wait in the queue and are processed when one starts.
4. Seed plans once: `pnpm db:seed` (idempotent; it doesn't overwrite admin-edited prices).

## Required production env
`NODE_ENV=production`, `APP_ENV=production` (turns off Swagger UI), `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (distinct, 32+ chars), `TOKEN_ENCRYPTION_KEY` (32 bytes base64), `WEB_URL`, `CORS_ORIGINS`. The API refuses to start if any of these is missing or invalid.

### Production configuration validation
With `APP_ENV=production` or `staging` the API and worker also refuse to start (listing every problem) unless:
- `WEB_URL` and every `CORS_ORIGINS` entry use https, and `COOKIE_SECURE` is not `false`;
- the secrets differ from each other and from the `.env.example` values, and `DATABASE_URL` does not use the development password;
- `STORAGE_DRIVER=s3` with bucket, region and credentials, and `S3_AUTO_CREATE_BUCKET` is off;
- `EMAIL_TRANSPORT=smtp` with `SMTP_HOST` and a real `EMAIL_FROM`;
- `MALWARE_SCANNER=clamav` (or `ALLOW_UNSCANNED_UPLOADS=true`, an explicit, documented risk acceptance);
- `RATE_LIMIT_STORE=redis` and no test-only provider (`AI_PROVIDER=fake`, `STORAGE_DRIVER=memory`).

### Object storage per provider
| Provider | Settings |
|---|---|
| AWS S3 | `S3_PROVIDER=aws`, `S3_REGION=<region>`, no `S3_ENDPOINT`; IAM user limited to `s3:GetObject/PutObject/DeleteObject/ListBucket` on the bucket; Block Public Access on |
| Cloudflare R2 | `S3_PROVIDER=r2`, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, region `auto`; API token with Object Read & Write on that bucket only; no public bucket domain |
| MinIO | `S3_PROVIDER=minio`, `S3_ENDPOINT=http(s)://host:9000` (path-style); dedicated user with a bucket-scoped policy |

Before go-live run `pnpm --filter @touma/api storage:check` with the production variables: it uploads, reads back (bytes compared), downloads via a presigned URL, checks that an unsigned request is refused, deletes and confirms deletion. It exits non-zero if any step fails. `GET /api/v1/health/ready` repeats this round trip (cached 5 min) and reports `dependencies.storage.state` = `verified` or `failing`.

### Health checks
- `GET /api/v1/health`: liveness (container `HEALTHCHECK`).
- `GET /api/v1/health/ready`: 503 unless PostgreSQL and Redis are up; `dependencies` reports storage, email (SMTP `verify`), malware scanner (`PING`) and the heartbeats of the maintenance worker (`touma:worker:heartbeat`) and the AI worker (`touma:ai-worker:heartbeat`), each stale after 90 s.
- Worker: `GET :WORKER_HEALTH_PORT/health` (Redis connectivity).

### Docker images
```bash
docker build -f infrastructure/docker/api.Dockerfile -t touma-api .
docker build -f infrastructure/docker/worker.Dockerfile -t touma-worker .
docker build -f infrastructure/docker/web.Dockerfile -t touma-web .
```
Behind a TLS-intercepting proxy, pass `--network host --build-arg HTTPS_PROXY=... --secret id=build_ca,src=ca.pem` (the CA is mounted only for the install step and never stored in a layer). `--build-arg BASE_IMAGE=` swaps the default `node:22-bookworm-slim`.

Cookies are `Secure` automatically in production. Put the API behind HTTPS (`trust proxy` is set to 1 hop).

### Creative Studio
No extra service: the AI worker also runs the creative queue. Set `IMAGE_PROVIDER`/`VIDEO_PROVIDER` (see [CREATIVE.md](CREATIVE.md)); `VIDEO_PROVIDER` defaults to `none`. The API image installs fonts for overlay text. `fake` providers must never be set in production (production validation reports them). `/health/ready` includes the creative worker heartbeat.

### Calendar scheduler
No extra service: `node dist/ai-worker.js` also runs the calendar scheduler (queue `touma.calendar`). At least one worker must be running for reminders, blocked-entry notices and (from Phase 6) publication hand-off. Tune with `CALENDAR_*` variables (see [CALENDAR.md](CALENDAR.md)). `/health/ready` reports `calendarWorker`.

### Social publishing
No extra service: `node dist/ai-worker.js` also runs the social worker (queue `touma.social`). Set `PUBLIC_API_URL` (https) and the credentials of each platform you enable ([SOCIAL-INTEGRATIONS.md](SOCIAL-INTEGRATIONS.md)); keep `SOCIAL_PROVIDER_MODE=live`. The API must be reachable from the internet (OAuth redirects, webhooks and the media URLs platforms download). At least one worker must run for publishing, token refresh and analytics. `/health/ready` reports `socialWorker`.

## Staging on Render and Vercel (prepared, not deployed)

Status: `render.yaml` and `infrastructure/docker/migrate.Dockerfile` are prepared and **have not been applied or built against a real account**. Applying the Blueprint creates paid services. Facts about Render or Vercel below that are not visible in this repository are marked **[verify]**: check them in the provider's current documentation before relying on them.

### What is prepared
| File | Purpose |
|---|---|
| `render.yaml` | Blueprint: `touma-api` (web), `touma-worker` (maintenance), `touma-ai-worker` (AI, creative, calendar, social queues), `touma-clamav` (private service), `touma-redis` (Key Value). No secret or real value: entries marked `sync: false` are entered in the dashboard |
| `infrastructure/docker/migrate.Dockerfile` | Image with the Prisma CLI and tsx, for `prisma migrate deploy` and the plan seed |
| `.dockerignore`, `.gitignore` | Local Redis dumps (`*.rdb`, `*.aof`), `.env.*` (except `.env.example`) and key files are kept out of git and out of the Docker build context |

### Services and settings
| Service | Image / command | Settings |
|---|---|---|
| API (web) | `api.Dockerfile`, default command | `API_PORT=10000` (the app also accepts the host's `PORT`; Render's default port 10000 is **[verify]**). Health check path `/api/v1/health` (liveness). Render uses its own health check, not the Dockerfile `HEALTHCHECK` |
| Maintenance worker | `worker.Dockerfile` | Background worker; no port |
| AI worker | `api.Dockerfile`, command `node dist/ai-worker.js` | Background worker; keep `AI_WORKER_INLINE=false` |
| ClamAV | `docker.io/clamav/clamav:1.4`, private service on port 3310 | Persistent disk on `/var/lib/clamav`; plan sized for about 2 GB of RAM **[verify]**; first start downloads signatures (several minutes). `MALWARE_SCANNER=clamav` is mandatory: never set `ALLOW_UNSCANNED_UPLOADS` |
| Redis | Render Key Value | `maxmemoryPolicy: noeviction`, private network only. **[verify before applying]**: BullMQ compatibility, persistence on the chosen plan, `noeviction` support and current price; do not use a plan without persistence guarantees |

Every backend service runs the same startup validation (`loadEnv`), so the maintenance and AI workers need the same secrets, storage and e-mail settings as the API. All services must stay in one region to use the private network.

### Environment variables to enter in the dashboard (names only)
- **Secrets (never in git):** `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (distinct, 32+ characters), `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_USER`, `SMTP_PASSWORD`, `OPENAI_API_KEY`. Generate each value with a random generator (for example `openssl rand -base64 48`; `openssl rand -base64 32` for `TOKEN_ENCRYPTION_KEY`) and use different values for staging and production.
- **Configuration:** `WEB_URL`, `CORS_ORIGINS` (https only, the exact Vercel domain), `S3_PROVIDER`, `S3_ENDPOINT` (R2 only), `S3_REGION`, `S3_BUCKET`, `SMTP_HOST`, `EMAIL_FROM`, `SALES_AGENT_MODEL`, `AI_MODEL_PRICING`.
- **Set by the Blueprint:** `NODE_ENV`, `APP_ENV=staging`, `STORAGE_DRIVER`, `S3_AUTO_CREATE_BUCKET=false`, `EMAIL_TRANSPORT=smtp`, `SMTP_PORT`, `SMTP_SECURE`, `MALWARE_SCANNER=clamav`, `CLAMAV_HOST` and `CLAMAV_PORT`, `RATE_LIMIT_STORE=redis`, `REDIS_URL`, `AI_PROVIDER`, `SOCIAL_PROVIDER_MODE`, `VIDEO_PROVIDER=none`, `AI_WORKER_INLINE=false`.
- Social platform variables (`META_*`, `TIKTOK_*`, `GOOGLE_*`, `LINKEDIN_*`) and `PUBLIC_API_URL` stay unset until the platforms approve the application.

### Database migrations and seed (not run by any service)
The `runtime` images are built with `pnpm deploy --prod` and contain neither the Prisma CLI nor tsx, so they cannot run migrations. Use the dedicated image from a trusted machine or CI, with a **direct** PostgreSQL connection: the schema has no `directUrl`, and the calendar scheduler uses PostgreSQL advisory locks, which do not work through a transaction-mode pooler.
```bash
docker build -f infrastructure/docker/migrate.Dockerfile -t touma-migrate .
docker run --rm -e DATABASE_URL="$DATABASE_URL" touma-migrate                                    # prisma migrate deploy
docker run --rm -e DATABASE_URL="$DATABASE_URL" touma-migrate pnpm exec tsx prisma/seed.ts       # plans, once, idempotent
```
Migrations are forward-only (there are no down migrations). Rollback means expand-then-contract migrations, a point-in-time restore of the database, and redeploying the previous image.

### Vercel (web)
- Project root directory `apps/web`, with "include source files outside of the root directory" enabled, Node 22.
- Install command `pnpm install --frozen-lockfile`; build command `pnpm turbo run build --filter=@touma/web...`; framework Next.js.
- Environment variable `API_URL` = public https URL of the API. It is read at **build** time (the `/api/v1/*` rewrites are baked into the build), so redeploy the web app whenever the API URL changes. No other variable is needed; no secret belongs in Vercel.
- The browser only talks to the web origin (CSP `connect-src 'self'`); the refresh cookie is `SameSite=Strict` and works because the API is proxied under the same origin.
- **[verify in staging]** the following are not tested from this repository: `Set-Cookie` passing through the rewrite; uploads of large videos (up to 200 MB) through a Vercel rewrite (size and duration limits; `experimental.proxyTimeout` only applies to self-hosting); and the Vercel Hobby plan is for non-commercial use only.

### Port, proxy and database connection (checked in this repository)
- **Port.** The API listens on `API_PORT` and falls back to the host's `PORT` when `API_PORT` is unset (an explicit `API_PORT` wins), then 4000. It binds to `0.0.0.0`. The Dockerfile `HEALTHCHECK` follows the same variables. Covered by `packages/config/src/env.spec.ts`.
- **Proxy.** `TRUST_PROXY_HOPS` (default 1, unchanged behaviour) sets how many reverse-proxy hops are believed for the client IP (Express `trust proxy`): only that many entries counted from the API are trusted, anything a client puts further left in `X-Forwarded-For` is ignored. The client IP feeds login throttling, lockout, the public-chat flood limits and audit records. Cookie security does not depend on it (`Secure` comes from `NODE_ENV`/`COOKIE_SECURE`). With Vercel in front of Render the real hop count is **not verified**: in staging, send requests from two networks, read the IP recorded in the audit log, and raise `TRUST_PROXY_HOPS` (for example to 2) only if it shows the proxy's address. Never set a value higher than the real number of proxies.
- **Prisma `directUrl`.** Deliberately not configured: with `directUrl = env(...)` every Prisma command would require that variable and the migration image would stop working without it. Migrations use `DATABASE_URL`, which must be a **direct** (or session-mode) PostgreSQL connection; the calendar scheduler's advisory locks also require it at run time. Do not point `DATABASE_URL` at a transaction-mode pooler.

### Known risks to test before real users
1. **E-mail ports.** Some hosting plans block outbound SMTP ports **[verify]**. Test a real verification e-mail.
2. **Docker Hub pull limits** for the ClamAV image **[verify]**.
3. Nothing has been verified against real OpenAI, S3/R2, SMTP, Render Key Value or Vercel: only MinIO, Mailpit and simulated providers have been used.

### Order of operations (when you decide to apply)
1. Create the PostgreSQL database, the private R2/S3 bucket (with a token limited to that bucket) and the SMTP account.
2. Verify the Redis items above, then create the Blueprint in Render and fill the `sync: false` values.
3. Run the migration and the seed with the commands above.
4. Wait for ClamAV signatures, then check `GET /api/v1/health/ready` (database, Redis, storage, scanner and the three worker heartbeats) and run `pnpm --filter @touma/api storage:check` with the staging variables.
5. Deploy the web app on Vercel with `API_URL`.
6. Run the staging checks (sign-up with a real e-mail, image upload, EICAR rejection, IP throttling) before any AI or customer-data test.
