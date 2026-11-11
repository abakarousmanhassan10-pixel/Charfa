# Social publishing engine (Phase 6)

## Architecture
```
Calendar entry (approved + explicitly authorized)
   └─ calendar scheduler (BullMQ touma.calendar)  ── when due ──►  PUBLISHING_GATEWAY (SocialPublishingGateway)
                                                                      └─ SocialPublisherService.accept()  → Publication (QUEUED), idempotent on the dispatch key
                                                                           └─ BullMQ touma.social → SocialPublisherService.process()
                                                                                └─ PlatformAdapter (InstagramPublisher, FacebookPublisher, TikTokPublisher, YouTubePublisher, LinkedInPublisher)
                                                                                     └─ official platform API (fetch)
Results flow back through CalendarResultsService (recordPublished / recordFailed), never from the calendar itself.
```
- **Adapters** (`packages/social-connectors`) implement `PlatformAdapter`: `buildAuthorizationUrl`, `exchangeCode`, `refresh`, `listAccounts`, `validate`, `publish`, `status`, `fetchMetrics`, `inspectToken`, `revoke`. The engine never contains platform specifics. A new platform is one adapter plus an entry in `PLATFORM_CAPABILITIES`.
- **Network** is injected (`FetchLike`), so tests replace it completely; **credentials** come from the environment only.
- The worker process is `node dist/ai-worker.js` (AI, creative, calendar and social workers); inline in development with `AI_WORKER_INLINE=true`. Health: `/api/v1/health/ready` reports `socialWorker`.

## Publishing flow and guarantees
1. **Approval and authorization are preserved.** An entry reaches the publisher only after `content.approve` approved its current version and a person with `publication.schedule` scheduled it (or used *Publish now*, which is the same authorization at the same instant). Editing the text withdraws both. The engine re-checks at execution time that the entry is still scheduled, the content version equals the approved and authorized version, and the authorizer still has the permission; otherwise nothing is sent.
2. **Validation before sending.** Caption length, hashtags, media type, size, duration, item counts and orientation are checked against the platform's limits. Invalid content fails with an explicit message; nothing is sent.
3. **Account checks before every publication.** The account must exist for this business, be `CONNECTED`, have the permissions needed to publish and a working token (refreshed when near expiry). A platform response that rejects the token triggers one renewal and one retry; a refusal for permissions marks the account `PERMISSION_MISSING`.
4. **Success only from the platform.** A publication is `PUBLISHED` only when the adapter returns a platform-issued id (stored with the URL when available). Asynchronous platforms (Instagram containers, Facebook video processing, TikTok) stay `AWAITING_PROVIDER` and are followed until the platform confirms or rejects; webhooks (Meta, TikTok, authenticated by signature) wake the poller. A post the platform never finishes fails as `PROCESSING_TIMEOUT` with an unknown outcome. Nothing is simulated.
5. **Manual publishing fallback.** Where the official API cannot publish the format (Instagram, TikTok and YouTube text; YouTube images; Facebook Reels…), the publication becomes `MANUAL_REQUIRED`: TOUMA notifies the people who schedule, and the history shows the text and downloadable files. The person publishes and confirms with *I published it* (optionally with the link). This is stored as `mode=MANUAL`, `confirmedByProvider=false`, audited, and metrics are not collected for it.
6. **Statuses:** `QUEUED` → `PUBLISHING` → (`AWAITING_PROVIDER`) → `PUBLISHED` | `FAILED`, plus `MANUAL_REQUIRED` and `CANCELLED`. The calendar entry mirrors it (`SCHEDULED` → `PUBLISHING` → `PUBLISHED` | `FAILED`).

### Never publishing twice
- One `Publication` per hand-off; its idempotency key is the calendar's dispatch key (`<entry>-<version>-<time>`). The same hand-off arriving again (retry, worker restart) returns the existing publication. Jobs use the publication id as job id and are claimed with a conditional update, so simultaneous workers cannot both run it.
- Provider steps that open provider-side state are **checkpointed** (`providerStage`/`providerRef`): Instagram container id, Facebook staged photos, TikTok publish id, YouTube resumable upload session. A retry resumes there instead of starting over (YouTube first asks the upload session whether the file already arrived).
- Just before the single request that creates the post, the adapter calls `beforeCreate()`, which stores `submitStartedAt`. If the process dies afterwards, or the platform answers ambiguously (timeout, 5xx, dropped connection), TOUMA **does not know whether the post exists**. The publication becomes `FAILED` with `outcomeUnknown=true` and is **never retried automatically**. A person must check the platform, then either *mark it as published* or *confirm it is not there and retry* (`POST /social/publications/:id/retry {confirmNotPublished:true}`).
- Only failures that prove nothing was created are retried automatically: platform refusals (rate limit, expired token, validation) and failures before the creating step. Retries use exponential backoff up to `SOCIAL_PUBLISH_ATTEMPTS`; then the publication fails and people are notified (a person can retry it).

### Recovery
The social worker tick re-queues publications whose job vanished (API died between saving and queueing), recovers `PUBLISHING` rows whose lock expired (the rule above then decides), follows `AWAITING_PROVIDER` rows and executes scheduled retries. The calendar worker recovers its own claims; the publisher is idempotent on the same key.

## Timezones
Entries are scheduled in the business timezone (stored in UTC with the zone). The publication keeps `scheduledAt` and `timezone`; "publish now" uses the current instant.

## Analytics foundation
`SocialAnalyticsService` collects metrics for platform-confirmed posts (hourly on day one, every 6 hours the first week, then daily to 90 days) into `AnalyticsSnapshot`. **A metric the platform did not provide is stored as NULL (unavailable); a number, including 0, is a value the platform reported; nothing is estimated.** `engagementRate` is computed only when the platform gave both interactions and reach (or impressions), otherwise NULL. The reason metrics are missing (permission, platform limitation) is stored. Manual publications have no metrics. Summaries total only available values and report how many posts could or could not provide each metric (`total: null` when none). The Phase 5 time recommendations use these snapshots automatically once at least 10 posts have measured engagement.

## API (`/api/v1/social`)
`GET status`; accounts: `GET accounts`, `GET accounts/:id`, `POST accounts/:id/refresh|disconnect`; OAuth: `POST connections/:platform/start`, `GET oauth/callback/:platform` (public), `GET|DELETE connections/:id`, `POST connections/:id/select`; publications: `GET publications`, `GET publications/:id`, `GET queue`, `POST publications/:id/retry`, `POST publications/:id/manual-complete`; analytics: `GET analytics/summary`, `GET|POST analytics/publications/:id[/refresh]`; webhooks (signature-authenticated): `GET|POST webhooks/meta`, `POST webhooks/tiktok`. Calendar additions: `POST calendar/entries/:id/publish-now`, `PUT calendar/entries/:id/account`. Permissions: read `social.read`; connect, disconnect, refresh `social.manage` (Admin, Owner); retry, manual completion, publish now `publication.schedule`; analytics `analytics.read`.

## Verifying against real platforms
Do this with **authorized test accounts** before relying on any adapter (none was run for this phase):
1. Create the developer applications (see [SOCIAL-INTEGRATIONS.md](SOCIAL-INTEGRATIONS.md)), set the credentials and `PUBLIC_API_URL` (https, reachable from the internet), run the API and `node dist/ai-worker.js`.
2. Per platform: connect a test account through the UI; check the status, the selected account and the permissions shown; check the account list shows no tokens.
3. Publish: a text post (Facebook, LinkedIn), a JPEG image, a 2-image carousel, a short vertical video (Instagram Reel, YouTube Short, TikTok), a long YouTube video. For each, confirm on the platform that exactly one post exists, with the right text, media and privacy, and that TOUMA recorded the id and a working link. For TikTok and YouTube, note whether the post is private (unaudited app).
4. Negative checks: revoke the app's access in the platform settings and confirm TOUMA flags `TOKEN_EXPIRED`; connect an account lacking a permission and confirm `PERMISSION_MISSING`; publish an unsupported format and confirm the manual fallback.
5. Token lifecycle: for YouTube and TikTok confirm background refresh; for Meta and LinkedIn confirm the expiry warning appears.
6. Metrics: after a day, compare TOUMA's numbers with the platform's own; confirm unavailable metrics show "—" and not 0.
7. Restart test: stop the worker during a publication and confirm no duplicate post (an *unknown outcome* is the expected, safe result when it was stopped mid-request).
Record the date, platform, account and result of each step; this report's "real integration results" stay empty until then.

---

## Media probing and per-platform rules (Phase 6 final verification)

Before a publication is sent, the engine reads each media file's own bytes (`probeMedia`: MP4/MOV `mvhd`/`tkhd`/`stsd`, JPEG/PNG headers) and validates pixel dimensions, aspect ratio, duration, video/audio codec, size and type against the platform (`MEDIA_RULES` in `@touma/social-connectors`, plus `PLATFORM_CAPABILITIES`). A file whose content is not what its type says fails with `MEDIA_INVALID` and a message naming the measured value and the allowed range. Files already over the platform's size limit are rejected by size without being read. No platform API is called when validation fails. See `docs/SOCIAL-PLATFORM-APPROVALS.md` §5 for the table.

## Reconciliation of unknown outcomes

When a create request may have reached the platform but the answer was lost (timeout, dropped connection, process death after `beforeCreate`), the publication becomes `FAILED` with `outcomeUnknown = true` and is **never retried automatically**. Reconciliation asks the platform what exists (read-only, `adapter.reconcile`):

| Result | Meaning | Engine action |
|---|---|---|
| `FOUND` | exactly one post with this text, created since the attempt began | recorded as **PUBLISHED**, `confirmedByProvider = true`, `reconciledFound = true`, platform id and URL stored; the calendar entry becomes published; no second post is ever created |
| `NOT_FOUND` | the listing shows nothing | unchanged; a note says a listing can lag and a person must look. Retry still needs `confirmNotPublished` |
| `AMBIGUOUS` | more than one post matches | unchanged; the note lists the candidate links; a person decides |
| `UNAVAILABLE` | the platform or the granted permissions allow no lookup, or the lookup failed | unchanged; the reason is stored. **A failed lookup is never treated as "not found"** |

Sources: Facebook `published_posts`; Instagram `/{ig}/media`; TikTok `status/fetch` by publish id, then `video/list` (needs `video.list`); YouTube uploads playlist (1 quota unit); LinkedIn `GET /rest/posts?q=author` (needs a restricted read permission, otherwise UNAVAILABLE). Matching uses the exact composed text and the time window since the attempt began.

Triggers: `POST /api/v1/social/publications/:id/reconcile` (permission `publication.schedule`), the dashboard's **Check the platform** button, and the social worker (at most 3 attempts, 15 minutes apart, only while the result is NOT_FOUND/UNAVAILABLE). Fields: `reconcileResult`, `reconcileNote`, `reconcileAttempts`, `reconciledAt`, `reconciledFound`. Audit events: `social.reconciled_found`, `social.reconciled_uncertain`.
