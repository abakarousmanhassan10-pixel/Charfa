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
| Notification, AuditLog, WebhookEvent, AIUsage | Platform | audit is append-only; webhooks idempotent |

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
| `20261110181312_phase2_catalog_media_knowledge` | Business city/address/contact; product discount, availability, target audience, `categoryId`; service booking & availability; `Category`, `ProductMedia`; media folder/tags/originalFilename; knowledge category & verification audit |

Notes on the Phase 2 migration: it drops the unused free-text `Product.category` / `Service.category` and `MediaAsset.productId` columns (replaced by `Category` and `ProductMedia`), and adds `MediaAsset.originalFilename NOT NULL` without a default. No earlier release could create media rows, so no environment holds data in these columns. If you ever backport this to a database that has media rows, backfill `originalFilename` first.

## Local databases
| DB | Use |
|---|---|
| `touma` | development |
| `touma_test` | API integration + Playwright tests (recreated by migrations) |

## Backups
Managed PostgreSQL with point-in-time recovery (7–30 days) plus daily snapshots in another region. Run restore drills each quarter. Redis holds only rebuildable state.
