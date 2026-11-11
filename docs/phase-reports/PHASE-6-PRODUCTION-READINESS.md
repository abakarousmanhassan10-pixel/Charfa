# TOUMA — Phase 6 final production readiness

Date: 2026-11-11 · Branch `ccr-ce5eb3d1-r4he6g` · Phase 7 was **not** started.

**Headline: the code and screens requested are built and tested against simulators; no real platform has been contacted, no platform approval has been requested or granted, and TOUMA cannot publish publicly to customers on any platform yet.** No real post was sent. Real API tests were not run: no authorized credentials are configured in this environment (and the platform hosts other than Google's are unreachable from it).

## 1. Completed implementation

**Priority 1 — TikTok audit readiness** (`apps/web/components/social/tiktok-panel.tsx`, `packages/shared/src/tiktok.ts`)
- Creator information: nickname, username, avatar, current visibility options, disabled interactions and maximum video length, read **live** from `creator_info/query` for each use (`GET /social/accounts/:id/tiktok/creator-info`), never cached.
- Privacy selection: chosen by the person from what TikTok offers that account; **no default**; a previously chosen visibility that is no longer offered is cleared, never silently replaced. If only "Only me" is offered the screen says TikTok currently limits the account and that public posting depends on TikTok approving the application.
- Comment, duet, stitch: off by default; greyed out with the reason when the creator disabled them in TikTok; duet/stitch for videos only.
- Commercial content disclosure: off by default; "Your brand" / "Branded content" (at least one); the label TikTok will apply ("Promotional content" / "Paid partnership") is shown; branded content cannot be private (the option is disabled, with the reason).
- Media preview (image or video), Music Usage Confirmation / Branded Content Policy consent with links, processing-time notice, and a final confirmation dialog that summarizes the saved choices before "publish now".
- Server side: settings are stored with the content, stamped with who confirmed and when, audited, and a change withdraws approval and authorization. `submit`, `authorize` and `publish-now` are refused (`TIKTOK_SETTINGS_REQUIRED`) without complete settings; the adapter re-validates, re-queries `creator_info`, and refuses (nothing created) if the visibility is no longer offered or the video is too long; interactions the creator disabled stay off; TikTok's specific errors (audit restriction, unverified URL prefix, visibility mismatch, posting caps, banned account) have actionable messages.
- English and French texts.

**Priority 2 — LinkedIn** — personal and organization are separate connection types (`variant`), with separate scopes, applications and flags (`LINKEDIN_PERSONAL_ENABLED`, `LINKEDIN_ORG_ENABLED` default **false**, `LINKEDIN_ORG_CLIENT_ID/SECRET`, `LINKEDIN_ORG_APPROVAL_REF`). The server refuses to start with organization enabled but no recorded approval. While disabled: no connect button (reason shown), `409 VARIANT_DISABLED`, OAuth/exchange/listing/publish refused in the adapter, publication refused in the engine even for an organization account stored earlier (`CONNECTION_TYPE_DISABLED`, no LinkedIn call). Personal connections never request organization scopes. The earlier default of requesting organization scopes (`LINKEDIN_ORG_SCOPES=true`) was removed.

**Priority 3 — adapter review** (table in `docs/SOCIAL-INTEGRATIONS.md`). Changes made because of it: Instagram publishing quota is read before creating a container; Meta quota/media error subcodes mapped; TikTok and YouTube specific errors mapped; YouTube uploads returned as `private` are recorded with a visible "Not public" note (`visibilityNote`) instead of being presented as public; LinkedIn `DUPLICATE_POST` is treated as an unknown outcome (reconcile), not a failure.

**Priority 4 — production reliability** — verified by tests (below) and extended: after the worker's three automatic reconciliations the authorizer is notified once that a person must decide; cross-tenant access to reconcile/retry/manual-complete/TikTok settings returns 404; the audit trail for a publication's whole life is asserted and scanned for tokens.

**Also:** `live-verify` now reads TikTok `creator_info` and requires an explicit `LIVE_TIKTOK_PRIVACY` before any real TikTok post; `.env.example` documents the new LinkedIn settings.

## 2. Tested real integrations

**None.** `live-verify` was run again in this environment: PASSED 0 · FAILED 0 · SKIPPED 10 (no credentials, no authorized development accounts). No post id or URL in any document comes from a real platform.

## 3. Test results (all against simulators / stubbed networks)

| Check | Result |
|---|---|
| Lint (`--max-warnings=0`), typecheck (17 tasks), build (10 tasks) | pass |
| Unit tests | shared 43, config 18, **social-connectors 61**, ai-engine 98, storage 11, creative 38, worker 5, api 37, web 8 — all pass |
| API integration (real PostgreSQL, Redis, BullMQ, storage; serial) | **415 passed**, 5 skipped (opt-in real-storage suite), 0 failed |
| Browser (Playwright, real built API + web), full suite | **61 passed** — includes 3 TikTok posting-screen tests, the LinkedIn variants test and mobile layouts |
| Migration drift | none (3 new migrations: content platform options, connection variant, publication visibility note) |
| Real API tests | **not run** — no authorized credentials configured |

Reliability areas and where they are proven: duplicate prevention (same hand-off twice → one publication/post; simultaneous workers; worker death before/after the create step), background retries (rate limit/transient backoff, exact-once publish after retries, attempt cap), unknown outcomes (no auto-retry, reconciliation FOUND/NOT_FOUND/AMBIGUOUS/UNAVAILABLE, worker-bounded checks, duplicate-says-exists), tenant isolation (every endpoint 404 across businesses), token security (encrypted at rest, never in responses/logs/audit — scanned), audit logs, error notifications (failure, unknown outcome, reconnect needed, manual required, needs-decision).

## 4. Untested integrations (everything real)

Instagram, Facebook, TikTok, YouTube, LinkedIn personal, LinkedIn organization: OAuth consent round trip, token exchange/refresh, account listing and pagination, permissions, image/video publishing, status, post ids and URLs, reconciliation lookups, creator_info shape, webhook signatures, metrics — **all unverified against the real services.** Field names, subcodes, limits and rules come from public documentation and may be wrong in detail. TikTok's screen has not been shown to TikTok; whether it satisfies their guidelines is TikTok's decision.

## 5. External approvals required (none requested or held)

Details and steps: `docs/SOCIAL-PLATFORM-APPROVALS.md`.
- **Meta:** app, Business Verification (+ Tech Provider access verification), App Review for Advanced Access of 7 permissions with screencasts, Live mode.
- **TikTok:** app, verified media URL prefix, sandbox testing, **app audit** with demo video of the posting screen. Until approved, public posting does not work.
- **YouTube:** OAuth verification (sensitive scope), **API compliance audit** (until then uploads are private), quota extension (10,000 units/day ≈ 6 uploads/day).
- **LinkedIn:** *Share on LinkedIn* (self-serve) for personal; **Community Management API approval** (manual, weeks) before organization publishing; then `LINKEDIN_ORG_ENABLED=true` with `LINKEDIN_ORG_APPROVAL_REF`.

## 6. Remaining production blockers

1. No public HTTPS staging deployment with `SOCIAL_PROVIDER_MODE=live`, registered redirect URIs and verified media domain.
2. Privacy policy, terms and data-deletion page naming the social features not published.
3. No developer applications created; no authorized development accounts; no real OAuth/publishing evidence (run the Level A/B plan in the approvals runbook and paste real `live-verify` output into the verification report).
4. All five platform approvals/audits above.
5. Unverified assumptions to confirm on the first live runs: media rule numbers, Instagram quota response shape, TikTok `creator_info` fields and error codes, YouTube reconciliation by description prefix, LinkedIn reconciliation (restricted permission), Meta 90-day data-access expiry (not tracked).
6. Not built: the calendar's own authorize dialog does not show the TikTok summary (TikTok settings are entered and confirmed in *Social → Publishing*; entries created elsewhere are blocked until settings exist); probe reads whole files into worker memory (up to the platform size limit); no independent security review.
