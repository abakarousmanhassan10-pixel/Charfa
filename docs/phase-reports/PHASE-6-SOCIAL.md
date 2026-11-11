# Phase 6 – Social media management and automated publishing

Status: implemented and tested against **stubbed HTTP and a test-only platform simulator**. **No real platform was contacted**: no developer application, credential or test account was available, so **no real OAuth connection, publication or metrics read has been verified**. Do not describe any platform as working in production until the manual checklist in [../SOCIAL-PUBLISHING.md](../SOCIAL-PUBLISHING.md#verifying-against-real-platforms) has been run.

## 1. Implemented platform adapters (`packages/social-connectors`)
`InstagramPublisher`, `FacebookPublisher` (Meta Graph API), `TikTokPublisher` (Content Posting API), `YouTubePublisher` (Data API v3, resumable upload), `LinkedInPublisher` (REST Posts API), all behind one `PlatformAdapter` interface (OAuth URL, code exchange, refresh, account listing, validation, publish, status polling, metrics, token inspection, revoke). Official APIs only. Supported formats: text, image, carousel, video, Instagram Reels, YouTube Shorts where the API allows; the rest goes to the manual fallback (matrix in [../SOCIAL-INTEGRATIONS.md](../SOCIAL-INTEGRATIONS.md)). A test-only simulator (`SOCIAL_PROVIDER_MODE=fake`, refused outside `APP_ENV=test`) stands in for the platforms in automated tests.

Engine and services (`apps/api/src/social`): accounts and OAuth workflow, publishing engine, queue and worker, analytics, authenticated webhooks, integrated with the Phase 5 calendar through `PUBLISHING_GATEWAY`.

## 2. Database changes
Migrations `20261112090000_social_publishing` and `20261112090100_calendar_social_account`: `LINKEDIN` platform; `SocialAccount` (account type, parent, refresh bookkeeping, non-secret metadata); new `SocialConnectionSession` (hashed single-use state, encrypted PKCE verifier and tokens during account selection); `Publication` (resume point, duplicate-protection markers, provider confirmation, manual completion, payload snapshot, next check, error code); `CalendarEvent.socialAccountId`. No drift.

## 3. API endpoints
`/api/v1/social`: `status`; `accounts` (list, get, refresh, disconnect); OAuth (`connections/:platform/start`, public `oauth/callback/:platform`, pending connection get/select/cancel); `publications` (history, detail, retry, manual-complete); `queue`; `analytics` (summary, per publication, refresh); `webhooks/meta`, `webhooks/tiktok` (signature-authenticated). Calendar: `POST entries/:id/publish-now`, `PUT entries/:id/account`. Details: [../SOCIAL-PUBLISHING.md](../SOCIAL-PUBLISHING.md).

## 4. Frontend pages
`/dashboard/social` (overview with platform filter), `/accounts` (connect, account selection, reconnect, disconnect, refresh, statuses), `/publishing` (composer with media picker, approval pipeline, publish now with explicit authorization), `/queue` (counters, in-flight, scheduled), `/history` (filters, errors, links, retry, manual completion, metrics), `/settings` (platform configuration, redirect URIs, permissions, formats, restrictions). English and French. The calendar entry dialog gained account choice and *Publish now*; the notification bell shows reconnect, expiry, manual and published notices.

## 5. Automated test results (this session)
| Suite | Result |
|---|---|
| Lint, typecheck, production build | pass |
| Unit tests | 273 pass (shared 38, config 17, ai-engine 98, storage 11, worker 5, api 37, creative 38, web 8, **social-connectors 21**). One earlier full run showed a timeout in `creative` `compose.spec` under parallel load; it passes alone (38/38) |
| API e2e (real PostgreSQL, Redis, BullMQ, ClamAV; platform simulator) | 391 pass, 5 skipped (real-storage suite needs MinIO); **52 new**: social accounts 19, social publishing 33 |
| Browser e2e (Playwright) | 57 of 57 pass: 48 earlier + **9 social**, 2 at 390×844 |
| Prisma migrations | up to date, no drift |

Covered (against the simulator and stubbed HTTP):
- **OAuth workflows:** start, callback, selection, PKCE, forged/replayed/expired/cross-platform state, platform errors, missing permissions, reconnect (same account only), disconnect (revoke, wipe), binding to person and business.
- **Token expiration and refresh:** background refresh, refusal and transient failure, warning before non-renewable expiry, expiry, revocation detection, refresh before publishing, one renewal after a mid-publication rejection.
- **Publishing:** text, image (real signed media URL checked), carousels, Reels/Shorts/videos, manual fallback, validation failures, scheduled hand-off only after the due time, publish now, business timezone.
- **API failures and retries:** transient errors, rate limits, exhaustion, permission and rejection errors, retry by a person, asynchronous processing and timeouts.
- **Duplicate prevention:** same hand-off twice, five simultaneous workers, a worker that died before sending (retried once), a worker that died after sending or an ambiguous answer (unknown outcome, never retried automatically; confirmation required), container reuse.
- **Approval requirements:** nothing unapproved or unauthorized is sent; edits after authorization, a change queued behind a hand-off, and a demoted authorizer all stop publication.
- **Business isolation and security:** 404 across businesses for accounts, connections, publications, analytics and queue; tokens and provider handles absent from every response; webhook signatures (valid, missing, wrong secret, stale, duplicate).
- **Analytics:** zero stored as zero, missing stored as unavailable, engagement only when computable, platform refusal stored as unavailable with the reason, collection schedule.
- Adapter unit tests: request shapes per platform, error mapping, token redaction, YouTube upload-session resume, LinkedIn text escaping.

## 6. Real integration test results
**None.** No real platform was contacted, no real OAuth connection was completed, no real post, video or metric was created or read. Everything above ran against stubbed HTTP or the simulator, which prove TOUMA's own behavior (state handling, encryption, validation, idempotency, retries, UI) and the shape of the requests TOUMA builds from public documentation, not that any platform accepts them. The manual verification procedure is in [../SOCIAL-PUBLISHING.md](../SOCIAL-PUBLISHING.md#verifying-against-real-platforms).

## 7. Platform limitations
- **Meta:** app review (Advanced Access) and business verification are needed to serve other merchants' accounts; Instagram needs a professional account linked to a Page; Instagram has no text-only posts and needs JPEG images; Facebook Reels are manual; media must be downloadable from a public https URL.
- **TikTok:** posts are private until TikTok audits the app; the media domain must be verified; no text-only posts.
- **YouTube:** uploads cost 1,600 quota units (default 10,000/day); videos from an unaudited API project are locked private; videos and Shorts only; the Shorts duration limit TOUMA uses (60 s) may be conservative.
- **LinkedIn:** Company Pages need the Community Management API (approval per application); tokens last about 60 days and refresh tokens exist only for approved partners; the API version header must be kept current.
- Platform limits used for validation (`PLATFORM_CAPABILITIES`) are conservative values from public documentation and must be re-verified.

## 8. Remaining work and limitations
1. **Run the real-platform verification** for every platform with authorized test accounts, fix whatever differs, and record the results. Until then every adapter is unverified.
2. **Facebook and Instagram pagination:** the Page list reads up to 100 Pages (no paging). Businesses with more would not see the rest.
3. **Media constraints are partial:** aspect-ratio rules (for example Instagram's allowed range), pixel dimensions and video codec checks are not validated; the platform may reject what TOUMA accepted (the failure is then reported). Videos and images are read fully into memory when an adapter needs the bytes (YouTube, LinkedIn), bounded by the media library limits.
4. **YouTube Analytics, TikTok/LinkedIn insights beyond basic counts, audience demographics and follower growth** are not collected; only the foundation (null-vs-zero storage, schedule, summary) exists. No analytics charts yet.
5. **Webhooks:** Meta events are authenticated and stored but not acted upon; TikTok publish events wake the poller. Instagram/Facebook comment and message events (Phase 8) are not handled.
6. **Retry after an unknown outcome is deliberately manual.** The safe behavior costs a person's attention; there is no platform-side lookup that could settle it automatically.
7. **Account selection UI is per connection:** there is no bulk management for businesses with many accounts, and a platform account cannot be shared between businesses (the same external account can be connected to several businesses independently).
8. **Notifications are in-app only** (no email or push). The `social.published` notice goes to the authorizer and people who schedule.
9. The TikTok privacy level is chosen automatically (most public allowed); there is no per-post privacy, comment, duet or stitch control. Instagram share-to-feed, YouTube category, audience (made-for-kids) and Facebook targeting use fixed defaults.
10. Tests host the workers inside the API process; the two-process topology, the new CI steps and the Docker images were not run here. No independent security review was done.

Phase 7 has not been started.
