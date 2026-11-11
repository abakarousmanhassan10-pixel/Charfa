# Integrations & credentials

An integration with no credentials stays **not configured**. The app reports it as such (see `/api/v1/health/ready` → `integrations`) and never simulates it.

| Integration | Phase | Env vars | Status |
|---|---|---|---|
| OpenAI (text, structured outputs) | 3 | `OPENAI_API_KEY` (+ `AI_MODEL`, pricing vars) | Implemented; not configured by default. AI endpoints return 503 until the key is set. See `docs/AI.md` |
| Image generation provider | 4 | provider-specific (modular) | Not configured |
| Video generation provider | 4–5 | provider-specific (modular) | Not configured |
| S3-compatible storage | 2 | `STORAGE_DRIVER=s3`, `S3_PROVIDER` (aws\|r2\|minio\|custom), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_AUTO_CREATE_BUCKET` | Implemented. **Not verified against a real bucket in the development sandbox** (see `docs/phase-reports/PHASE-2-HARDENING.md`); CI job `real-storage` runs the round trip against MinIO. Verify any deployment with `pnpm --filter @touma/api storage:check`. The bucket must be private |
| Meta (Instagram Graph API, Facebook Pages) | 6 | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Not configured. Needs Meta App Review for `instagram_content_publish`, `pages_manage_posts`, etc. Instagram publishing requires Business/Creator accounts |
| TikTok Content Posting API | 6 | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Not configured. Direct Post needs an app audit; unaudited apps can only post privately |
| YouTube Data API v3 | 6 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Not configured. Needs OAuth consent screen verification; unverified projects upload as private |
| Payments (Stripe, behind an abstraction) | 10 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLAN_*_PROVIDER_PRICE_ID` | Not configured |
| Transactional email | 2 | `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Implemented over standard SMTP (any provider). Verified against a local SMTP server in tests; no external provider configured. `EMAIL_TRANSPORT=log` is development only |
| Malware scanning | 2 | `MALWARE_SCANNER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | Implemented (clamd INSTREAM); verified against a real clamd 1.5.4 with EICAR test signatures |

When a platform's API can't publish a given format, the publication is set to `MANUAL_REQUIRED` and the user gets a manual publishing workflow.
