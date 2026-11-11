# TOUMA AI: Phase 3 final improvements, technical report

Date: 2026-11-11 · Branch: `ccr-ce5eb3d1-r4he6g` · Phase 4 was **not** started.

**Real OpenAI generation has not been tested.** No API key was available. The OpenAI provider is ready to configure through `OPENAI_API_KEY` (read from the environment only, never stored, logged or returned), and its request and response handling is checked against the documented format with a stubbed `fetch`. Everything else ran against a deterministic provider that exists only for tests (`AI_PROVIDER=fake`, refused unless `APP_ENV=test`).

## Summary

| # | Improvement | Status |
|---|---|---|
| 1 | Background generation in BullMQ workers: job id returned immediately, status tracking, retries and failure handling, results retrievable | Done and tested. Also verified with the API and a standalone worker as two real processes. |
| 2 | Atomic monthly usage reservations: reserved, completed, failed and released tracking, release on failure, consistent accounting | Done and tested, including concurrency at the HTTP level and the database level. |
| 3 | Cost tracking: input and output tokens, configurable per-model pricing, usage per business, monthly reports | Done and tested. |
| 4 | Quality: stronger fabrication detection, preservation of verified facts, human approval before publication | Done and tested. The approval gate exists, but nothing can be published yet (no publishing exists before Phase 5/7). |
| 5 | Tests: concurrent requests, monthly limits, failed jobs and retries, token accounting, tenant isolation | Done: 48 new API tests, 35 new unit tests (33 engine, 2 config), 3 new browser tests. |

## 1. Background generation

**Flow.** `POST /ai/{business-analysis,product-analysis,marketing-strategy,content}` and `…/regenerate` now answer **202** with the generation (`status: QUEUED`, `id`, `statusUrl`). A worker processes the job:

```
QUEUED → RUNNING → SUCCEEDED
                 → QUEUED   transient provider failure: retried with exponential backoff (retrying: true)
                 → FAILED   permanent failure, or attempts exhausted
```
- **Status tracking:** `GET /ai/generations/:id/status` (light, for polling: status, retrying, attempt / max, pipeline steps, error). `GET /ai/generations/:id` returns the result, usage, quality report and review state once it is `SUCCEEDED`. History lists in-flight jobs too.
- **Retries and failure handling:**
  - Transient failures (rate limit, timeout, 5xx, network) are retried `AI_JOB_ATTEMPTS` times (default 3) with backoff.
  - Permanent failures are never retried: bad credentials, refusals, truncation, an answer that fails validation after the repair call, a deactivated item, a user who lost access.
  - A failure is stored on the generation with its error code and the tokens it consumed.
  - Analyses a job already finished are reused on retry.
- **Rejected synchronously, before anything is stored or charged:** provider not configured (503), unknown or inactive item (404 / 400), monthly limit reached (429), queue unavailable (503).
- **Where it runs:** its own process, `node dist/ai-worker.js` (same image as the API, health on `:4002`, scalable), or inside the API with `AI_WORKER_INLINE=true` (development and tests). The compose file has an `ai-worker` service. Readiness reports `dependencies.aiWorker` from a Redis heartbeat.
- **Safety:**
  - The job payload is `{ generationId }` only, so no business data travels through Redis.
  - The worker re-checks that the requesting user is still an active member with `ai.use` before running.
  - The job id is the generation id, so double enqueueing is a no-op, and a finished job re-delivered by the queue is ignored.
- **Self-healing (every minute):**
  - Settles reservations of jobs that finished without settling.
  - Fails jobs that vanished from the queue after `AI_RESERVATION_STALE_MINUTES` (120).
  - Re-enqueues accepted generations whose job was never created (for example the API crashed after the commit).
- **Web:** the pages submit, then poll and show "queued", "generating" or "retrying (attempt 2 of 3)" with the pipeline steps; you can leave the page, and the result appears in History.

**Breaking API change:** the generation endpoints used to answer 201 with the result; they now answer 202 and the client polls. The web app was updated. Any other client must poll.

## 2. Atomic usage limits

**Reserve → run → settle.** Accepting a job reserves *units* (one per agent run it is expected to need: 1 for an analysis, up to 3 for content about an item with no analysis cached) and an estimated number of tokens. The check and the increment are one conditional SQL `UPDATE` on the business's monthly counter row (`AIUsagePeriod`):

`reserved + completed + failed + units ≤ limit` (and the same for tokens)

The row lock serialises concurrent requests, so the loser gets `429` and nothing is stored. If facts changed and a job needs more steps than estimated, the worker tops the reservation up under the same rule.

**Settlement happens exactly once.** When a job ends:
- Units whose agent runs **consumed tokens** become `completed` (SUCCEEDED) or `failed`.
- Everything else is **released**.
- Measured tokens replace the estimate.

A job whose provider calls all errored (rate limit, outage) consumes nothing and is fully released. A job that failed validation after spending tokens is charged as a failed generation. A transient failure followed by a successful retry counts as one generation.

**Counters** per business and UTC month: `reservedGenerations`, `completedGenerations`, `failedGenerations`, `releasedGenerations` (cumulative), `reservedTokens`, `usedTokens`. Each reservation records its outcome (`RESERVED` → `COMMITTED` / `RELEASED`).

**Plan limits:** an ACTIVE or TRIALING subscription's plan sets them (`aiGenerationsPerMonth` or the seeded `aiCreditsPerMonth`, and `aiTokensPerMonth`); otherwise the `AI_MONTHLY_*` defaults apply. Billing does not create subscriptions yet (Phase 10), so today every business uses the defaults.

**Migration:** `20261111075607_ai_background_jobs_and_usage_reservations` adds the job fields, `AIUsagePeriod` and `AIReservation`, and **backfills the counters and job fields from existing history** so limits and reports stay consistent. Applied to the dev and test databases; no schema drift.

## 3. Cost tracking

- Every provider call records **input and output tokens**, the model that served it, latency, and a cost computed with that model's price. Failed attempts are recorded and billed too.
- **Configurable pricing:** `AI_MODEL_PRICING` (JSON, USD per 1M tokens, per model). A dated snapshot such as `gpt-4o-mini-2024-07-18` matches its base name. Flat `AI_INPUT/OUTPUT_COST_PER_1M_TOKENS` act as fallback; with nothing configured the UI says "price not configured". A malformed value stops the server at start rather than silently reporting wrong costs.
- **Per business:** all usage is stored and reported per business; one business cannot see or affect another's.
- **Reports:**
  - `GET /ai/usage?days=` (calls, tokens, cost, breakdowns, in-flight jobs).
  - **New** `GET /ai/usage/monthly?months=` (per month: generations reserved / completed / failed / released, measured tokens, estimated cost, per-model breakdown, current limits and their source). Also shown on the AI overview page.
- Token counts are **measured** values from the provider; costs are **estimates**.

## 4. AI quality

**Fabrication detection** (`packages/ai-engine/src/grounding.ts`). Statements are now matched to the verified data **by type**; digits that merely appear elsewhere in the data (a SKU, a phone number) no longer make an invented price look real.
- **Prices and discounts:**
  - Amounts must be real prices or money written in the business's own text.
  - Currency must be the business's own.
  - Percentages must be written in the data, or be the exact discount between two real prices.
- **Contacts and dates:** phones, emails, social handles, URLs and dates.
- **Quantities and history:**
  - Specifications ("330 ml").
  - Durations ("3 hours" is accepted for a recorded 180 minutes).
  - Years.
  - Audience and sales figures.
- **Claim families that need evidence in the data:** guarantee, refund, certification, ranking, award, free delivery, delivery speed, social proof and ratings, popularity, medical claims, time-limited offers, comparisons.
- **Scarcity:** must match tracked stock.
- **Sources:** every cited source id must exist.

I also fixed a weakness found by the new tests: a list like "1500, 1500" was read as one number.

**Preservation of verified facts.**
- Another item's price cannot be attributed to the promoted item.
- Its recorded availability cannot be contradicted ("order now" for an out-of-stock item).
- The AI only reads the knowledge base and catalogue; tests assert they are unchanged after every task type, and that unverified knowledge and draft items never reach the provider.
- Each generation stores a **quality report** (checks applied, issues, facts verified), shown in the UI.

**Human approval before publication.**

`saved draft → IN_REVIEW → APPROVED` (or `REJECTED` with a reason, then back to review).
- Only roles with `content.approve` (ADMIN, OWNER) can approve or reject. The author (EDITOR) can submit but not approve.
- **Approval is bound to the exact text** (`Content.approvedVersion`). Editing withdraws it; saving unchanged text changes nothing.
- **Approval re-checks the text against the facts as they are now.** An unsupported price, or a price that changed since the text was written, gives `422 APPROVAL_BLOCKED` with the list of issues, which the UI shows.
- `AiApprovalService.assertPublishable()` is the publication gate and throws `409 APPROVAL_REQUIRED` unless AI-written content is approved at its current version. Every step is audited.

## 5. Test results

| Suite | Result |
|---|---|
| Unit tests, all packages | **189 passed** (ai-engine 86, api 37, shared 28, config 14, storage 11, web 8, worker 5) |
| API integration, real PostgreSQL + Redis + BullMQ + ClamAV + SMTP | **203 passed**: 48 new (28 jobs and usage, 20 quality and approval), 34 AI tests converted to the async flow |
| Real object storage on MinIO (`storage:check`, `test:real-storage`) | passes (6/6 steps, 5/5 tests), re-run today |
| Browser tests (Playwright), final build | **25 passed**: 3 new (background states, approval flow, monthly usage) |
| Typecheck · lint · production build · migration drift | 14/14 · 0 errors, 0 warnings · 9/9 · none |
| API Docker image | builds and the AI worker starts and reports healthy from it |
| Two-process check | API without a worker kept the job `QUEUED` (readiness: `aiWorker unknown`); the standalone worker then ran it to `SUCCEEDED` (readiness: `up`) |

**What the new tests prove**
- **Concurrency:**
  - 20 simultaneous requests with a limit of 5 give exactly 5 accepted and 15 rejected.
  - 10 simultaneous 3-step requests with a limit of 7 give exactly 2 accepted.
  - 40 simultaneous reservations in the database with a limit of 15 give exactly 15 granted.
  - The token limit is enforced the same way.
  - Rejected requests leave no trace; accepted jobs settle to the right counters.
- **Monthly limits:** plan limits (both keys, cancelled plans fall back to defaults), months are independent, and top-ups are bounded by the limit.
- **Failed jobs and retries:**
  - Retry until the attempts are exhausted.
  - No retry for permanent errors.
  - A failure that consumed tokens is charged, while one that did not is released.
  - A user removed after submitting gets nothing generated.
  - A job that was never enqueued is recovered, a job that vanished is failed and released, and double settlement and re-delivery change nothing.
- **Token accounting:**
  - Per-call tokens and per-model pricing (including snapshot names and fallbacks).
  - Generation totals equal the sum of their calls.
  - Counters equal their sources after mixed successes, failures and retries.
  - The monthly report matches the stored rows, including a backdated month.
- **Tenant isolation:**
  - One business exhausting its limit does not affect another.
  - Another business gets 404 for status, result, regenerate, approve and monthly usage, including with a spoofed tenant header.
  - Interleaved jobs never mix businesses' facts in prompts.
  - The job payload is ids only.

## 6. Remaining issues and limits (honest list)

1. **Real OpenAI generation is untested.** Before production: run one generation per agent with a real key (stored as a secret in the environment, never in the repo), and confirm `AI_MODEL` supports `json_schema` strict mode.
2. **Accuracy checks are rule-based.** They catch the common, checkable kinds of invention; they cannot prove every sentence true. They can also reject legitimate text whose fact is not in the knowledge base (for example "open 7 days a week"): the merchant fixes it by adding the verified fact. The claim patterns are strongest in English and French, and partial in Turkish and Arabic. A person still approves everything.
3. **Human edits with unsupported facts can be saved as drafts**; they are flagged and cannot be approved. This is deliberate (the draft is the merchant's), but it is a policy choice.
4. **The approval gate protects nothing yet**: publishing does not exist until Phase 5/7. `assertPublishable()` must be called there; it is tested, but not wired to a publish action.
5. **Token reservation is an estimate** (`AI_TOKENS_RESERVED_PER_GENERATION`, default 12 000 per unit). Close to the monthly token limit it can refuse a request that would actually have fitted; the measured tokens replace it when the job ends.
6. **A crashed job holds its quota until reconciled**: up to `AI_RESERVATION_STALE_MINUTES` (120) after a worker dies mid-job, unless the queue recovers the job first. The reconciler runs inside the worker processes, so at least one worker must be up.
7. **Polling, not push:** the web app polls the status endpoint (about every 1-2 s). There is no websocket or SSE, and no "cancel" action for a queued job.
8. **Billing is not connected to limits yet:** plan limits are read if a subscription exists, but nothing creates subscriptions until Phase 10. Limits are per business and per UTC month.
9. **Tests host the worker inside the API process** and use one provider call per job attempt (`AI_MAX_PROVIDER_RETRIES=0`) so retries are exercised at the queue level; the in-process provider-retry path is covered by the engine unit tests. The two-process topology was verified once by hand with the test provider, not in CI.
10. **Analyses a content job triggers still appear as separate rows in History** (as before).
11. **The web Docker image was not rebuilt in this pass** (the API image was). The default Debian-based images and the new CI steps have still not run on GitHub; builds here use the local substitute base image.
12. **One intermittent browser failure was found and fixed:** the test helper seeded products without checking the response, so a token rotation could skip the seed. It now verifies and retries, and the suite passed 25 of 25 in four consecutive runs afterwards.
13. **No independent security review** of the new queue, reservation and approval code has been done; the checks above are automated tests written alongside the code.

## Files of note
`apps/api/src/ai/{orchestrator.service,ai-usage.service,ai-worker.service,ai-queue,ai-approval.service,ai-history.service,ai.controller,ai.module}.ts`, `apps/api/src/ai-worker.ts`, `packages/ai-engine/src/{grounding,pricing}.ts`, `packages/config/src/{env,ai-pricing}.ts`, migration `20261111075607_*`, `apps/web/components/ai/{use-ai,review,usage-report}.tsx`, `apps/api/test/{ai-jobs,ai-quality,ai-helpers}`, `tests/e2e/ai.e2e.ts`, `docs/AI.md`.
