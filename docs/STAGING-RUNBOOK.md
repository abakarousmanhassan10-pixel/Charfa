# TOUMA AI — private staging runbook (external services)

Nothing here has been executed: no account exists, nothing is deployed, no migration ran on a remote database. `render.yaml` has not been applied or validated by Render. Each statement is labelled **verified** (read from this repository, from Render's/Vercel's documentation pages, or run locally in this project), **simulated** (tested only against local stand-ins) or **not verified**.

## 1. What is verified, simulated, not verified
| Area | Verified | Simulated (local stand-ins only) | Not verified |
|---|---|---|---|
| PostgreSQL | 17 migrations and the seed apply and re-apply cleanly with the `migrate` image on PostgreSQL 16 (throwaway container) | — | Render Postgres itself, TLS, external access procedure, restore |
| Redis / BullMQ | Render Key Value is Valkey 8, supports `noeviction` and `persistenceMode`; a BullMQ job and scheduler survived a restart on Valkey 8.1 with `noeviction` + AOF | Local container, not Render | BullMQ on Render's instance, connection limits under load |
| Cloudflare R2 | Config defaults (`r2`, region `auto`); `storage:check` with a 20 MB multipart object passes on MinIO | MinIO | **Any real R2 call**, token permissions, multipart/checksum behaviour |
| SMTP | Startup validation, timeouts, templates; 18 e2e tests against a local SMTP server | Local SMTP server | **Any real provider**, SPF/DKIM/DMARC, inbox placement |
| ClamAV | Stock stream limit is 25 MB; `CLAMD_CONF_*` override works on the image | EICAR test in CI against a local clamd | Render private service, memory use, signature download time |
| OpenAI | — | Simulated provider in tests | **Disabled for staging** (deferred to the AI pilot); never called |
| Blueprint | The environment it produces passes the API's and workers' staging startup validation (simulated with placeholder values) | — | Render's own validation and apply |
| Vercel proxy | Docs: 120 s limit on proxied requests; `X-Forwarded-For` set to the client IP and not spoofable through Vercel | — | Cookies through the rewrite, request-body limits, real hop count at the API |

## 2. Environment variables per service (names only)
All three backend processes run the same startup validation (`APP_ENV=staging` behaves like production), so each needs the common set.

| Variable | API | Maint. worker | AI worker | Where it comes from |
|---|---|---|---|---|
| `NODE_ENV`, `APP_ENV=staging`, `STORAGE_DRIVER`, `S3_AUTO_CREATE_BUCKET`, `S3_PROVIDER=r2`, `S3_REGION=auto`, `EMAIL_TRANSPORT`, `SMTP_PORT`, `SMTP_SECURE`, `MALWARE_SCANNER`, `CLAMAV_PORT`, `RATE_LIMIT_STORE`, `AI_PROVIDER`, `SOCIAL_PROVIDER_MODE`, `VIDEO_PROVIDER`, `AI_WORKER_INLINE`, `MEDIA_MAX_VIDEO_MB=50` | ✔ | ✔ | ✔ | Blueprint group `touma-staging-shared` |
| `REDIS_URL` | ✔ | ✔ | ✔ | Blueprint (Key Value internal URL) |
| `CLAMAV_HOST` | ✔ | – | ✔ | Blueprint (private service host) |
| `API_PORT=10000`, `PORT` | ✔ | – | – | Blueprint |
| `DATABASE_URL` (internal URL + `?sslmode=require`) | ✔ | ✔ | ✔ | **You**, dashboard |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `TOKEN_ENCRYPTION_KEY` | ✔ | ✔ | ✔ | **You**: random values, identical across the three services, never reused for production |
| `WEB_URL`, `CORS_ORIGINS` (https, the Vercel domain) | ✔ | ✔ | ✔ | **You** |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | ✔ | ✔ | ✔ | **You**, from Cloudflare |
| `SMTP_HOST`, `EMAIL_FROM` | ✔ | ✔ | ✔ | **You** (needed by startup validation everywhere) |
| `SMTP_USER`, `SMTP_PASSWORD` | ✔ | – | – | **You**: only the API sends e-mail |
| `OPENAI_API_KEY`, `SALES_AGENT_MODEL`, `AI_MODEL_PRICING` | – | – | – | **Not set in staging.** Added only for the AI pilot (leaving `SALES_AGENT_MODEL` empty would stop startup, so it is not in the Blueprint) |
| Vercel: `API_URL` (public https URL of the API, read at build time) | | | | **You**; no secret on Vercel |

Without `OPENAI_API_KEY` the AI features report "not configured" (verified by the startup simulation: it starts, `openai: false`).

## 3. Dependencies (read from the code)
| Component | Hard dependencies (it cannot work without) | Soft / reported only |
|---|---|---|
| API | PostgreSQL, Redis (queues, rate limits), R2 (media), SMTP (best effort: a failed send is logged) | ClamAV (uploads fail closed with 503 when down; `/health/ready` reports it), worker heartbeats, OpenAI |
| Maintenance worker | PostgreSQL, Redis, R2 (storage cleanup) | — |
| AI worker | PostgreSQL, Redis, R2, ClamAV (generated media is scanned) | OpenAI, social platforms (not configured) |
| Web (Vercel) | the API (rewrite fixed at build time) | — |
Hence: the API and web can be tested without ClamAV and workers (no uploads, no queued jobs).

## 4. Order of creation (spend as late as possible)
Render bills compute **prorated by the second** (pricing page): a service that exists for 3 hours costs 3 hours. Applying a Blueprint creates **every** service in it, so comment out the services of later phases in `render.yaml` before applying, and add them back when needed (Render syncs added services; **not verified** in this repository). Prices below are the monthly list prices read from Render's pricing page, shown also per hour (monthly ÷ 730).

| Phase | Create | Why now | Monthly / hourly |
|---|---|---|---|
| 0 — free, no Render | Cloudflare R2 bucket + token; run `storage:check` (with the large object) from your machine; sending domain + e-mail provider account + DNS (SPF, DKIM, DMARC); Vercel project (Hobby) left unbuilt | Finds provider problems (R2 checksums, DNS) before paying for compute | $0 (R2 and e-mail free tiers **not verified**) |
| 1 | Render Postgres `0.1c-256mb`; run the migration and seed with the `migrate` image | Validates database, TLS and migration on the real service | $6 / $0.008 |
| 2 | Key Value `256mb`, API `0.5c-512mb` | `/health/ready`, sign-up, verification and reset mails, cookies | +$17 / +$0.023 |
| 3 | Vercel build with `API_URL` | Proxy, cookies, client IP at the API, `TRUST_PROXY_HOPS` | $0 on Hobby |
| 4 | ClamAV `1c-2g` + 2 GB disk | Upload tests only (EICAR, 10 MB image, 50 MB video) | +$25.50 / +$0.035 |
| 5 | Maintenance worker and AI worker, `0.5c-512mb` each | Heartbeats, queues, retention, calendar scheduler | +$14 / +$0.019 |
| 6 (later, separate approval) | OpenAI key, model, prices | AI pilot | usage-based |

Delete or suspend what you are not using (**not verified**: whether a suspended Render service or database is still billed; deleting is certain to stop billing but destroys data, so keep Postgres between sessions if you need the data).

## 5. Manual procedure
**Cloudflare**
1. Create or sign in to a Cloudflare account; enable R2 (a payment method may be required: **not verified**).
2. Create bucket `touma-staging-media`: private, no public URL, no custom domain, no CORS rule.
3. Create an API token, *Object Read & Write*, limited to that bucket. Note the account ID.
4. In your own terminal export the storage variables plus four throwaway placeholders (see `docs/DEPLOYMENT.md`, "Cloudflare R2") and run `pnpm --filter @touma/api storage:check`. All 9 steps must pass. If an upload or the large multipart step fails with a checksum error, stop: a code fix is needed (see DEPLOYMENT.md).

**E-mail provider** (see `docs/EMAIL.md`): create the account, add the sending subdomain, publish the DKIM/SPF records, add DMARC `p=none`, wait for "verified", create the SMTP credential.

**Render**
1. Create the workspace (Hobby or Professional; PITR window is 3 or 7 days). Choose region `frankfurt` for everything.
2. Create Postgres 16 (`0.1c-256mb`). Copy the **internal** URL, append `?sslmode=require`. Enable the external URL only for your IP while running the migration, then remove it.
3. From your machine: `docker build -f infrastructure/docker/migrate.Dockerfile -t touma-migrate .`; take a logical backup; run the migration and the seed commands from `docs/DEPLOYMENT.md`; check 17 finished migrations and 3 plans.
4. Apply the Blueprint for the phase-2 services only. Enter the dashboard values listed in section 2 (secrets generated with `openssl rand -base64 48`; `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32`). Do not enter any OpenAI value.
5. Check `GET <api>/api/v1/health` and `/api/v1/health/ready` (database, Redis, storage `verified`).
6. Later phases: re-add the commented services, wait for ClamAV signatures (several minutes), re-check readiness.

**Vercel**
1. Import the repository; root directory `apps/web` with files outside the root included; Node 22; install `pnpm install --frozen-lockfile`; build `pnpm turbo run build --filter=@touma/web...`.
2. Set `API_URL` to the API's public https URL (it is baked in at build time: redeploy after any change).
3. Put the resulting Vercel domain in `WEB_URL` and `CORS_ORIGINS` on the three Render services and redeploy them.
4. Hobby is free; Pro costs $20 per developer seat per month (Vercel docs). Whether Hobby terms allow your use is **not verified**.

## 6. Tests required before going live
1. **Local, before any Render spend:** `storage:check` on R2 (9 steps, large object included); DNS records show SPF, DKIM, DMARC verified at the provider.
2. **Database:** migration applies; 17 migrations finished, 3 plans; second run reports nothing pending; `select pg_advisory_lock(1)` works on the URL the services use; backup taken and a restore rehearsed in a throwaway database.
3. **API:** `/health/ready` ok; sign-up, verification e-mail arrives in the inbox (not spam), link works, forgot-password, password-changed notice, invitation; SPF/DKIM/DMARC PASS in the headers.
4. **Cookies and proxy:** login through Vercel keeps the session; refresh cookie is `Secure`, `SameSite=Strict`; client IP recorded in the audit log from two different networks (adjust `TRUST_PROXY_HOPS` only from this measurement); login throttling and chat flood limits key on distinct clients.
5. **Uploads (with ClamAV):** EICAR file refused; 10 MB image and 40–50 MB video accepted within the 120 s Vercel window on a normal connection; a 60 MB video refused; ClamAV memory and scan time observed.
6. **Queues (with workers):** both heartbeats appear in `/health/ready`; a queued job survives a Key Value restart; retention and cleanup jobs run.
7. **Failure drills:** stop the SMTP credential (sign-up still succeeds, error logged); stop ClamAV (uploads 503, nothing stored).
8. **Security:** no secret in the repository or logs; R2 bucket not publicly readable. **Known:** the Swagger UI (`/api/docs`) is switched off only when `APP_ENV=production` (read from `bootstrap.ts`), so it is publicly reachable on a `staging` API: restrict access, or accept it for a private pilot, or approve a small code change to disable it by variable.
9. **AI:** not part of staging go-live; OpenAI stays disabled until the pilot plan is approved.

## 7. Budget
**Verified (Render pricing page, read in this project; Vercel docs):** compute `0.5c-512mb` $7/month, `1c-2g` $25/month; Key Value `256mb` $10/month; Postgres `0.1c-256mb` $6/month (100 connections), `0.5c-1g` $19/month; disk $0.25/GB/month; Postgres storage expansion $0.30/GB; billing prorated by the second; workspace plans Hobby $0 or Professional $25/month plus compute; Vercel Hobby free, Pro developer seat $20/month.

**Computed from those prices:** full staging stack, running all month, **$62.5/month** (API 7, maintenance worker 7, AI worker 7, ClamAV 25 + disk 0.5, Key Value 10, Postgres 6) = about **$0.086/hour**. Examples: four 4-hour test sessions with the whole stack ≈ **$1.4**; one week continuous ≈ **$14.4**. Add the workspace plan if Professional.

**Estimates (not verified on the providers' own pages):** Cloudflare R2 free tier (10 GB-month, 1 M writes, 10 M reads per month, then $0.015 per GB-month, free egress); e-mail free tiers (Resend 3,000/month and 100/day, Brevo 300/day, SES time-limited); OpenAI $0 while disabled; domain name and DNS: your registrar's price; Postgres base storage included in the plan: unknown.

**Smallest sensible spend:** phases 0–3 only = Postgres + Key Value + API ≈ **$23/month** (≈ $0.03/hour), then add ClamAV and the workers only for their tests.

## 8. Stop points (need your account, payment or decision)
Cloudflare/R2 activation; e-mail provider account and DNS; Render workspace and any service; Vercel project; every value entered in a dashboard; the OpenAI pilot.
