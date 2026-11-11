# Deployment

| Component | Recommended target | Notes |
|---|---|---|
| Web | Vercel | Root `apps/web`; build `pnpm turbo run build --filter=@touma/web...`; env `API_URL` = public API origin |
| API | Render / Fly.io / AWS ECS (container) | `infrastructure/docker/api.Dockerfile` target `runtime`; health check `/api/v1/health/ready` |
| Worker | Same platform as API (background worker) | `infrastructure/docker/worker.Dockerfile`; scale horizontally, since BullMQ handles locking; liveness `GET :4001/health` |
| AI worker | Same platform as API (background worker), same image | `api.Dockerfile` target `runtime` with command `node dist/ai-worker.js`; consumes the `touma.ai` queue; scale horizontally; health `GET :4002/health`; keep `AI_WORKER_INLINE=false` on the API |
| Migrations | One-off job before each API release | `api.Dockerfile` target `migrate` (`prisma migrate deploy`) |
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
