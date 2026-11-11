# Architecture

## Overview

```
 Browser ──► Next.js (Vercel) ──rewrite /api/v1/*──► NestJS API ──► PostgreSQL (Prisma)
                                                        │   └────► Redis (rate limits, BullMQ)
                                                        ▼
                                                    BullMQ queues ◄── Worker (publishing, sync, maintenance)
                                                                         ├─► Social APIs (official only)
                                                                         ├─► AI providers (OpenAI, image/video)
                                                                         └─► S3-compatible storage
```

- **Same-origin API.** The web app proxies `/api/v1/*` to the API, so the refresh cookie can be `SameSite=Strict` and no API host or secret is ever compiled into client bundles.
- **Stateless API, stateful worker.** API replicas scale horizontally. Long-running or retryable work (publishing, analytics sync, token refresh, AI media generation) goes through BullMQ, never inside a request.
- **Modules.** Each API module owns its controller (HTTP + DTO validation), service (business rules), data access through Prisma, and tests. Modules talk through services, never by reaching into each other's tables.

## Multi-tenancy

- Tenancy unit: `Business`. A `User` belongs to many businesses through `Membership(role, status)`.
- Roles: `OWNER > ADMIN > EDITOR > VIEWER`. The permission matrix lives in `packages/shared/src/rbac.ts` and is the single source of truth.
- **Enforcement (implemented):** a `BusinessAccessGuard` resolves `businessId` from the route (`/businesses/:businessId/...`), loads the caller's ACTIVE membership, checks the required `@RequirePermission(...)`, and puts a `TenantContext` on the request. Services take `businessId` **only** from that context, and every query filters on it. A `businessId` from the client is never trusted until membership is verified. Cross-tenant ids return 404, not 403, so nothing leaks about which ids exist. Child resources (e.g. memberships) are always loaded with `{ id, businessId }`.
- Platform roles (`SUPPORT`, `SUPER_ADMIN`) give **no** implicit tenant access. Platform operations live under `/api/v1/admin` behind `@RequirePlatformRole`, and the role is re-read from the database on every request.
- Role hierarchy rules: only higher ranks manage lower ones (OWNER can manage anyone), nobody changes their own role, and the last OWNER can't be removed or demoted.
- Every tenant table carries `businessId` with an index; uniqueness is scoped per business (e.g. `@@unique([businessId, sku])`).

## Authentication

- Passwords: argon2id (m=19 MiB, t=2, p=1). Accounts lock after 5 failures (15 min). Unknown-email logins do the same amount of work, so timing doesn't reveal which emails exist.
- Access token: HS256 JWT, 15 min, with `iss`/`aud`, held **in memory** by the browser.
- Refresh token: 384-bit random, stored as a SHA-256 hash in `Session`, sent as an `httpOnly; SameSite=Strict; Path=/api/v1/auth` cookie. It rotates on every refresh. Reusing a rotated token revokes the whole session family (theft detection). Within a 10 s grace window, a just-rotated token re-issues a fresh pair in the same family instead. This covers concurrent tabs and responses the browser dropped mid-navigation, and it never applies once the family has been logged out.
- Each request checks that the session is still active, so logout, logout-all and suspension take effect immediately.

## Data model

See `packages/database/prisma/schema.prisma`. Key decisions:
- UTC `timestamptz(3)` everywhere. `Business.timezone` and `CalendarEvent/Publication.timezone` keep the IANA zone used for planning, so DST is handled correctly.
- Money uses `Decimal(12,2)` plus an ISO-4217 currency. No card data, only payment-provider references.
- `Publication.idempotencyKey` is unique, `(socialAccountId, externalPostId)` is unique, `externalPostId` is set only from a provider response, and `lockedUntil` gives worker leasing. Together these prevent double publishing.
- Analytics metrics are nullable (null = not available from the provider, never zero-filled), and `MetricSource` separates MEASURED from ESTIMATED.
- `KnowledgeEntry.verified` gates what the AI may state as fact.
- `WebhookEvent(provider, externalEventId)` is unique, which makes webhook processing idempotent.
- Soft delete (`deletedAt`) on user-facing entities. Audit logs are append-only and redacted.

## Internationalisation

Locales live in `packages/shared/src/i18n.ts`. The web app loads message catalogs per locale and sets `<html lang dir>`. Layouts use logical CSS properties (`ms-*`, `border-e`, `rtl:` variants), so Arabic RTL works once its catalog is added. A test makes sure every catalog has exactly the same keys.

## API surface (Phase 1)
| Route | Auth |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | public (refresh/logout need the CSRF header) |
| `POST /auth/logout-all`, `GET /auth/me`, `GET/PATCH /users/me` | bearer |
| `POST /businesses`, `GET /businesses` | bearer |
| `GET/PATCH/DELETE /businesses/:businessId` | `business.read` / `business.update` / `business.delete` |
| `GET /businesses/:businessId/dashboard` | `business.read` |
| `GET /businesses/:businessId/members`, `PATCH/DELETE …/members/:membershipId` | `members.read` / `members.manage` (anyone may leave) |
| `GET /admin/overview` | platform `SUPER_ADMIN` or `SUPPORT` |
| `GET/POST /products`, `GET/PATCH/DELETE /products/:id`, `PUT /products/:id/media` | `catalog.read` / `catalog.write` + `X-Business-Id` |
| `GET/POST /services`, `GET/PATCH/DELETE /services/:id` | `catalog.read` / `catalog.write` + `X-Business-Id` |
| `GET/POST /product-categories`, `PATCH/DELETE …/:id`, `POST …/restore-defaults` (same for `/service-categories`) | `catalog.read` / `catalog.write` + `X-Business-Id` |
| `POST /media` (multipart), `GET /media`, `GET /media/folders`, `GET/PATCH/DELETE /media/:id` | `media.read` / `media.write` + `X-Business-Id` |
| `GET /media/usage` | `media.read` + `X-Business-Id` (used bytes, quota, file count) |
| `GET /media/:id/content?exp&sig[&variant=thumb]` | public, HMAC-signed expiring URL (the variant is part of the signature) |
| `POST /auth/email/verify`, `POST /auth/email/resend` (auth), `POST /auth/password/forgot`, `POST /auth/password/reset` | public / authenticated; auth throttle |
| `GET/POST /businesses/:businessId/invitations`, `POST …/:id/resend`, `DELETE …/:id` | `members.manage` |
| `POST /invitations/lookup` (public), `POST /invitations/accept` (authenticated, same email) | token in the body only |
| `GET/POST /business-knowledge`, `GET /business-knowledge/summary`, `GET /business-knowledge/context`, `GET/PATCH/DELETE …/:id`, `POST …/:id/verify|unverify` | `knowledge.read` / `knowledge.write` / `knowledge.verify` + `X-Business-Id` |
| `POST /ai/business-analysis|product-analysis|marketing-strategy|content`, `POST /ai/generations/:id/regenerate` | `ai.use`: **202**, queued for the AI worker |
| `GET /ai/generations/:id/status`, `GET /ai/generations[/:id]`, `GET /ai/usage`, `GET /ai/usage/monthly` | `content.read` |
| `POST /ai/generations/:id/draft|submit-review`, `POST …/approve|reject` | `content.write` / `content.approve` |
| `GET /health`, `/health/ready` | public |

## Frontend structure
```
app/page.tsx                      Landing
app/(auth)/login, register        Auth pages (both honour a same-origin ?next=)
app/(auth)/forgot-password, reset-password, verify-email, invitations/accept
                                  Email-link pages; tokens read from the URL fragment, then removed from the address bar
app/(app)/layout.tsx              Protected shell: auth gate, onboarding redirect, sidebar + mobile drawer, business switcher
app/(app)/onboarding              Create first/additional business
app/(app)/dashboard               Welcome, business info, connected accounts, content overview, upcoming publications, user settings
app/(app)/settings/business       Business profile (read-only for VIEWER/EDITOR), members, danger zone
app/(app)/settings/profile        Name, language, timezone, sign out everywhere
components/business-provider.tsx  Loaded businesses + active business (selection kept in localStorage as a convenience only)
```

## Tenant selection on flat routes
Phase 2 resources use flat paths (`/products`, `/media`, …). The tenant is named by the `X-Business-Id` header, which `BusinessAccessGuard` treats as a claim: the same ACTIVE-membership + permission check as for `/businesses/:businessId` runs on every request, a missing or repeated header is a 404, and every service query is scoped by the verified `TenantContext`. Ids of other tenants' records (products, categories, media, knowledge) are 404, and cross-tenant references inside payloads (`categoryId`, `logoMediaId`, product `mediaIds`) are 400.

## Media pipeline
```
Browser ──multipart──► /api/v1/media (same-origin proxy)
   API: quota pre-check → stream to private temp file (hard size cap) → sniff magic bytes → declared type must equal sniffed type
        → per-type size limit → clamd INSTREAM scan (fail closed) → images: sharp decode with pixel limit, auto-rotate,
          re-encode in the same format without metadata + 480 px WebP thumbnail → quota check on final sizes
        → SHA-256 → put original + thumbnail to S3 under businesses/{businessId}/media/{random}.{ext} and …/media/thumbs/
        → MediaAsset row (READY, scanStatus) → temp file removed; any failure rolls back through the deletion queue
Browser ◄── signed URL /api/v1/media/:id/content?exp&sig ◄── API streams from private bucket (Range supported)
```
- The bucket is never public and storage credentials stay server-side. URLs are HMAC-SHA256 signatures (key derived with HKDF from `TOKEN_ENCRYPTION_KEY`) that expire after 1–2 × `MEDIA_URL_TTL_SECONDS`.
- Served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and the stored (sniffed) Content-Type.
- `ObjectStorage` interface: `S3ObjectStorage` (AWS S3, R2, MinIO) in every real environment, and `MemoryObjectStorage` only for automated tests (`STORAGE_DRIVER=memory`, which the env loader refuses unless `APP_ENV=test`).
- Without S3 credentials, media endpoints answer `503 STORAGE_NOT_CONFIGURED`; nothing is simulated.
- `packages/storage` holds the storage abstraction shared by the API and the worker, typed `StorageError`s (`not_found`, `access_denied`, `bucket_missing`, `unavailable`, `invalid_config`) and `verifyStorage()` (the real round trip used by `storage:check` and readiness).
- Deleting media soft-deletes the row and queues the original and thumbnail in `StorageDeletion`; the worker's `storage-cleanup` job (every 10 min) retries failures with backoff.
- Video files are validated, scanned and stored as uploaded: no transcoding or metadata stripping yet (no ffmpeg).

## AI knowledge boundary
`KnowledgeService.buildAgentContext(tenant)` is the only way Phase 3 agents will get business facts. It takes a verified `TenantContext`, returns only VERIFIED knowledge plus ACTIVE products and services of that business, keeps unknowns explicit (`price: null`, `stock: "not tracked"`), and lists `missingInformation` so agents answer "I don't know" instead of inventing. `GET /business-knowledge/context` shows the business exactly what the AI will see.

## AI generation (background)
`POST /ai/*` reserves monthly quota atomically, stores a `QUEUED` generation and enqueues a BullMQ job (`touma.ai`, job id = generation id); a worker process (`node dist/ai-worker.js`, or inline with `AI_WORKER_INLINE=true`) runs the pipeline, retries transient failures with backoff, and settles the reservation. Clients poll `GET /ai/generations/:id/status`. Details: `docs/AI.md`.

## AI engine
`packages/ai-engine` is provider-neutral and framework-free: agents (prompt + schema + validation), the runner (retries, repairs, accounting), the OpenAI provider and a test-only fake provider. `apps/api/src/ai` hosts the orchestrator, usage limits and reports, history and drafts. The full design is in `docs/AI.md`.

## Creative Studio (Phase 4)
`@touma/creative` holds provider-neutral contracts (`ImageProvider`, `VideoProvider`), the OpenAI adapters, prompt building and image composition (cutout, composite, overlay, logo). `apps/api/src/creative` owns the API, quota, idempotency and the BullMQ worker (`touma.creative`), which runs in the same process as the AI worker (`dist/ai-worker.js`). Generated files are stored through the existing media pipeline. See [CREATIVE.md](CREATIVE.md).
