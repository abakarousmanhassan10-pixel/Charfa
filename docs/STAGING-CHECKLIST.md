# TOUMA AI — private staging: ordered deployment checklist and readiness status

Nothing here has been executed against a real account. Status legend: **READY** = verified (repository, provider documentation read in this project, or run locally); **PREPARED** = prepared but not tested against the real service; **BLOCKING** = must be resolved before the step it gates. Details and costs: [STAGING-RUNBOOK.md](STAGING-RUNBOOK.md), [EMAIL.md](EMAIL.md), [DEPLOYMENT.md](DEPLOYMENT.md).

## A. Readiness status
| Item | Status | Evidence / gap |
|---|---|---|
| Migrations and seed (`migrate.Dockerfile`) | READY (local) | 17 migrations + seed apply and re-apply on throwaway PostgreSQL 16; image runs as non-root. Not run on Render Postgres |
| API and worker images | READY (build path) / PREPARED (apt layer) | Built locally with the `apt-get` step removed (the session proxy blocks it): `pnpm deploy`, Prisma client load, `dist/main.js`, `dist/ai-worker.js` present, non-root. The real `openssl`/font packages layer was **not** built here |
| Start commands and refusal of insecure config | READY | The built API, AI worker and worker refuse a staging start with an insecure environment (7 problems listed) |
| Staging environment of the Blueprint | READY (simulated) | With placeholder values it passes the staging startup validation for API and both workers; a control with missing values is refused |
| `render.yaml` against Render | PREPARED | Matches Render's published Blueprint spec (plan IDs, keys); never validated or applied by Render |
| PORT / `0.0.0.0` / health check | READY | `API_PORT` falls back to `PORT`; binds `0.0.0.0`; Render check on `/api/v1/health` (liveness) |
| `trust proxy` | PREPARED | `TRUST_PROXY_HOPS` (default 1) tested in unit tests; real hop count behind Vercel then Render not measured |
| HTTPS, CORS, cookies | READY (code) / PREPARED (real hosts) | Refresh cookie `Secure`, `SameSite=Strict`, path-scoped; CSRF header + Origin must be in `CORS_ORIGINS` or `WEB_URL`; `helmet` on the API; production/staging refuse http origins. Cookie through the Vercel rewrite untested; Vercel preview domains will not authenticate unless listed |
| PostgreSQL / Prisma | READY (local) / PREPARED (Render) | No `directUrl` by design; `DATABASE_URL` must be a direct connection with `sslmode=require`; backup/restore rehearsal not done |
| Redis / BullMQ | READY (local Valkey 8) / PREPARED (Render) | `noeviction` + journal persistence, job survives restart locally; Render Key Value not tested |
| Cloudflare R2 / private storage | PREPARED | Defaults set; multipart round trip passes on MinIO only. **Real R2 never called** |
| SMTP and verification e-mails | READY (local SMTP) / PREPARED (real provider) | Timeouts, TLS/port validation, templates, 18 e2e tests with a local SMTP server. No provider account, no SPF/DKIM/DMARC |
| Health endpoints | READY (code) | `/api/v1/health`, `/api/v1/health/ready` (database, Redis, storage, scanner, worker heartbeats); worker ports 4001/4002 are internal |
| Secrets in Git | READY | Pattern scan finds only a deliberate fake in a test; `dump.rdb` untracked; `.env*` ignored |
| OpenAI | PREPARED (off) | Not in the Blueprint; AI features report "not configured" |
| CI | BLOCKING for production, advised before staging | The remote only has the feature branch; CI runs on `main`/pull requests, so it never ran: all results above are local |
| Swagger on staging API | BLOCKING (decision) | Off only when `APP_ENV=production`, so `/api/docs` is public on staging |
| Provider accounts (Cloudflare, e-mail + DNS, Render, Vercel) | BLOCKING | None created; each needs your account, and Render/Vercel/Cloudflare may need payment |

## B. Ordered checklist (stop at each paid or account-bound step)
**Phase 0 — free, no Render**
1. Decide Swagger (accept / restrict / approve a code change); run CI once on a `main` or pull request if you want it as a gate.
2. Cloudflare: create the account, enable R2, create bucket `touma-staging-media` (private), create a bucket-scoped Object Read & Write token.
3. From your terminal run `pnpm --filter @touma/api storage:check` with the R2 variables and four throwaway placeholders; 9/9 steps must pass. If a checksum error appears: stop and request the `WHEN_REQUIRED` fix.
4. E-mail provider: create the account, add the sending subdomain, publish DKIM/SPF, add DMARC `p=none`, wait for "verified", create the SMTP credential.
5. Locally build the three images on a machine with normal network access (the apt layer).

**Phase 1 — Render database (about $6/month)**
6. Create the workspace; region `frankfurt`; Postgres 16 `0.1c-256mb`.
7. Take a logical backup; enable the external URL for your IP only; run the `migrate` image (migration, then seed); check 17 finished migrations and 3 plans; remove the external access.

**Phase 2 — API (about +$17/month)**
8. In `render.yaml` comment out ClamAV and both workers; apply the Blueprint (creates Key Value + API); enter the dashboard values (names in STAGING-RUNBOOK §2). Do not enter any OpenAI value.
9. Check `/api/v1/health` and `/api/v1/health/ready`; test sign-up, verification mail (inbox, SPF/DKIM/DMARC PASS), forgot-password, invitation, using the API directly.

**Phase 3 — Vercel (free on Hobby)**
10. Import the repository (root `apps/web`, include files outside root, Node 22, `pnpm install --frozen-lockfile`, build `pnpm turbo run build --filter=@touma/web...`); set `API_URL`; deploy.
11. Put the Vercel domain in `WEB_URL` and `CORS_ORIGINS` on the Render services; redeploy them.
12. Test login/refresh cookie through Vercel; record the client IP from two networks and set `TRUST_PROXY_HOPS` only from that measurement.

**Phase 4 — uploads (about +$25.5/month, temporary)**
13. Un-comment ClamAV; wait for signatures; test EICAR (refused), 10 MB image, 50 MB video (within Vercel's 120 s), 60 MB video (refused); watch memory.
14. Delete ClamAV when finished.

**Phase 5 — queues (about +$14/month, temporary)**
15. Un-comment both workers; check both heartbeats in `/health/ready`; restart Key Value and confirm a queued job survives; check retention/cleanup jobs.

**Phase 6 — later, separate approval:** AI pilot (OpenAI key, model, prices, review mode).

## C. Monthly cost and billing risks
Verified list prices (Render pricing page, Vercel docs): API/worker `0.5c-512mb` $7 each; ClamAV `1c-2g` $25 + 2 GB disk $0.50; Key Value `256mb` $10; Postgres `0.1c-256mb` $6; workspace Hobby $0 or Professional $25; Vercel Hobby $0, Pro $20 per developer seat. Computed: full stack **$62.50/month** (about $0.086/hour, billing prorated by the second); minimum useful stack (Postgres + Key Value + API) **about $23/month**. Not verified: R2 and e-mail free tiers, domain name, included Postgres storage.

Risks: (1) a Blueprint creates every service in it, so comment out later phases; (2) ClamAV is 41% of the bill: create it only for upload tests; (3) services and disks bill until deleted; whether a suspended service is billed is not verified; (4) Postgres storage expansion ($0.30/GB) and disks ($0.25/GB) grow silently; (5) the Professional workspace adds $25/month; (6) Vercel Hobby terms for your use not verified, Pro is per seat; (7) bandwidth/build-minute overages on Render and Vercel not verified; (8) e-mail free-plan caps (for example 100/day) stop mails rather than bill; (9) OpenAI is off: no usage cost until the pilot; (10) `autoDeployTrigger: "off"` is set and no previews are configured, so commits do not trigger surprise builds.
