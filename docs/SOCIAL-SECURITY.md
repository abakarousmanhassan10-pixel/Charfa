# Social media security (Phase 6)

| Requirement | How it is met |
|---|---|
| Never request or store social passwords | OAuth 2.0 only: the person signs in on the platform. TOUMA stores only access and refresh tokens |
| Official APIs only | Adapters call the platforms' documented endpoints; no scraping, no browser automation, no unofficial endpoints |
| Tokens encrypted | AES-256-GCM (`TokenCipher`, key `TOKEN_ENCRYPTION_KEY`) for access tokens, refresh tokens, the PKCE verifier and the tokens held while a person chooses accounts. Disconnecting overwrites the stored token |
| Tokens never in responses | Account, publication, status and queue responses are built from explicit DTOs without token fields; provider handles (`providerRef`, `providerResponse`, `payload`, idempotency key) are not returned; tested by scanning every social response for known tokens |
| Tokens never in logs, errors or audit | Provider errors are redacted (`access_token`, `refresh_token`, `client_secret`, `Authorization`, codes, upload ids) before they are stored or shown; audit metadata is passed through the existing redactor |
| OAuth CSRF and replay | Random 256-bit `state`, only its SHA-256 stored, single use (claimed with a conditional update), 10-minute expiry, bound to the platform, the person and the business; tested for forged, replayed, expired and cross-platform states |
| Business isolation | Every query is scoped by `businessId`; other businesses get 404 for accounts, connections, publications, analytics and queue; a pending connection can only be completed by the person who started it; an entry can only publish to an account of its own business |
| Permissions checked before every publishing action | Roles: `social.read` (all members), `social.manage` (Admin, Owner: connect, disconnect, refresh), `publication.schedule` (Admin, Owner: schedule, publish now, retry, manual completion). The engine re-checks the account's status and permissions and the authorizer's permission when it executes, not only when it was scheduled |
| Explicit authorization to publish | Content must be approved in its current version and then authorized by a person; any edit withdraws both; the engine refuses a publication whose version, approval or authorization no longer matches |
| No fake success | `PUBLISHED` only from a platform-issued id; manual publications are recorded as manual and never as provider-confirmed; unknown outcomes are never retried automatically |
| Webhooks authenticated | Meta: verify token on subscription and `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, app secret); TikTok: `TikTok-Signature` HMAC over `timestamp.body` with a 5-minute window. Missing or wrong signatures are rejected before anything is stored; valid deliveries are stored once (idempotent) |
| TikTok consent is recorded, not assumed | Privacy, interactions, disclosure and the Music Usage / Branded Content consent are the person's explicit choices (no pre-selection), saved with who confirmed and when, audited (`calendar.tiktok_settings_saved`), tied to the content version (a change withdraws approval) and re-validated by the server and the adapter; the creator's live options are fetched per request and never cached |
| Organization publishing cannot be enabled by accident | `LINKEDIN_ORG_ENABLED` defaults to false; enabling it without `LINKEDIN_ORG_APPROVAL_REF` makes the server refuse to start; disabled connection types are refused at start, OAuth, token exchange, listing and publishing (also for accounts stored earlier) |
| Reconciliation is read-only and scoped | The platform lookup never creates anything; it runs under the same tenant scoping (other businesses get 404), needs `publication.schedule`, and records `social.reconciled_found` / `social.reconciled_uncertain` with the actor |
| Audit trail | `social.connect_started/failed`, `connected`, `reconnected`, `disconnected`, `token_refreshed`, `token_expired`, `published`, `publish_failed`, `outcome_unknown`, `manual_required`, `manual_published`, `publish_retried`, `reconciled_found`, `reconciled_uncertain`, `calendar.tiktok_settings_saved` plus the calendar actions (`calendar.submitted/approved/authorized/dispatched/published…`) and approval records |
| Abuse and cost | Throttles on connection start, callback and metric refresh; per-platform validation before sending; bounded retries |
| Simulator cannot reach production | `SOCIAL_PROVIDER_MODE=fake` is refused unless `APP_ENV=test` and flagged by production validation |
| Media URLs | Platforms download media through short-lived signed URLs (`PUBLIC_API_URL` + HMAC signature, expiry); the bucket stays private; publication is refused if the API address is not a public https address |

## Residual risks and operator responsibilities
- The signed media URL is a bearer link valid for its lifetime (`MEDIA_URL_TTL_SECONDS`, 1–3 times that value). Keep it short but longer than the slowest platform download (`SOCIAL_PROCESSING_TIMEOUT_MINUTES`).
- Losing `TOKEN_ENCRYPTION_KEY` makes stored tokens unreadable (accounts must be reconnected); leaking it, together with a database copy, exposes tokens. Store it in a secret manager and rotate with a planned reconnect.
- Platform app secrets live in the environment of the API and worker; restrict who can read them.
- Meta and TikTok webhook handlers store events and wake the poller; they do not act on event content beyond that.
- No independent security review of this code was done. The controls above are covered by automated tests written with the code.
