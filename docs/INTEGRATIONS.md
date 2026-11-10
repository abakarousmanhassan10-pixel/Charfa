# Integrations & credentials

An integration with no credentials stays **not configured**. The app reports it as such (see `/api/v1/health/ready` → `integrations`) and never simulates it.

| Integration | Phase | Env vars | Status |
|---|---|---|---|
| OpenAI (text, structured outputs) | 3 | `OPENAI_API_KEY` | Not configured |
| Image generation provider | 4 | provider-specific (modular) | Not configured |
| Video generation provider | 4–5 | provider-specific (modular) | Not configured |
| S3-compatible storage | 4 | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Not configured (MinIO available locally) |
| Meta (Instagram Graph API, Facebook Pages) | 6 | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Not configured. Needs Meta App Review for `instagram_content_publish`, `pages_manage_posts`, etc. Instagram publishing requires Business/Creator accounts |
| TikTok Content Posting API | 6 | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Not configured. Direct Post needs an app audit; unaudited apps can only post privately |
| YouTube Data API v3 | 6 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Not configured. Needs OAuth consent screen verification; unverified projects upload as private |
| Payments (Stripe, behind an abstraction) | 10 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLAN_*_PROVIDER_PRICE_ID` | Not configured |
| Transactional email | 2/10 | provider-specific | Not configured |

When a platform's API can't publish a given format, the publication is set to `MANUAL_REQUIRED` and the user gets a manual publishing workflow.
