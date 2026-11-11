# TOUMA Creative Studio (Phase 4)

AI images, videos, storyboards and a brand kit, built on the TOUMA AI orchestration (Phase 3) and the existing media library.

> **Honesty rule.** TOUMA never fabricates generated media. If no provider is configured, the endpoint answers `503 IMAGE_NOT_CONFIGURED` / `VIDEO_NOT_CONFIGURED` and the UI says so. The `fake` providers exist only for automated tests and are refused unless `APP_ENV=test`. **The OpenAI image and video adapters have been tested only against stubbed HTTP responses, never against the real services** (no API key was available). Treat the first real generation as a verification step (see "Verifying a provider").

## Provider configuration

| Variable | Default | Meaning |
|---|---|---|
| `IMAGE_PROVIDER` | `openai` | `openai`, `none`, or `fake` (tests only). `openai` also needs `OPENAI_API_KEY` |
| `IMAGE_MODEL` | `gpt-image-1` | Model used for `/images/generations` and `/images/edits` |
| `VIDEO_PROVIDER` | `none` | `none` (no video, nothing faked), `openai`, or `fake` (tests only) |
| `VIDEO_MODEL` | `sora-2` | Model used for `/videos` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | – | Shared with TOUMA AI. Server-side only, never sent to the browser or logged |
| `CREATIVE_PROVIDER_TIMEOUT_MS` | `180000` | Per provider HTTP call |
| `CREATIVE_MONTHLY_IMAGES_PER_BUSINESS` | `100` | Monthly image limit when the plan sets none (plan: `aiImagesPerMonth`) |
| `CREATIVE_MONTHLY_VIDEO_SECONDS_PER_BUSINESS` | `120` | Monthly video-seconds limit (plan: `aiVideoSecondsPerMonth`) |
| `CREATIVE_RATE_LIMIT_PER_MINUTE` | `10` | Per user, on generation routes |
| `CREATIVE_WORKER_CONCURRENCY`, `CREATIVE_JOB_ATTEMPTS`, `CREATIVE_JOB_BACKOFF_MS` | 2 / 3 / 5000 | BullMQ queue `touma.creative` |
| `CREATIVE_VIDEO_POLL_MS`, `CREATIVE_VIDEO_TIMEOUT_MINUTES` | 5000 / 15 | Video status polling and give-up time |
| `CREATIVE_MODEL_PRICING` | – | JSON price list (`perImageUsd`, `perSecondUsd`) for cost estimates. Without it cost is recorded as unknown, not zero |

Steps (OpenAI):
1. Store `OPENAI_API_KEY` in your secret manager and inject it as an environment variable. Never commit it.
2. Set `IMAGE_PROVIDER=openai` (default). To enable video, set `VIDEO_PROVIDER=openai` only if your OpenAI account has video access.
3. Set `CREATIVE_MODEL_PRICING` from your provider's current price list.
4. Run the worker: `node dist/ai-worker.js` (same image as the API; it consumes both `touma.ai` and `touma.creative`). `AI_WORKER_INLINE=true` runs it inside the API for development.
5. `GET /api/v1/creative/status` (or the Creative Studio overview) reports which providers are configured, their capabilities, storage readiness and the worker heartbeat.

Another provider = another class implementing `ImageProvider` / `VideoProvider` from `@touma/creative` and a case in `apps/api/src/creative/creative-providers.ts`. Nothing else changes.

### Verifying a provider
Before announcing the feature: generate one image (with and without a product photo) and one short video with the real key, check them, and check `GET /creative/generations/:id` for status, tokens/cost and processing time. Until you have done so, treat the adapters as unverified.

## How it works

**Images** (`POST /creative/images`, 202 + job): validate → optional brand kit snapshot → reserve quota (atomic) → BullMQ job → provider → ingest through the media pipeline (sniff, malware scan fail-closed, sharp re-encode, thumbnail, quota, tenant-prefixed key, `origin=AI_GENERATED`) → settle quota exactly once.

**Product fidelity.** With a source photo:
- `EXACT` (default): the product is cut out of a photo on a plain or transparent background; the model generates only an *empty scene* (it never sees the photo); TOUMA composites the real product pixels onto it. The product cannot be altered by the model. If the cutout fails: `422 PRODUCT_CUTOUT_FAILED`.
- `GUIDED`: the model edits the photo with "keep the product exactly as it is". Best effort, flagged `GUIDED` and warned in the UI.
- No photo: an illustration, flagged `NONE`, never presented as the real product.

Overlay text and the logo are drawn by TOUMA, not the model, so spelling is exact. Overlay text containing prices, phone numbers, URLs or emails must match verified business data (`422 OVERLAY_UNVERIFIED`).

**Videos** (`POST /creative/videos`): a resumable state machine: submit once (`SUBMITTING` → provider ref saved), poll with delayed BullMQ jobs, ingest on completion. A retry never resubmits; if a submit result is unknown the job fails with `VIDEO_SUBMIT_UNKNOWN` rather than risk double billing. Quota is in video seconds.

**Storyboards** (`POST /creative/storyboards`): the existing AI pipeline (task `STORYBOARD`, agent `storyboardCreator`), grounded in verified business facts, with timing validation. A storyboard can drive a video.

**Brand kit** (`GET/PUT /creative/brand-kit`): colors with roles, heading/body fonts, visual style, tone, guidelines. The logo is `Business.logoMediaId`. The kit is applied to image and video prompts, storyboards and AI content generation.

**Idempotency.** Send `Idempotency-Key` on `POST images|videos`. Same key + same body returns the original job; same key + different body is `409 IDEMPOTENCY_KEY_REUSED`.

**Usage and limits.** Images and video seconds are reserved with one conditional SQL update on `AIUsagePeriod`; failures release the reservation, successes commit what was actually produced. Every provider call is recorded in `AIUsage` (`attemptKind: creative`, units, cost estimate).

**Cleanup.** A failed generation deletes every file it already stored and releases its quota. Deleting a generation soft-deletes its media and queues the object deletions durably.

## API (`/api/v1/creative`)

| Route | Permission | Notes |
|---|---|---|
| `GET status` | `content.read` | Providers, capabilities, limits, usage, storage, worker |
| `GET brand-kit` / `PUT brand-kit` | `content.read` / `business.update` | |
| `POST storyboards` (202) / `GET storyboards` | `ai.use` / `content.read` | |
| `POST images` (202), `POST videos` (202) | `ai.use` | `Idempotency-Key`; 503 `*_NOT_CONFIGURED`, 429 `*_LIMIT_REACHED` |
| `GET generations`, `GET generations/:id`, `GET generations/:id/status` | `content.read` | Filter by kind/status |
| `POST generations/:id/variations` | `ai.use` | Reuses the stored parameters |
| `DELETE generations/:id` | `media.write` | |
| `PATCH outputs/:id` `{selected}` | `content.write` | Favorite |

Downloads use the signed media URL with `?download=1` (attachment) and `?variant=thumb`.

## Web pages
`/dashboard/creative` (overview), `/images`, `/videos`, `/storyboards`, `/brand-kit`, `/history`. English and French.

## Operations notes
- Overlay text needs system fonts on the worker. The API image installs `fontconfig`, `fonts-dejavu-core`, `fonts-liberation`. Brand fonts that are not installed fall back to a default font.
- Video clips are limited to the provider's maximum length; TOUMA does not stitch clips (no ffmpeg). A longer storyboard can be generated scene by scene.
- Video thumbnails come from the provider's poster only.
- `HD` may be an upscale of the provider's native size; the output is flagged `upscaled`.
