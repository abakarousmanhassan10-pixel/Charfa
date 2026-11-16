# Demo hosting on Render (free plan): what works, what is limited, how to lift each limit

Live demo: web https://touma-web.onrender.com · API https://touma-api.onrender.com (branch `ccr-ce5eb3d1-r4he6g`, `render.demo.yaml`, APP_ENV=test: simulated providers, nothing is published or billed).

| Limit | Cause | Status |
|---|---|---|
| The API is slow on the first request (~1 min) | Render's free plan puts a service to sleep after ~15 min without traffic | **Mitigated**: (1) the API calls its own public health URL every 10 min between 08:00 and 22:00 UTC (`KEEP_ALIVE_URL`, `apps/api/src/health/keep-alive.service.ts`), which counts as traffic; (2) the sign-in page wakes the API while you type and retries for ~80 s with a clear message; (3) `.github/workflows/keep-demo-awake.yml` tries to wake it at the start of the window (GitHub runs scheduled jobs late or skips them, so it is only a helper). Still true: outside the window the API sleeps, and the first visit then waits up to a minute. The web service also sleeps (Render shows its own loading screen for ~30 s): keeping it awake too would exceed the free hours. |
| Uploaded files disappear at each restart | `STORAGE_DRIVER=memory` (a free web service has no persistent disk) | **Needs your account**: see "Persistent files" below |
| No verification / reset e-mails | `EMAIL_TRANSPORT=log` (messages are only written to the log) | **Needs your account**: see "E-mails" below |
| Everything creative is simulated | Intended: `CREATIVE_STUDIO_MODE=mock`, fake AI/social providers | Not a defect. Real providers need your authorization, prices and budget (see CREATIVE-MOCK.md §5). |

## The 750-hour rule (why the keep-alive is limited)
Render gives 750 free instance hours per **workspace** per month, shared by all free web services (here: touma-api, touma-web and two other services of the workspace). A service kept awake 24 h/day uses ~720 h alone. The keep-alive keeps only the API awake 14 h/day (~430 h). The web service wakes by itself in a few seconds to a minute when a page is opened (the page just loads slowly, no error). For a service that never sleeps, use a paid instance (about 7 USD/month each).

## Persistent files (free: Cloudflare R2, 10 GB)
1. Create a Cloudflare account, then R2 → create a bucket (e.g. `touma-demo`).
2. R2 → Manage API tokens → create a token with *Object Read & Write* on that bucket. Note the Access Key ID, Secret Access Key and the account endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
3. In the Render dashboard, service **touma-api** → Environment, set (secrets stay in Render, never in chat or in the repository):
   - `STORAGE_DRIVER=s3`, `S3_PROVIDER=r2`, `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET=touma-demo`, `S3_ACCESS_KEY_ID=…`, `S3_SECRET_ACCESS_KEY=…`, `S3_FORCE_PATH_STYLE=true`
4. Save: Render redeploys. Check `/api/v1/health/ready` → `storage` is no longer "memory (test only)". (`pnpm --filter @touma/api storage:check` does a real round trip.)
Note: with APP_ENV=test the API accepts S3 too; the simulated Creative Studio media are stored through the same storage.

## E-mails (free: Brevo, 300 mails/day, or any SMTP)
1. Create a Brevo account, validate a sender address, create an SMTP key (SMTP & API → SMTP).
2. On **touma-api** set: `EMAIL_TRANSPORT=smtp`, `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER=…`, `SMTP_PASSWORD=…`, `EMAIL_FROM=TOUMA AI <your-validated-address>`.
3. Save: Render redeploys. Create an account: the confirmation e-mail now arrives.
Sign-in does not require the e-mail to be verified today, so this is optional for the demo.
