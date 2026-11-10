# Deployment

| Component | Recommended target | Notes |
|---|---|---|
| Web | Vercel | Root `apps/web`; build `pnpm turbo run build --filter=@touma/web...`; env `API_URL` = public API origin |
| API | Render / Fly.io / AWS ECS (container) | `infrastructure/docker/api.Dockerfile` target `runtime`; health check `/api/v1/health/ready` |
| Worker | Same platform as API (background worker) | `infrastructure/docker/worker.Dockerfile`; scale horizontally, since BullMQ handles locking |
| Migrations | One-off job before each API release | `api.Dockerfile` target `migrate` (`prisma migrate deploy`) |
| PostgreSQL | Managed (Neon, RDS, Render, Supabase) | PITR on, TLS required (`?sslmode=require`) |
| Redis | Managed (Upstash, ElastiCache, Render) | `maxmemory-policy noeviction` (required by BullMQ) |
| Media | S3 / Cloudflare R2 / any S3-compatible | Private bucket, signed URLs |

## Release steps
1. CI green (unit, integration, Playwright, migration drift check).
2. Run the migration job (`prisma migrate deploy`). Migrations must be backward compatible with the running API version (expand → migrate → contract).
3. Deploy the API, then the worker, then the web app.
4. Seed plans once: `pnpm db:seed` (idempotent; it doesn't overwrite admin-edited prices).

## Required production env
`NODE_ENV=production`, `APP_ENV=production` (turns off Swagger UI), `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (distinct, 32+ chars), `TOKEN_ENCRYPTION_KEY` (32 bytes base64), `WEB_URL`, `CORS_ORIGINS`. The API refuses to start if any of these is missing or invalid.

Cookies are `Secure` automatically in production. Put the API behind HTTPS (`trust proxy` is set to 1 hop).
