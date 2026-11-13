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

Status: `render.yaml` and `infrastructure/docker/migrate.Dockerfile` are prepared and **have not been applied to a real account**. Applying the Blueprint creates paid services. `render.yaml` was checked against Render's published Blueprint specification, Key Value, web-service, private-network, disk and health-check documentation, and against Vercel's monorepo, rewrite and header documentation (read on the date of this change). Anything not confirmed there is marked **[not verified]**; a Blueprint validation or a real staging run is still needed.

### What is prepared
| File | Purpose |
|---|---|
| `render.yaml` | Blueprint: `touma-api` (web), `touma-worker` (maintenance), `touma-ai-worker` (AI, creative, calendar, social queues), `touma-clamav` (private service), `touma-redis` (Key Value). No secret or real value: entries marked `sync: false` are entered in the dashboard |
| `infrastructure/docker/migrate.Dockerfile` | Image with the Prisma CLI and tsx, for `prisma migrate deploy` and the plan seed |
| `.dockerignore`, `.gitignore` | Local Redis dumps (`*.rdb`, `*.aof`), `.env.*` (except `.env.example`) and key files are kept out of git and out of the Docker build context |

### Services and settings
| Service | Image / command | Settings |
|---|---|---|
| API (web) | `api.Dockerfile`, default command (its last stage is `runtime`; Render has no build-target field) | `API_PORT=10000`. Render's default `PORT` is 10000, can be overridden, and the service must bind to `0.0.0.0` (all confirmed in Render's web-service docs); the app uses `API_PORT`, falls back to `PORT`, and binds `0.0.0.0`. Health check path `/api/v1/health` (liveness): Render restarts an instance that fails health checks for 60 s, so the check must not depend on the database or Redis. Render uses its own health check, not the Dockerfile `HEALTHCHECK` |
| Maintenance worker | `worker.Dockerfile` | Background worker; no port |
| AI worker | `api.Dockerfile`, command `node dist/ai-worker.js` | Background worker; keep `AI_WORKER_INLINE=false` |
| ClamAV | `docker.io/clamav/clamav:1.4`, private service on port 3310 | Private services accept almost any port and protocol (confirmed). Plan `1c-2g` (2 GB RAM); persistent disk on `/var/lib/clamav` (paid plans only; a service with a disk cannot scale to several instances and has no zero-downtime deploys). First start downloads signatures (several minutes). `MALWARE_SCANNER=clamav` is mandatory: never set `ALLOW_UNSCANNED_UPLOADS`. **[not verified]** Docker Hub pull limits for this image |
| Redis | Render Key Value, plan `256mb` | Valkey 8 (a Redis 7.2 fork, documented as a drop-in replacement). `maxmemoryPolicy: noeviction` (Render itself recommends it for job queues) and `persistenceMode: journal-snapshot` (AOF + snapshots; the free plan has no persistence). `ipAllowList: []` (required field; no external access); the internal URL is reachable only from services in the same workspace and region and is unauthenticated by default. **[not verified]** BullMQ against Valkey 8 on this plan: confirm in staging that a queued job survives a Key Value restart |

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
- **Confirmed in Vercel's documentation:** a proxied request (a rewrite with an external destination) may take at most **120 seconds**, so `experimental.proxyTimeout` (10 min) does not apply on Vercel and a large video upload through the same-origin proxy that needs more than 120 s will fail (a 200 MB video needs roughly 13 Mbps of upstream bandwidth to fit). Vercel Functions have a 4.5 MB body limit; **[not verified]** whether it also applies to rewrites to external origins. For staging, consider lowering `MEDIA_MAX_VIDEO_MB` (for example 50) or testing a real upload before real users.
- **[not verified]** `Set-Cookie` passing through the rewrite; Vercel Hobby plan terms (check that the plan allows your use).

### Port, proxy and database connection (checked in this repository)
- **Port.** The API listens on `API_PORT` and falls back to the host's `PORT` when `API_PORT` is unset (an explicit `API_PORT` wins), then 4000. It binds to `0.0.0.0`. The Dockerfile `HEALTHCHECK` follows the same variables. Covered by `packages/config/src/env.spec.ts`.
- **Proxy.** `TRUST_PROXY_HOPS` (default 1, unchanged behaviour) sets how many reverse-proxy hops are believed for the client IP (Express `trust proxy`): only that many entries counted from the API are trusted, anything a client puts further left in `X-Forwarded-For` is ignored. The client IP feeds login throttling, lockout, the public-chat flood limits and audit records. Cookie security does not depend on it (`Secure` comes from `NODE_ENV`/`COOKIE_SECURE`). Vercel's documentation confirms that it sets `X-Forwarded-For` to the client's public IP and overwrites any value sent by the caller (anti-spoofing). On the Render side, the official pages read did not describe the header; Render's own blog and community posts (not formal documentation) say traffic passes through Cloudflare and Render's load balancers, which append to `X-Forwarded-For` without removing earlier entries, so the leftmost entry must never be trusted. The real hop count behind Vercel then Render is therefore **not verified**: in staging, send requests from two networks, read the IP recorded in the audit log, and raise `TRUST_PROXY_HOPS` (for example to 2) only if it shows the proxy's address. Never set a value higher than the real number of proxies.
- **Prisma `directUrl`.** Deliberately not configured: with `directUrl = env(...)` every Prisma command would require that variable and the migration image would stop working without it. Migrations use `DATABASE_URL`, which must be a **direct** (or session-mode) PostgreSQL connection; the calendar scheduler's advisory locks also require it at run time. Do not point `DATABASE_URL` at a transaction-mode pooler.

### Known risks to test before real users
1. **E-mail ports.** Confirmed by Render: port 25 is blocked for every service and free web services also block 465 and 587; paid services can use 587/465. Still send one real verification e-mail in staging.
2. **Docker Hub pull limits** for the ClamAV image **[verify]**.
3. Nothing has been verified against real OpenAI, S3/R2, SMTP, Render Key Value or Vercel: only MinIO, Mailpit and simulated providers have been used.

### Staging setup: PostgreSQL, Cloudflare R2, SMTP (steps you perform yourself)
Nothing below needs a secret to be shared with anyone: keys are created in each provider's dashboard and typed only into Render (or into your own terminal for the checks). OpenAI stays **disabled** until the AI pilot: leave `OPENAI_API_KEY` empty (AI features then report "not configured"; production validation does not require it).

**1. PostgreSQL (Render Postgres, same region as the services).**
1. Create the database in `frankfurt` (paid plan: the free plan has no recovery). Official prices read from Render's pricing page: `0.1c-256mb` $6/month (100 connections), `0.5c-1g` $19/month, storage expansion $0.30/GB. Point-in-time recovery covers 3 days on a Hobby workspace and 7 on Pro; logical backups are kept 7 days. **[not verified]** how much storage the smallest plan includes.
2. Services use the **internal** URL, with TLS required: append `?sslmode=require` (internal certificates are self-signed, so `verify-ca`/`verify-full` do not work). Use it as `DATABASE_URL` in the three backend services.
3. For the one-off migration from your machine, enable the external URL and restrict it to your own IP, run the migration/seed commands above with that URL, then remove the external access.

**2. Cloudflare R2 (private media).**
1. Create an R2 bucket (staging only: do not reuse it for production). Keep it private: no public bucket URL and no custom domain (the app serves media through API-signed URLs; browsers never call R2 directly, so no CORS rule is needed).
2. Create an R2 API token with *Object Read & Write* limited to that bucket. Note the account ID: `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. `S3_PROVIDER=r2` and `S3_REGION=auto` are already set by the Blueprint.
3. **Before deploying anything**, run the storage check from your machine, with the variables exported in your own shell (the secrets never leave it): `pnpm --filter @touma/api storage:check`.
   - Storage variables: `STORAGE_DRIVER=s3`, `S3_PROVIDER=r2`, `S3_ENDPOINT`, `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
   - The script loads the whole application configuration, so it also needs four values that have nothing to do with R2: `DATABASE_URL` (any well-formed URL, for example `postgresql://u:p@localhost:5432/x`; nothing connects to it), two different `JWT_*_SECRET` values of 32+ characters and `TOKEN_ENCRYPTION_KEY` (32 random bytes in base64). Use throwaway random values (`head -c32 /dev/urandom | base64`), never your real secrets.
   - It uploads, reads back, signs a URL, checks that an unsigned request is refused, deletes and confirms (6 steps), then repeats a round trip with a **streamed 12 MB object** (`STORAGE_CHECK_LARGE_MB`, default 12, `0` turns it off). Above 8 MB the driver uses a multipart upload, the path real images and videos take, which a tiny object never exercises. The large object is compared by SHA-256 and deleted afterwards. Exit code 0 only if all 9 steps pass; the readiness endpoint (`/health/ready`) keeps using the small check only.
4. Known risk: the AWS SDK in use (3.1165) sends CRC32 checksums by default, and community reports describe R2 rejecting some requests (uploads, multipart parts, deletes). Cloudflare's incident was marked resolved, but a recent report says multipart SHA-256 parts still fail. If the storage check fails, the fix is to set `requestChecksumCalculation` and `responseChecksumValidation` to `WHEN_REQUIRED` in `packages/storage/src/s3-object-storage.ts` (a small code change, to be approved and regression-tested against MinIO). **[not verified]** against a real R2 bucket.
5. Facts from Cloudflare's documentation (via search results, not the page itself): presigned URLs work for GET/HEAD/PUT/DELETE, expire between 1 second and 7 days (`MEDIA_URL_TTL_SECONDS` defaults to 1 hour), and only on the `r2.cloudflarestorage.com` domain. Pricing from the same source: free tier of 10 GB-month of storage, 1 M class A and 10 M class B operations per month, then $0.015 per GB-month; egress is free. **[verify]** on Cloudflare's pricing page, and whether a payment method is required to enable R2.

**3. SMTP (the app only speaks SMTP).**
- Render's rules (official): outbound port 25 is blocked for every service; free web services also block 465 and 587. The staging services are paid, so use **587 with STARTTLS** (`SMTP_PORT=587`, `SMTP_SECURE=false`, already set) or 465 (`SMTP_SECURE=true`).
- Candidates (figures from search results, mostly provider blogs, **[verify]** each pricing page; SMTP port support per provider is **[not verified]** here):

| Provider | Free allowance | First paid step | Note |
|---|---|---|---|
| Brevo | 300 emails/day | from about $9/month | SMTP included; simplest for a staging pilot |
| Resend | 3,000/month (100/day) | about $20/month | API-first; check that SMTP is enabled on your plan |
| Postmark | 100/month | about $15/month | Strong transactional reputation, tiny free tier |
| Mailgun | trial or 100/day (sources disagree) | about $15/month | |
| Amazon SES | free tier is time-limited | about $0.10 per 1,000 | Cheapest at volume; needs account/sandbox approval |

- Whatever you choose: verify the sending domain (SPF, DKIM, DMARC), create a dedicated SMTP credential, and enter `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` in Render. Staging sends real e-mails: only use test addresses you own.

**4. 50 MB video limit (staging).**
- `MEDIA_MAX_VIDEO_MB=50` is set for staging in `render.yaml`. The API enforces it (streaming cap, type and size checks, and the Creative worker's video download use the same variable). A 50 MB upload must fit in Vercel's 120 s proxy window, which needs roughly 3.5 Mbps of upstream bandwidth; **[not verified]** the request-body limits of Vercel (rewrites to external origins) and Render.
- ClamAV scans the whole stream and fails closed, and its stock limit is 25 MB (read from `clamav/clamav:1.4`). The Blueprint therefore sets `CLAMD_CONF_StreamMaxLength` and `CLAMD_CONF_MaxFileSize` to 60M (the image applies `CLAMD_CONF_*` variables to `clamd.conf`; the substitution was checked on the image). This was also a latent problem at the default 200 MB.
- **Known mismatch (frontend):** the upload form pre-checks against a constant of 200 MB and its help texts (English and French) say 200 MB. With the 50 MB staging limit the API still refuses larger files, but only after streaming up to 50 MB, and the message names the wrong limit. A follow-up change (the API exposing its limits and the form using them) is proposed, not made.

**5. Staging cost, recurring (Render's pricing page, read today; provider free tiers assumed).**
API `0.5c-512mb` $7 + maintenance worker $7 + AI worker $7 + ClamAV `1c-2g` $25 + its 2 GB disk (about $0.50 at $0.25/GB) + Key Value `256mb` $10 + Postgres `0.1c-256mb` $6 = **about $62.5/month**, plus the Render workspace plan (Hobby $0, Professional $25/month) and Vercel. R2 and SMTP can stay within free tiers at pilot volumes; OpenAI is off. Services bill while they exist: delete or suspend them after testing.

**6. Security checklist before the first deployment.**
- Secrets only in Render's dashboard (never in git, chat, tickets or screenshots); separate staging and production values; rotate the R2 token and SMTP credential after the pilot.
- R2 token limited to one bucket and to object read/write; bucket private.
- PostgreSQL external access only from your IP and only while migrating; `sslmode=require`; strong generated password.
- `MALWARE_SCANNER=clamav` stays on; no `ALLOW_UNSCANNED_UPLOADS`.
- Keep `APP_ENV=staging` (same startup checks as production) and the agent in review mode for any later AI pilot.

### Order of operations (when you decide to apply)
1. Create the PostgreSQL database, the private R2 bucket (token limited to that bucket, `storage:check` passing from your machine) and the SMTP account, as described in "Staging setup" above.
2. Verify the Redis items above, then create the Blueprint in Render and fill the `sync: false` values.
3. Run the migration and the seed with the commands above.
4. Wait for ClamAV signatures, then check `GET /api/v1/health/ready` (database, Redis, storage, scanner and the three worker heartbeats) and run `pnpm --filter @touma/api storage:check` with the staging variables.
5. Deploy the web app on Vercel with `API_URL`.
6. Run the staging checks (sign-up with a real e-mail, image upload, EICAR rejection, IP throttling) before any AI or customer-data test.
