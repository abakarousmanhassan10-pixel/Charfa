# TOUMA AI: Phase 2 final hardening report

Date: 2026-11-11 · Branch: `ccr-ce5eb3d1-r4he6g`

This pass hardened what Phase 2 already had: no feature was rebuilt and nothing from Phase 3 was added. Each section separates what was **verified** (it ran here against the real component) from what is **implemented but not verified**.

## Summary

| Area | Status |
|---|---|
| Task 1: Real S3 storage (AWS S3 / R2 / MinIO) | **Verified against real MinIO**: `storage:check` passed (6/6 steps) and `test:real-storage` passed (5/5). AWS S3 and R2 use the same code path but have not been run against real accounts. |
| Task 2: Media processing | Verified (real sharp/libvips, real ClamAV 1.5.4, real PostgreSQL). Video processing is not implemented. |
| Task 3: Email verification, password reset, invitations | Verified end to end over real SMTP (local capture server), in the API and in the browser. No external email provider configured. |
| Task 4: Redis rate limiting, ESLint, Docker, prod validation, health | Verified. Docker images were built on a substitute base image (Debian mirrors are unreachable here). |
| Task 5: Security audit | Verified by automated tests (see table). |
| Task 6: Full test run | All green, including the real-storage suite against MinIO. |

## Task 1: Real object storage (verified against MinIO)

On user authorization, local MinIO was started with Docker Compose from the Bitnami image (`bitnamilegacy/minio:2025.4.22`, server `RELEASE.2025-04-22T22-12-26Z`), using `docker-compose.yml` plus `docker-compose.minio-bitnami.yml`.
- Credentials were development-only and generated randomly for this run. They were kept in a mode-600 file in the session scratchpad, never committed or printed.
- The API used `STORAGE_DRIVER=s3`, `S3_PROVIDER=minio`, `S3_ENDPOINT=http://127.0.0.1:9000`, bucket `touma-media-dev`.
- No mocked storage was involved.

**`pnpm --filter @touma/api storage:check`: exit 0, `ok: true`**

| Step | Result |
|---|---|
| upload | ok (41 ms) |
| head (size, type) | ok (4 ms) |
| download (bytes compared) | ok (6 ms) |
| presigned-download over HTTP (and an unsigned URL is refused) | ok (26 ms) |
| delete | ok (8 ms) |
| deleted-check | ok (2 ms) |

**`pnpm --filter @touma/api test:real-storage`: 5 passed, 0 failed**

| Test | What it proves |
|---|---|
| readiness reports storage as verified only after a real round trip | `/health/ready` → `dependencies.storage.state = verified`, all six steps ok |
| upload → signed download → thumbnail → delete | upload through the API, signed download (full and `Range` 206), WebP thumbnail variant, delete → signed URL 404, no pending deletions |
| objects really live in the bucket, under the tenant prefix, and are private | separate S3 client sees the object at `businesses/{businessId}/media/…` (thumbnail under `…/thumbs/`) with identical bytes; anonymous direct bucket request is refused; responses never contain the storage key, bucket name or credentials; after delete both objects are gone from the bucket |
| tenant isolation and role permissions hold for real stored files | business B gets 404 for A's media (read, edit, delete, list, claiming A's `X-Business-Id`, uploading into A); B's signature does not open A's file; A's object is untouched in the bucket; a VIEWER can read and download but gets 403 for upload and delete; unauthenticated → 401 / 404 |
| storage errors are typed | wrong secret → `access_denied`; non-existent bucket (no auto-create) → `bucket_missing`; missing object → `not_found` |

After the run the bucket was empty, so every test object was deleted. **Storage status: configured and verified for MinIO.**

**AWS S3 / Cloudflare R2 compatibility** is kept: the same `S3ObjectStorage` covers all three, with presets (`aws`: virtual-hosted style, no endpoint; `r2`: region `auto`, account endpoint; `minio`: path style), and unit tests cover the presets. **They have not been run against real AWS or R2 accounts.** Before a production launch, run `storage:check` and `test:real-storage` with the production provider's variables; production config validation also refuses `S3_AUTO_CREATE_BUCKET`.

CI job `real-storage` builds the same MinIO release from source and runs both commands. It has not been executed on GitHub yet.

## Task 2: Media processing (verified)

| Control | Implementation | Evidence |
|---|---|---|
| Re-encoding | sharp decodes and re-encodes every image in its own format (JPEG mozjpeg q86, PNG level 9, WebP q86, GIF animated); orientation applied | `hardening.e2e`: EXIF/GPS test, polyglot test; `catalog.e2e`: stored bytes match DB checksum and PNG magic |
| EXIF removal | Metadata dropped by re-encoding, GPS included | JPEG with `withExif` GPS data → stored file has no EXIF |
| Thumbnails | 480 px WebP, separate signed variant `?variant=thumb` (variant is part of the HMAC) | thumbnail served as `image/webp`; Playwright product grid |
| File type validation | Magic-byte sniffing, declared type must match (unchanged from Phase 2), then a full decode | polyglot and corrupt-image tests |
| File size limits | Per-type limits (unchanged) + decoded pixel limit `MEDIA_MAX_IMAGE_PIXELS` (decompression bombs) + 20 000 px edge limit | 3000×3000 bomb → 422 `IMAGE_DIMENSIONS` |
| Malware scanning | clamd INSTREAM client; infected → 422 `MALWARE_DETECTED` (audited with signature); scanner down → 503 `SCAN_UNAVAILABLE` | `clamav.e2e` against **real clamd 1.5.4** with EICAR test signatures (`infrastructure/clamav`) |
| Per-business quotas | Default `MEDIA_STORAGE_QUOTA_MB`, override `Business.storageQuotaBytes`; checked before upload and after processing; `GET /media/usage`; usage meter in the media page | quota test (other businesses unaffected) |
| Failed deletion cleanup | `StorageDeletion` queue; immediate attempt, then worker job `storage-cleanup` every 10 min, exponential backoff (1 min → 6 h, 20 attempts); upload rollbacks use the same queue | test forces delete failures, then runs the real worker job |

## Task 3: Authentication improvements (verified)

- **Email verification:** sent on registration. The 24 h single-use token is stored as a SHA-256 hash and bound to the address it was sent to. Resend has a 60 s cooldown. `/verify-email` page and an "unverified" banner with a resend button. A verified email is required before inviting people.
- **Password reset:** the response is identical for known and unknown emails. The token lasts 30 min and is single use, and a new request invalidates the previous link. A reset revokes every session, clears lockout, sends a "password changed" email and is audited. Pages: `/forgot-password`, `/reset-password`, plus a "Forgot password?" link on the login page.
- **Secure invitations:** 32-byte random token, hashed, 7-day expiry, single use (atomic claim).
  - Accepting requires a signed-in user whose email matches the invited one; otherwise 403 with an audit entry.
  - The role comes only from the invitation and can't exceed the inviter's role (never OWNER).
  - Limits: max 50 pending, resend max 5 with cooldown and token rotation, revocable.
  - UI: an invitations card in business settings, and `/invitations/accept`, which keeps the token through sign-in/registration via `?next=` and sessionStorage.
- Tokens travel only in the URL fragment (`#token=`), so they never reach server logs or `Referer`. Pages remove them from the address bar after reading.
- Email is sent over SMTP (nodemailer) with EN/FR templates. Dev transport `log`; production requires `smtp` with TLS.
- **Not verified:** delivery through a real email provider (SES, Postmark, …). None is configured.

## Task 4: Infrastructure (verified)

| Item | Result |
|---|---|
| Distributed rate limiting | Redis throttler storage (atomic Lua, `touma:rl:*`). `distributed-throttle.e2e`: two API instances share one counter, and a blocked client stays blocked on both with `Retry-After`. If Redis is unreachable it **fails open** and logs an error (availability over strictness; a documented trade-off). |
| ESLint | Flat config (`eslint.config.mjs`): typescript-eslint, react-hooks, Next.js core-web-vitals, `no-console`, `eqeqeq`, `consistent-type-imports` (off in Nest apps, where DI needs runtime imports). `pnpm lint`: 0 errors, 0 warnings. 12 findings fixed (unused imports, `any`, a regex rewritten with escapes). |
| Docker images | api 848 MB, worker 717 MB, web 2.11 GB, all built. API and worker containers booted against PostgreSQL/Redis: liveness OK, readiness shows DB/Redis up, worker heartbeat written, sharp loads (libvips 8.17.3), production validation rejects insecure config. **Deviation:** built with `--build-arg BASE_IMAGE=` set to a local Ubuntu 24.04 image carrying the same Node 22 binaries, because Debian package mirrors are blocked here. The default `node:22-bookworm-slim` path has not been built in this environment; the CI `docker` job builds it. |
| Production environment validation | `productionProblems()` (prod/staging) refuses to start on: http origins, `COOKIE_SECURE=false`, example or identical secrets, dev DB password, missing S3 credentials, auto-created bucket, no SMTP, localhost sender, unscanned uploads (unless explicitly accepted), in-memory rate limiting, test providers. Unit tests plus a real container start (9 problems listed, exit ≠ 0). |
| Health checks | `/health` (liveness), `/health/ready` (DB + Redis gate; `dependencies`: storage round trip, SMTP verify, clamd PING, worker heartbeat), worker `:4001/health`, Docker `HEALTHCHECK` on all three images. |
| Compose and CI | Compose: MinIO image configurable (`MINIO_IMAGE`), ClamAV and Mailpit services, API/worker wired to them. CI: lint, real clamd, new `real-storage` and `docker` jobs. |

## Task 5: Security audit (automated)

| Threat | Test | Result |
|---|---|---|
| Cross-business file access | `catalog.e2e` tenant isolation (A's token + B's `X-Business-Id`; B's ids in A's scope; cross-tenant media in payloads), `hardening.e2e` invitations across businesses, quota isolation | 404 / 400, pass |
| Unauthorized downloads | Missing, forged, expired, swapped-id and cross-variant signatures; deleted media | 404, pass |
| Token exposure | No response contains tokens, token hashes, password hashes, storage keys or S3 credentials. Access token only in memory; refresh cookie httpOnly (Playwright). Email tokens only in the URL fragment. | pass |
| Malicious uploads | EICAR-in-PNG (real ClamAV), polyglot, decompression bomb, corrupt image, type mismatch, SVG/HTML | rejected, nothing stored, pass |
| Permission escalation | Mass assignment (`platformRole`, `emailVerifiedAt`, `storageQuotaBytes`), invitation role above the inviter's, inviting to OWNER, invitation accepted by another email, members role changes (existing suites) | 400 / 403, pass |
| Data isolation | Every resource type checked across tenants (existing + new suites); AI context limited to one tenant (Phase 3 suite) | pass |

These are automated tests written by the same team that wrote the code. They are not a substitute for an independent penetration test.

## Task 6: Final test run

| Check | Result |
|---|---|
| Unit tests (`pnpm test`) | 154 passed (web 8, config 12, shared 28, ai-engine 53, worker 5, storage 11, api 37) |
| API integration/API tests (`pnpm test:e2e`, real PostgreSQL, Redis, ClamAV, SMTP capture) | 155 passed; the 5 real-storage tests are opt-in and run separately (below) |
| Browser tests (Playwright, Chromium) | 22 passed (3 new: verification, reset, invitation) |
| Typecheck | 14/14 tasks pass |
| Lint | 0 errors, 0 warnings |
| Production build | 9/9 tasks pass |
| Docker build | 3/3 images built (substitute base image, see above) |
| Migration drift | `prisma migrate diff`: no difference |
| Real storage, MinIO (`storage:check`) | exit 0, 6/6 steps ok |
| Real storage, MinIO (`test:real-storage`) | 5 passed |

## Remaining issues (honest list)

1. Real storage is verified on MinIO only. **AWS S3 and Cloudflare R2 have not been tested with real accounts**: run `storage:check` and `test:real-storage` with the production provider before launch. The local MinIO image (`bitnamilegacy/minio`) is an archived, no-longer-updated build: fine for development, not for production.
2. **Videos** are validated, scanned, size-limited and stored as uploaded. Metadata is not stripped, and there is no transcoding or poster frame (ffmpeg is not in the stack yet).
3. Image processing runs inside the upload request (sharp, bounded by the pixel limit). Under heavy load it should move to the worker.
4. Rate limiting fails open when Redis is down (deliberate; auth lockout in PostgreSQL still applies).
5. The web Docker image is 2.11 GB because it keeps the whole workspace (`next.config.ts` needs TypeScript at start-up). Moving to Next.js `output: 'standalone'` would shrink it a lot.
6. The default Debian-based Docker build and every new CI job (`real-storage`, `docker`, clamd install) have not run yet.
7. No external SMTP provider is configured; delivery, SPF/DKIM and bounce handling are untested.
8. Expired-but-unaccepted invitations stay in the table (harmless, filtered out); the worker purges used and expired auth tokens but not invitations.
9. Quotas are per business. Per-plan quotas come with billing (Phase 10).
10. ClamAV tests use EICAR test signatures only. Production clamd needs `freshclam` updates (the compose ClamAV image does this).
11. During Playwright runs, the specs without a mail capture server log `ECONNREFUSED` for the registration email. This is expected noise: sending is non-fatal.
12. No independent penetration test has been performed.

## Files of note

`packages/storage/*`, `apps/api/src/media/{image-processor,malware-scanner,media.service}.ts`, `apps/api/src/storage/{deletion-queue,signed-url,storage.module}.ts`, `apps/api/src/email/*`, `apps/api/src/auth/{account.service,auth-tokens.service}.ts`, `apps/api/src/invitations/*`, `apps/api/src/common/throttle/redis-throttler.storage.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/scripts/storage-check.ts`, `apps/worker/src/jobs/storage-cleanup.ts`, `packages/config/src/env.ts`, `apps/web/app/(auth)/{forgot-password,reset-password,verify-email,invitations/accept}`, `apps/web/components/{email-verification-banner,business/invitations-card}.tsx`, `eslint.config.mjs`, `infrastructure/docker/*`, `infrastructure/clamav/*`, migrations `20261111064135_*` and `20261111064158_*`.
