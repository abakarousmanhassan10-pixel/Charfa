# Social integrations (Phase 6)

TOUMA connects to **Instagram, Facebook, TikTok, YouTube and LinkedIn** through each platform's **official API and OAuth 2.0 only**. There is no scraping, no browser automation and no password handling: a person signs in on the platform's own screen, approves the permissions, and TOUMA keeps only an encrypted access token.

> **Verification status.** The adapters were written against the platforms' public documentation and are covered by unit tests against a stubbed network and by end-to-end tests against a test-only simulator. **No real platform account, developer application or API credential was available, so no real OAuth connection, publication or metrics read has been verified.** Treat every adapter as unverified until you have run the checklist in [SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md#verifying-against-real-platforms). Platform limits, scopes and review requirements change: re-check each portal before launch.

## How a connection works
1. An administrator (permission `social.manage`) clicks *Connect* → `POST /api/v1/social/connections/:platform/start`. TOUMA stores a hash of a random single-use `state` (and an encrypted PKCE verifier where the platform supports it) with a 10-minute lifetime and returns the platform's authorization URL.
2. The browser goes to the platform, the person signs in and approves permissions.
3. The platform redirects the browser to TOUMA's callback `GET {PUBLIC_API_URL}/api/v1/social/oauth/callback/{platform}`. A forged, replayed, expired or cross-platform `state` is rejected; platform errors and refusals connect nothing.
4. TOUMA exchanges the code, lists the accounts the login can publish to (Pages, Instagram professional accounts, channels, profiles, Company Pages) and shows them for **account selection**. Only selected accounts are saved, with encrypted tokens. An account is "connected" only at this point.
5. **Reconnection** renews an existing account in place (same external account required). **Disconnection** revokes access at the platform where possible and wipes the stored token.

Statuses: `CONNECTED`, `TOKEN_EXPIRED` (reconnect needed), `PERMISSION_MISSING` (a permission needed to publish was not granted), `DISCONNECTED`, `ERROR`. Missing permissions that only affect analytics do not block publishing.

## Token refresh and monitoring
The social worker (every `SOCIAL_TICK_MS`) refreshes tokens that are close to expiry where the platform allows it (YouTube hourly, TikTok daily; LinkedIn only for approved partners), warns administrators `SOCIAL_TOKEN_WARN_DAYS` before a token that cannot be renewed expires, flags expired or revoked authorizations as `TOKEN_EXPIRED` (once a day it asks Meta and Google whether the token is still valid) and sends a *reconnect needed* notification. A token is also refreshed just before each publication, and a token rejected mid-publication is renewed once.

## Developer application setup
Create one application per platform, register TOUMA's **redirect URI** (shown in *Social → Settings*, form `https://<API host>/api/v1/social/oauth/callback/<platform>`), and put the credentials in the environment of the API and worker processes (never in the repository or the browser). All of this needs `PUBLIC_API_URL` set to the public https address of the API.

### Meta (Facebook Pages and Instagram) — `META_APP_ID`, `META_APP_SECRET`
- App type: Business, with *Facebook Login for Business* (or Facebook Login). Valid OAuth redirect URIs: the Facebook and the Instagram callback URIs.
- Permissions requested: Facebook `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `read_insights`; Instagram `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`.
- **Access:** without app review (Advanced Access) and business verification, only people with a role on the app can connect. Publishing to other merchants' Pages and Instagram accounts requires Advanced Access.
- Instagram needs a **professional (Business or Creator) account linked to a Facebook Page**. The person needs the `CREATE_CONTENT` task on the Page.
- Webhooks (optional): callback `…/api/v1/social/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN` (≥ 16 characters), signature verified with `META_APP_SECRET`.
- Page tokens derived from a long-lived user token do not expire; user tokens cannot be refreshed without the person.

### TikTok — `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
- Products: Login Kit and Content Posting API (Direct Post). Redirect URI: the TikTok callback URI.
- Scopes: `user.info.basic`, `video.publish`, `video.upload`, `video.list` (statistics).
- **Restriction (see `docs/SOCIAL-PLATFORM-APPROVALS.md`):** until TikTok audits the application, every post is private to the creator (`SELF_ONLY`). TOUMA uses the most public option the creator and the app allow and shows the result; it does not hide this restriction.
- Media is pulled by TikTok from `PUBLIC_API_URL`: the **domain must be verified** in the TikTok app (URL prefix verification).
- Webhooks (optional): `…/api/v1/social/webhooks/tiktok`, signature `TikTok-Signature: t=…,s=…` verified with `TIKTOK_CLIENT_SECRET`.

### YouTube (Google) — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Enable *YouTube Data API v3* in a Google Cloud project; OAuth client type *Web application*; authorized redirect URI: the YouTube callback URI. TOUMA uses PKCE, `access_type=offline` and `prompt=consent` to obtain a refresh token.
- Scopes: `youtube.upload`, `youtube.readonly`. Sensitive scopes need OAuth consent-screen verification for production use.
- **Restrictions:** an upload costs **1,600 quota units** (default 10,000 per day per project). Videos uploaded through an API project that has **not passed Google's API compliance audit are locked to private**. Only videos (and Shorts) can be published.
- Shorts are ordinary uploads that are short, vertical or square; TOUMA marks them with `#Shorts` and uses the Shorts URL. TOUMA currently treats videos of 60 seconds or less as eligible (Google has raised the limit for some uploads; verify).

### LinkedIn — `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION`, `LINKEDIN_ORG_SCOPES`
- Products: *Sign In with LinkedIn using OpenID Connect* and *Share on LinkedIn* (personal profile, scope `w_member_social`). Posting as a **Company Page** needs the **Community Management API** product (scopes `w_organization_social`, `r_organization_social`, `rw_organization_admin`), which LinkedIn approves per application.
- If your application has not been approved for the Page scopes, set `LINKEDIN_ORG_SCOPES=false`; otherwise LinkedIn refuses the whole authorization request.
- Access tokens last about 60 days. LinkedIn issues refresh tokens only to approved partners; otherwise the person must reconnect (TOUMA warns 7 days ahead).
- The REST API is versioned by the `LinkedIn-Version` header (`LINKEDIN_API_VERSION`, YYYYMM). LinkedIn retires old versions: update it periodically.

## Platform support matrix (what the official API publishes)
| Format | Instagram | Facebook | TikTok | YouTube | LinkedIn |
|---|---|---|---|---|---|
| Text | manual | ✓ | manual | manual | ✓ |
| Image | ✓ (JPEG) | ✓ | ✓ (photo post) | manual | ✓ |
| Carousel / multi-image | ✓ (2–10) | ✓ (2–10) | ✓ (photo post) | manual | ✓ (2–20) |
| Video | ✓ as Reel | ✓ | ✓ | ✓ / Short | ✓ |
| Reels / Shorts | Reels ✓ | Reels: manual | — | Shorts ✓ | — |
"Manual" = TOUMA prepares the text and downloadable files and the person publishes, then confirms (see *manual publishing fallback* in [SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md)). The limits TOUMA enforces before sending (caption length, hashtags, file types and sizes, durations, item counts) are in `packages/shared/src/social.ts` (`PLATFORM_CAPABILITIES`); they are conservative values from public documentation and must be re-verified.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_API_URL` | – | Public https address of this API: redirect URIs, webhooks and the media URLs platforms download from. Required in production when any platform is configured |
| `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` (`v21.0`), `META_WEBHOOK_VERIFY_TOKEN` | – | Facebook and Instagram |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | – | TikTok |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | – | YouTube |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION` (`202411`), `LINKEDIN_ORG_SCOPES` (`true`) | – | LinkedIn |
| `SOCIAL_PROVIDER_MODE` | `live` | `fake` = test-only simulator, refused unless `APP_ENV=test`, flagged by production validation |
| `SOCIAL_STATE_TTL_MINUTES` | 10 | Lifetime of an OAuth connection attempt |
| `SOCIAL_TOKEN_REFRESH_AHEAD_HOURS`, `SOCIAL_TOKEN_WARN_DAYS` | 24, 7 | Token monitoring |
| `SOCIAL_PUBLISH_ATTEMPTS`, `SOCIAL_PUBLISH_BACKOFF_MS`, `SOCIAL_WORKER_CONCURRENCY`, `SOCIAL_TICK_MS`, `SOCIAL_PROCESSING_TIMEOUT_MINUTES`, `SOCIAL_RATE_LIMIT_PER_MINUTE` | 3, 10000, 3, 30000, 30, 30 | Publishing worker |
| `TOKEN_ENCRYPTION_KEY` | – | Existing 32-byte key that encrypts stored tokens (AES-256-GCM). Rotate carefully: tokens are unreadable without it |

A platform whose credentials are missing is reported as *not configured* in *Social → Settings* (only the names of the missing settings are shown, never values) and cannot be connected.

## Testing
- `pnpm --filter @touma/social-connectors test`: adapters against a scripted network (request shapes, error mapping, token redaction, resumable uploads, metrics null-vs-zero).
- `apps/api/test/social-accounts.e2e-spec.ts`, `social-publishing.e2e-spec.ts`: OAuth workflow, tokens, refresh, reconnect, disconnect, webhooks, publication flows against the simulator (`SOCIAL_PROVIDER_MODE=fake`, `APP_ENV=test`).
- `tests/e2e/social.e2e.ts`: the dashboard in a browser; the platform's sign-in screen is simulated by intercepting the redirect and returning to TOUMA's real callback.
- **Real integration tests are separate and manual**: see the checklist in [SOCIAL-PUBLISHING.md](SOCIAL-PUBLISHING.md#verifying-against-real-platforms).
