# Platform overview and readiness map (N17 request)

Everything below was audited in the repository on 2026-11-15; nothing here is deployed, nothing moves real money, nothing contacts a real customer or publishes for real.

| Requested | Where it lives | State |
|---|---|---|
| Stack | NestJS API, Next.js 15 web, PostgreSQL 16 + Prisma 6, Redis 7 + BullMQ, zod config, Playwright/Jest | present |
| OpenAI server-side, keys secured | `packages/ai-engine/src/providers/openai.ts`, `apps/api/src/ai/*`, `apps/api/src/openai/*`; key only in server env, never returned or logged; `OPENAI_ENABLED=false` default | **mock-verified**, live use blocked (key, spend limit, go) — `docs/OPENAI-INTEGRATION.md` |
| Multi-tenant isolation | `BusinessAccessGuard` + `@Tenant()`, every query scoped by `businessId`; cross-tenant access answers 404/403; suites `tenant-security`, billing, OpenAI, sales | present, tested |
| Agents 24/7 in background | BullMQ queues; `apps/api/src/ai-worker.ts` and `apps/worker` run as separate processes (`AI_WORKER_INLINE` only for tests/demo); retries, backoff, quotas, in-flight caps | code ready; **needs a worker host** (Render background worker or similar, paid) |
| Validation before every publication | N18 individual approval gate (`PublicationGate`, approval snapshot hash; editing withdraws approval); approvals queue UI `/dashboard/calendar/approvals`; real publishing flags off | present, tested |
| Provider-independent billing, simulated | `apps/api/src/billing/*`, `packages/shared/src/billing.ts`; simulated provider; inert Payoneer adapter; verified idempotent webhooks; trial 72 h, failures, cancel/resume, provider migration | present (simulation only) — `docs/BILLING.md` |
| Payoneer eligibility | **unverified**; a personal account is refused at start-up for automated collection | blocked on the founder's company + Payoneer's written answers |
| Customer dashboard (agents, publications, AI use, billing, history) | `/dashboard` (agents mode + AI consumption + billing cards, publications, accounts), `/dashboard/ai` (consumption), `/dashboard/calendar/approvals`, `/dashboard/billing` (state, trial, card, cancel/resume, payment + event history) | present (N25 added billing screen and overview cards) |
| Automated tests: permissions, security, API errors | role matrices, tenant isolation, webhook forgery/replay, input validation, provider error mapping, key-leak canary, quota, enforcement | present |

Remaining before commercialization: worker hosting, a real payment provider (after company creation and written eligibility), OpenAI key and spend limit, merchant onboarding legal pages, enabling `BILLING_ENFORCEMENT_ENABLED` with an explicit decision for existing businesses, trial-reminder scheduling, and a production deployment authorized by the founder.
