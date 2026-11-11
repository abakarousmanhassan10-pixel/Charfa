# TOUMA — Phase 6 final integration verification

Date: 2026-11-11 · Branch: `ccr-ce5eb3d1-r4he6g` · Phase 7 was **not** started.

## Bottom line

**No real platform integration has been verified.** This environment has no Meta, TikTok, Google or LinkedIn credentials, no authorized development accounts, and cannot reach `graph.facebook.com`, `open.tiktokapis.com` or `api.linkedin.com` (HTTP 000 through the agent proxy; `www.googleapis.com` answers but there is no credential to use). Therefore:

- **Real OAuth tests: NOT RUN.**
- **Real publishing tests (Instagram, Facebook, TikTok, YouTube, LinkedIn): NOT RUN.** No post id or URL in this report comes from a real platform.
- **Platform approvals: none applied for, none held.** TOUMA must not be described as able to publish publicly to customers on any platform.

What this task did deliver is the code hardening the review asked for, a credential-gated live-verification tool that will produce real evidence the moment credentials exist, the approvals runbook, and automated tests (simulated platforms only) for everything implemented.

---

## 1. Automated tests (simulated platforms / stubbed network — NOT evidence of real platform behavior)

| Suite | Result |
|---|---|
| Lint (`eslint . --max-warnings=0`) | pass |
| Typecheck (17 turbo tasks) | pass |
| Unit tests, all packages | **295 passed** (config 17, shared 38, ai-engine 98, storage 11, web 8, **social-connectors 43**, worker 5, api 37, creative 38) |
| API end-to-end, whole suite, serial (real PostgreSQL, Redis, BullMQ, storage) | **400 passed, 5 skipped** (opt-in real-storage suite), 0 failed. ClamAV suite needs `infrastructure/clamav/start-test-clamd.sh` running; it failed once because clamd was down and passed (3/3) once started |
| Browser end-to-end (Playwright, rebuilt web + API) — social and calendar specs | **23 passed**. The other Playwright specs were not re-run (unchanged code paths) |
| Prisma migration drift (`migrate diff` against the migrated DB) | no difference |

New automated coverage in this task:

- **Meta pagination** (`verification.spec.ts`): a manager with 230 Pages is listed completely (cursor and `paging.next`), 120 Instagram accounts across pages, repeating-cursor guard, endless listing stops at the safety cap and flags `listingTruncated` on every account; YouTube `nextPageToken`; LinkedIn organization ACL paging; personal profile vs organization separation.
- **Media probing and rules**: MP4/MOV (duration, pixels, codecs), PNG, JPEG parsing; aspect ratio, minimum/maximum pixels, megapixels, video codec, audio codec, with messages naming the measured value and the fix; multi-item posts name the faulty item. The probe was also run by hand on real ffmpeg-produced H.264, HEVC and VP9 files and JPEG and read them correctly (this proves the parser, not any platform's acceptance).
- **API e2e**: wrong aspect ratio rejected with no platform call; HEVC/AC-3 rejected; a stored row that lies about the file is overruled by the file's real bytes; a file that is not a video is rejected.
- **Reconciliation e2e**: unknown outcome → platform lists the post → recorded as PUBLISHED, provider-confirmed, one post only; nothing found → stays with a person, retry still needs confirmation, no auto-retry; ambiguous (two matching posts) and unavailable lookups → no state change, reason stored, audited; a permission error on the lookup is never read as "not found"; the worker reconciles on its own at most 3 times; a viewer cannot trigger it.
- Existing tests were adjusted only where the new validation correctly rejected their test data (an Instagram 600×800 carousel image is outside 4:5; the test video helper now builds a structurally valid MP4 instead of an opaque stub).

## 2. OAuth tests

| Check | Result |
|---|---|
| Real OAuth round trip with any platform (consent screen, redirect, code exchange, account selection, encrypted storage) | **NOT RUN** — no app registrations, no credentials, no accounts, no public callback URL |
| Authorization URL construction, state/PKCE handling, single-use state, code exchange, account selection, encrypted token storage, refresh/expiry monitoring against the **simulator** | pass (Phase 6 suites `social-accounts.e2e-spec.ts`, Playwright social flows). These prove TOUMA's logic only |
| `live-verify` OAuth steps | all `SKIPPED` — missing `META_APP_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET` and `LIVE_*_TOKEN` |

## 3. Real publishing tests

`pnpm --filter @touma/social-connectors live-verify -- --publish` was run in this environment. Its actual output (10 steps, all skipped; nothing was sent anywhere):

```
Mode: read + REAL test publishing · PASSED 0 · FAILED 0 · SKIPPED 10
FACEBOOK / INSTAGRAM / TIKTOK / YOUTUBE / LINKEDIN
  oauth.configuration  SKIPPED  Missing server configuration: <app id/secret names>
  oauth.token          SKIPPED  No LIVE_*_TOKEN supplied: no authorized development account to test with
```

| Platform | Image | Video | Status read-back | Post id | Post URL |
|---|---|---|---|---|---|
| Instagram | not tested | not tested | not tested | not tested | not tested |
| Facebook | not tested | not tested | not tested | not tested | not tested |
| TikTok | n/a | not tested | not tested | not tested | not tested |
| YouTube | n/a | not tested | not tested | not tested | not tested |
| LinkedIn (personal / organization) | not tested | not tested | not tested | not tested | not tested |

## 4. Platform approval status

None of these has been applied for by TOUMA. Detailed steps, documents and restrictions: [`docs/SOCIAL-PLATFORM-APPROVALS.md`](../SOCIAL-PLATFORM-APPROVALS.md).

| Platform | Needed for real customers | Status | Until then |
|---|---|---|---|
| Meta (Instagram, Facebook) | Meta app, **Business Verification** (+ Tech Provider access verification), **App Review for Advanced Access** of 7 permissions with screencasts, Live mode, privacy/terms/data-deletion URLs | not started | works only for people with a role on a Development-mode app, on their own assets |
| TikTok | App, verified media URL prefix, **app audit** (UX guidelines: creator info, privacy choice, interaction toggles, commercial-content disclosure; demo video) | not started | **public publishing does not work**: posts are limited to private visibility. TOUMA must not claim otherwise |
| YouTube | Google Cloud project, **OAuth verification** (sensitive scope), **API compliance audit**, **quota extension** (10,000 units/day = ~6 uploads/day at 1,600 units each) | not started | **uploads are locked to private**; Testing-mode refresh tokens expire after 7 days |
| LinkedIn personal | LinkedIn app + *Share on LinkedIn* (self-serve) | not started | possible quickly |
| LinkedIn organization | **Community Management API** approval (manual, weeks), Page verification, admin role | not started | personal profiles only; organizations shown as unavailable |

## 5. What was implemented (no architecture rebuilt)

1. **Media validation** — `probeMedia` reads the real bytes; `MEDIA_RULES` per platform (aspect, pixels, megapixels, video/audio codec) on top of existing size, type and duration limits; engine probes before sending, fails with `MEDIA_INVALID` and a specific message, calls no platform API.
2. **Reconciliation** — new `reconcile()` on every adapter (Facebook `published_posts`, Instagram `/media`, TikTok status-by-id + `video/list`, YouTube uploads playlist, LinkedIn `posts?q=author`), `SocialPublisherService.reconcile`, `POST /social/publications/:id/reconcile`, worker auto-checks (≤ 3, 15 min apart), 5 new `Publication` columns (migration `20261113090000_publication_reconciliation`), audit events, dashboard "Check the platform" button + EN/FR text. Only an exact single match becomes PUBLISHED; everything else stays with a person; the unknown-outcome rules from Phase 6 (no automatic retry, `confirmNotPublished`) are unchanged.
3. **Pagination** — Graph API listings follow cursors to the end (page size 50, loop guard, 200-request cap with an explicit `listingTruncated` flag); YouTube channels and LinkedIn organization ACLs are paged as well.
4. **`live-verify` tool** — real adapters, real APIs, credentials from the environment, never prints tokens, `SKIPPED` with reasons instead of fake passes, optional `--publish`, Markdown report.
5. **Documentation** — `SOCIAL-PLATFORM-APPROVALS.md` (new), additions to `SOCIAL-PUBLISHING.md`, a pointer in `SOCIAL-INTEGRATIONS.md`.

## 6. Known limitations and unverified assumptions (honest list)

- **All platform rules are from public documentation, unverified against real APIs**: the `MEDIA_RULES` numbers, Instagram 4:5–1.91:1 and JPEG-only, TikTok/LinkedIn dimension limits, scopes, review requirements. A platform answer always wins; the live run is what confirms them.
- **Reconciliation matching is by exact text since the attempt began.** YouTube compares the description prefix; LinkedIn needs a restricted read permission and will normally answer `UNAVAILABLE`; TikTok needs `video.list`. None of the five lookups has run against a real API. Two genuinely identical posts yield `AMBIGUOUS` (safe, but needs a person).
- **TikTok-mandated posting UI is not built** (creator info display, privacy picker, interaction toggles, commercial disclosure). It is a precondition of the TikTok audit.
- **LinkedIn Community Management may require a separate LinkedIn app** from the sign-in/share app; TOUMA has one LinkedIn configuration today.
- The probe reads the whole file into worker memory (up to the platform's size limit, e.g. 1 GB for Facebook video). Fine at current scale; a head/tail range read would be the next optimization. Rotated phone videos (rotation matrix in `tkhd`) were not tested.
- Webhook signature checks, metrics and token-refresh flows remain verified only against simulators.

## 7. Remaining blockers and the exact external actions required

| # | Blocker | Exact action (owner) |
|---|---|---|
| 1 | No public staging deployment | Deploy API + web on HTTPS with `SOCIAL_PROVIDER_MODE=live`, `PUBLIC_API_URL`, `TOKEN_ENCRYPTION_KEY`; register `{PUBLIC_API_URL}/api/v1/social/oauth/callback/{platform}` on every platform (TOUMA ops) |
| 2 | Legal pages | Publish privacy policy, terms, data-deletion page naming the social features (TOUMA owner) |
| 3 | Meta app + dev assets | Create Business-type Meta app, add Facebook Login + Instagram, add team testers, create a Facebook Page and a linked Instagram Professional account (TOUMA owner) |
| 4 | Meta live verification | Obtain a tester long-lived user token, run `live-verify -- --publish` with `LIVE_MEDIA_IMAGE_URL` / `LIVE_MEDIA_VIDEO_URL`; run the full OAuth round trip in the staging UI; attach the report (engineer + tester) |
| 5 | Meta Business Verification | Submit legal documents and domain verification in Meta Business Suite (TOUMA legal entity) |
| 6 | Meta App Review | Submit the 7 permissions with screencasts, test instructions and test user; switch to Live (TOUMA owner) |
| 7 | TikTok app | Create app (Login Kit + Content Posting API), verify media URL prefix, add sandbox target users, live-verify (expect private results) |
| 8 | TikTok audit | Build the mandatory posting UI, record the demo video, submit for audit; re-verify a public post after approval |
| 9 | YouTube | Cloud project + Data API v3, consent screen, OAuth client, live-verify in Testing mode (expect private), then OAuth verification, API compliance audit and quota extension request; re-verify public upload |
| 10 | LinkedIn personal | Create app, add *Sign In with LinkedIn using OpenID Connect* + *Share on LinkedIn*, live-verify personal publishing |
| 11 | LinkedIn organization | Associate and verify the TOUMA Page, request Community Management API, decide single vs separate app, then set `LINKEDIN_ORG_SCOPES=true` and live-verify organization publishing separately |
| 12 | Evidence | After each platform's live run, replace "not tested" in section 3 with the real report output (post id, URL opened, status read-back, visibility obtained) and delete the test posts |

Until items 1–4 (Meta), 7 (TikTok), 9 (YouTube) and 10 (LinkedIn) are completed, the correct statement is: **TOUMA's social publishing is implemented and tested against simulators only; no platform integration has been verified against the real service.**
