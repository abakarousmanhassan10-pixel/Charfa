# Database

PostgreSQL 16 accessed only through Prisma ORM (parameterised queries; no string-built SQL).
Schema: `packages/database/prisma/schema.prisma` · Migrations: `packages/database/prisma/migrations/`.

## Conventions
| Rule | Detail |
|---|---|
| IDs | `cuid()` strings, so they can't be guessed or enumerated |
| Time | `timestamptz(3)`, always UTC. The IANA zone used for planning is stored next to schedules (`Business.timezone`, `CalendarEvent.timezone`, `Publication.timezone`) |
| Money | `Decimal(12,2)` + ISO-4217 `currency`. Never floats |
| Tenancy | Every tenant-owned row has `businessId` (FK, indexed, `onDelete: Cascade`). Uniqueness is scoped per tenant, e.g. `@@unique([businessId, sku])` |
| Soft delete | `deletedAt` on user-facing entities (User, Business, Product, Service, Content, MediaAsset, SocialAccount, CalendarEvent, KnowledgeEntry). Queries filter `deletedAt: null` |
| Secrets | Only ciphertext (`*Enc`, AES-256-GCM) or hashes (`passwordHash`, `refreshTokenHash`, `inviteTokenHash`) |
| Unknown ≠ zero | Nullable metrics/stock (`AnalyticsSnapshot.*`, `Product.stockQuantity`). Null means "not available", never 0 |

## Model map
```
User ─┬─< Session                      (refresh-token sessions, hashed, rotation chain)
      ├─< Membership >─ Business       (role OWNER|ADMIN|EDITOR|VIEWER, status INVITED|ACTIVE|REVOKED)
      ├─< Notification, AuditLog, AIUsage
Business ─┬─< Product, Service, KnowledgeEntry
          ├─< SocialAccount ─< Publication, Comment, Conversation, AnalyticsSnapshot
          ├─< Content ─< ContentMedia >─ MediaAsset
          │          ├─< CalendarEvent ─< Publication
          │          └─< Publication ─< Comment, AnalyticsSnapshot
          ├─< Conversation ─< Message
          ├── Subscription >─ Plan ; Subscription ─< Payment
          └─< AuditLog, AIUsage, Notification
WebhookEvent (global, unique per provider + externalEventId)
```

| Model | Purpose | Key constraints |
|---|---|---|
| User | Account, platform role (`USER`/`SUPPORT`/`SUPER_ADMIN`), lockout counters | `email` unique |
| Session | Refresh-token session | `refreshTokenHash` unique, `familyId` index, `replacedById` rotation chain |
| Business | Tenant | `slug` unique (random suffix) |
| Membership | User ↔ Business with role | `@@unique([userId, businessId])` |
| Product | Catalog item: price & discountPrice (Decimal), currency, SKU, stock (null = not tracked), availability, features, benefits, target audience | `@@unique([businessId, sku])`; SKU released (null) on soft delete |
| Service | Catalog service: price, duration, availability + notes, booking info/URL | per-tenant indexes |
| Category | Product or service category (`kind`), industry defaults (`isDefault`) or custom | `@@unique([businessId, kind, slug])`; delete → items become uncategorised (`SetNull`) |
| ProductMedia | Ordered product images/videos | PK `(productId, mediaId)` |
| KnowledgeEntry | Business knowledge by `category` (company, product, service, pricing, delivery/return policy, FAQ, support) | `verified` + `verifiedAt/verifiedById`; any edit resets verification |
| SocialAccount | Connected platform account (Phase 6) | `@@unique([businessId, platform, externalAccountId])`; tokens encrypted |
| MediaAsset | Uploaded image/video: server-generated `storageKey` (`businesses/{id}/media/...`), sniffed MIME, size, dimensions, SHA-256, folder, tags, alt text | `storageKey` unique; soft delete |
| Content / ContentMedia | Content items and ordered media (Phase 3+) | |
| CalendarEvent | Planned slot | `(businessId, scheduledAt)` index |
| Publication | One publish of content to one account | `idempotencyKey` unique, `(socialAccountId, externalPostId)` unique, `lockedUntil` lease |
| Conversation / Message / Comment | Unified inbox (Phase 8) | external ids unique per account/thread |
| Plan / Subscription / Payment | Billing (Phase 10) | one subscription per business; provider ids unique; no card data |
| AnalyticsSnapshot | Metrics per period | `source` MEASURED vs ESTIMATED; unique per account/publication/period |
| AIGeneration | One AI request and its background job: status `QUEUED` / `RUNNING` / `SUCCEEDED` / `FAILED` / `BLOCKED`, `jobAttempts`, `queuedAt` / `startedAt` / `completedAt`, pipeline `steps`, grounding `quality` report, `rootId` (the job an analysis belongs to). Also: task, params, user instructions, validated output, human-edited output, error, provider/model/prompt version, context hash, injection flags, tokens, cost, latency, attempts, regeneration parent, saved draft (`contentId`) | per-tenant indexes; reuse lookup `(businessId, task, itemId, contextHash)` |
| AIUsage | One row per provider call (initial / provider-retry / repair) with input/output tokens, the model that served it, cost (from that model's price), latency, success | linked to `AIGeneration` |
| AIUsagePeriod | Monthly (UTC) AI counters per business: `reservedGenerations`, `completedGenerations`, `failedGenerations`, `releasedGenerations` (cumulative), `reservedTokens`, `usedTokens`. The limit is enforced by a conditional `UPDATE` on this row | `@@unique([businessId, periodStart])`; backfilled from history by the migration |
| AIReservation | Quota held for one generation job: `units`, `tokens`, status `RESERVED` → `COMMITTED` / `RELEASED`, `consumedUnits`, `consumedTokens`, `outcome` | `generationId` unique; settled exactly once |
| Notification, AuditLog, WebhookEvent | Platform | audit is append-only; webhooks idempotent |
| AuthToken | Email-verification (24 h) and password-reset (30 min) tokens: SHA-256 hash only, single use (`usedAt`), bound to the email at issue time | `tokenHash` unique; older unused tokens of the same type are invalidated on re-issue; purged by the worker |
| Invitation | Email invitation to a business with a role: hashed token, 7-day expiry, `acceptedAt/acceptedById`, `revokedAt`, resend counters | `tokenHash` unique; accepted only by a signed-in user with the same email |
| StorageDeletion | Durable queue of object deletions (`storageKey`, attempts, `lastError`, `nextAttemptAt`, `completedAt`) | retried by the worker with exponential backoff (1 min doubling, max 6 h, 20 attempts) |

`Content.approvedVersion` records the version a person approved (AI content is publishable only when it equals `version`).

`MediaAsset` also stores `thumbnailKey`/`thumbnailSizeBytes`, `originalSizeBytes` (before re-encoding) and the malware scan result (`scanStatus`, `scanEngine`, `scannedAt`). `Business.storageQuotaBytes` overrides the default `MEDIA_STORAGE_QUOTA_MB`.

## Tenant isolation at the data layer
1. The API's `BusinessAccessGuard` turns `:businessId` into a verified `TenantContext` (ACTIVE membership in a non-deleted business).
2. Services read `businessId` **only** from that context and include it in every `where`. Child resources are loaded with `{ id, businessId }`, so an id from another tenant is 404.
3. `tests: apps/api/test/businesses.e2e-spec.ts` checks this against a real database, including cross-tenant membership ids.
4. Planned hardening: PostgreSQL row-level security (`SET app.business_id`) as a second layer once the module count grows.

## Migrations
```bash
pnpm db:migrate              # dev: create + apply a migration from schema changes (prisma migrate dev)
pnpm db:deploy               # CI/prod: apply pending migrations only (prisma migrate deploy)
pnpm db:seed                 # idempotent: the 3 plans; never demo data
```
- Never edit an applied migration; add a new one.
- Use expand → migrate → contract for breaking changes, so the running API keeps working during a deploy.
- CI fails if the schema and migrations drift (`prisma migrate diff --exit-code`).

Applied so far:
| Migration | Content |
|---|---|
| `20261110171718_init` | Full initial schema |
| `20261110190749_phase3_ai_engine` | `AIGeneration`, enums `AITask` / `AIGenerationStatus`, `AIUsage.generationId` + `attemptKind` (additive) |
| `20261110181312_phase2_catalog_media_knowledge` | Business city/address/contact; product discount, availability, target audience, `categoryId`; service booking & availability; `Category`, `ProductMedia`; media folder/tags/originalFilename; knowledge category & verification audit |

Notes on the Phase 2 migration: it drops the unused free-text `Product.category` / `Service.category` and `MediaAsset.productId` columns (replaced by `Category` and `ProductMedia`), and adds `MediaAsset.originalFilename NOT NULL` without a default. No earlier release could create media rows, so no environment holds data in these columns. If you ever backport this to a database that has media rows, backfill `originalFilename` first.

## Local databases
| DB | Use |
|---|---|
| `touma` | development |
| `touma_test` | API integration + Playwright tests (recreated by migrations) |

## Backups
Managed PostgreSQL with point-in-time recovery (7–30 days) plus daily snapshots in another region. Run restore drills each quarter. Redis holds only rebuildable state.

## Creative Studio models (Phase 4, migration `20261111084926_creative_studio`)
| Model | Purpose |
|---|---|
| BrandKit | One per business: colors (role + hex), fonts, visual style, tone, guidelines (logo = `Business.logoMediaId`) |
| CreativeGeneration | One image/video request and its job: kind, status, provider/model, prompt, params, `idempotencyKey` + `requestHash` (unique per business), provider ref/status, reserved/produced units, `settledAt`, cost, processing time, brand snapshot |
| CreativeOutput | One produced file: media asset, size, preservation (`EXACT`/`GUIDED`/`NONE`), `upscaled`, `selected` (favorite) |
| AIUsagePeriod (extended) | Adds reserved/completed image and video-second counters; `AITask` gains `STORYBOARD` |
