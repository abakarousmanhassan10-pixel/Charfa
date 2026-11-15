# Enterprise AI agent marketplace (N24)

Off by default (`MARKETPLACE_ENABLED=false` → `/marketplace/*` answers 404). Everything is fictitious or simulated: no payment, creator payout, bank data, real connection or untrusted package execution exists. Delivered in four verifiable blocks; **only block A is done**.

## Phase 0 – audit (what really exists)
| Component | State |
| --- | --- |
| Agent Builder (N23 slice 1) | **Operational**: `AgentDefinition` drafts, validation, simulator. No versions, activation, templates or workflows (so a package cannot yet be installed as an agent) |
| Tenants, auth, RBAC | **Operational**: businesses, memberships, permissions (`agents.read/manage/run/approve`), platform roles |
| Billing | **Operational with the simulated provider**: plans, subscriptions, entitlements, guardian (agent count, budget). No marketplace order, licence or ledger |
| Agent orchestrator (N20) | **Operational** for 5 fixed agent kinds; not wired to custom agents |
| Tool registry | **Partial**: minimal list in the builder (8 tools, 4 external ones disabled); no connector registry, no scopes |
| Workflow builder | JSON workflow definitions/versions/executions exist; no visual editor |
| Approval engine | **Operational** for content publication (N18/N20/N21); no approval of marketplace submissions |
| Agent history/versions | **Not implemented** (a revision counter only; `WorkflowVersion` exists for workflows) |
| Marketplace entities | **Not existing** before block A |
Consequences: install, update, rollback, reviews-by-installers and orders cannot be built until agent versions/activation exist; block A therefore stays read-only.

## Block A – catalog (done)
- **Data** (`20261209090000_marketplace_catalog`): `CreatorProfile`, `MarketplaceListing` (status DRAFT…ARCHIVED, FREE/PREMIUM, `pricingSimulated`, `demo`), `MarketplaceVersion` (manifest + hash + changelog; **a database trigger refuses any change of manifest, hash, version, changelog or listing**, only the status may move), `MarketplaceReview` (unique per listing+business, rating 1–5 check). Listings are platform data, not tenant data; no client information is stored in them.
- **Package manifest v1** (`@touma/shared/marketplace`): data only; unknown fields refused (no scripts/hooks/code); id/semver rules; no secret, URL or host name anywhere; the agent part uses the builder's rules (so external tools, rule overrides, personal data, unknown models are refused); declared permissions must equal the permissions derived from the tools; the agent's model must be listed in `compatibleModels`. Passing validation does **not** mean safe to publish: the security gateway and human review (block C) decide that.
- **API** (`agents.read`, flag-gated): `GET /marketplace/catalog` (search over name/summary/description/tags, category, pricing, model, sort by date or name, pagination), `GET /marketplace/categories`, `GET /marketplace/listings/:slug` (description, creator, capabilities and permissions derived from the manifest, models, licence, latest version, update history with per-version permissions, reviews). Only PUBLISHED listings with at least one PUBLISHED version and an ACTIVE creator are visible; suspending a listing or creator hides it at once. No popularity ranking exists. Installs show `null` with a note (never an invented count); reviews count only when moderated `APPROVED`, without any reviewer identity.
- **Demo** (`POST /admin/marketplace/demo-seed`, SUPER_ADMIN, `MARKETPLACE_DEMO_ENABLED`, refused in production): fictitious creator "Demo Studio" and three listings: Marketing AI Pro (free, v1.0.0 and v1.1.0 – the update adds one read permission, visible in the history), Customer Support AI (premium, simulated: no price, no payment), E-commerce Research AI (free). Idempotent.
- **UI** `/dashboard/marketplace` (EN/FR): search, filters, cards, agent page with permissions, capabilities, models, licence, instructions, history. Read-only.
- **Tests**: 6 unit (manifest) + 8 e2e (admin-only idempotent seed; listing contents; filters; page details incl. permission added by an update; hidden drafts/suspended/unpublished/suspended creators; review moderation and anonymity; database immutability and hash; access and flag).

## Status per phase
| Phase | State |
| --- | --- |
| 1 Catalog | **Operational** (read-only, demo data) |
| 2 Packaging standard | **Partial**: manifest v1 schema, canonical hash, immutable versions; no import/export tooling, no archive format |
| 3 Install engine | Not implemented (needs agent versions/activation) |
| 4 Creator studio and statuses | **Partial**: status enum and data model only |
| 5 Security gateway | Not implemented (manifest validation only) |
| 6 Billing simulation | Not implemented |
| 7 Reviews | **Partial**: table and moderated display only; no write endpoint (installation required) |
| 8 Update engine | Not implemented |
| 9 Admin control center | **Partial**: demo seed only |
| 11–12 Tests / demo | Block A tests and the three listings only |

## Decisions needed before block B
1. Agent versions and an activation gate (N23 phase 8) must exist so an installed copy can be pinned to a version: build them first, or let block B create a minimal installation record that holds the isolated copy?
2. Which entity owns a creator profile (a business, a user)? The model allows a business; confirm.
3. Which review policy for sensitive listings (always human review, or by permission level)?

## Risks remaining
The catalog trusts manifests created by the seed; creator submissions do not exist yet, so the security gateway has not been exercised on hostile input beyond the manifest validator. Demo data is flagged `demo` and must be removed before any real launch.
