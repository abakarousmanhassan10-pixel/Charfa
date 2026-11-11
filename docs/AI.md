# TOUMA AI engine

*Your Business. Your AI Marketing Team.*

## Agents
| Agent | Task | Output (strict JSON schema) | Prompt version |
|---|---|---|---|
| Business Analyst | `BUSINESS_ANALYSIS` | industry, positioning, geographic market, brand identity, communication style, target segments, customer needs, **sourced** strengths, objectives, priority platforms, missing information, assumptions | `business-analyst@1` |
| Product Analyst | `PRODUCT_ANALYSIS` | **sourced** characteristics and verified benefits, customer problems, segments, positioning, marketing angles, differentiation, objections (with `needsBusinessInput`), FAQ (answer `null` when not in the data) | `product-analyst@1` |
| Marketing Strategist | `MARKETING_STRATEGY` | per platform: objective, audience, content pillars, valid formats, posting frequency, weekly plan, KPIs; campaigns, 4-week monthly plan, promotional ideas, CTAs | `marketing-strategist@1` |
| Content Creator | `CONTENT` | title, hook, caption, description, slides, scenes, story frames, hashtags, CTA, visual suggestions, **claims with sources**, warnings | `content-creator@1` |

Code: `packages/ai-engine/src/agents/*`. Schemas: `packages/ai-engine/src/schemas.ts`.

## Background generation (BullMQ)
Generation never runs inside the HTTP request. `POST /ai/*` validates the request, reserves quota, stores a `QUEUED` generation, enqueues a job and answers **202** with the generation id and a `statusUrl`. A worker does the rest.

```
POST /ai/content ─► validate ─► reserve quota (atomic) ─► AIGeneration QUEUED ─► BullMQ job (id = generation id) ─► 202
                                                                                      │
                                      worker:  QUEUED ─► RUNNING ─► SUCCEEDED                    (quota committed)
                                                           │   └──► QUEUED (transient failure; retry with backoff)
                                                           └──────► FAILED (permanent, or attempts exhausted) (quota settled)
GET /ai/generations/:id/status  → poll (no output payload)
GET /ai/generations/:id         → the result, steps, usage, quality report, review state
```
- **What is rejected synchronously (nothing stored, nothing charged):** provider not configured (503), unknown or inactive item (404 / 400), monthly limit reached (429), queue unavailable (503).
- **Where the worker runs:** its own process, `node dist/ai-worker.js` (same image as the API, scale it horizontally; health `GET :4002/health`), or inside the API process with `AI_WORKER_INLINE=true` (development, tests). Readiness reports `dependencies.aiWorker` from a Redis heartbeat; without a worker, accepted jobs simply wait in the queue.
- **Retries and failure handling:**
  - *Transient* provider failures (rate limit, timeout, 5xx, network) are retried by the queue, `AI_JOB_ATTEMPTS` times (default 3) with exponential backoff from `AI_JOB_BACKOFF_MS`. While it waits, the generation is `QUEUED` with `retrying: true` and the last error code.
  - *Permanent* failures are not retried: bad credentials, refusals, truncation, an answer that fails validation after the repair call, a deleted or deactivated item, a user who lost access.
  - A failure is stored on the generation (`errorCode`, `errorMessage`), with the tokens it consumed.
  - Analyses triggered by a job are reused on retry, so a retry never repeats finished work.
- **Permissions are re-checked when the job runs:** a member who is removed (or loses `ai.use`) after submitting gets nothing generated.
- **Self-healing (`reconcile`, every minute):** settles reservations of jobs that finished without settling, fails jobs that disappeared from the queue after `AI_RESERVATION_STALE_MINUTES`, and re-enqueues accepted generations whose job was never created (for example after an API crash). The job id is the generation id, so double enqueueing is a no-op, and a finished job re-delivered by the queue is ignored.
- **Job payload:** only `{ generationId }`. Business data is read from the database by the worker and never travels through Redis.

## Orchestration (`apps/api/src/ai/orchestrator.service.ts`)
`submit()` runs in the API; `runPipeline()` runs in the worker:
1. **Retrieve authorised data**: `KnowledgeService.buildAgentContext(tenant)`. This is one business only, verified knowledge plus ACTIVE products and services. Drafts and unverified knowledge are never used.
2. **Analyse the business**: reuses the latest business analysis whose context hash matches the current facts; otherwise runs the Business Analyst.
3. **Analyse the product** (when content is about an item): same reuse rule, per item.
4. **Select the strategy angle**: rotates through the product analysis's marketing angles; otherwise uses a content pillar of the latest strategy for that platform; otherwise relies on the business profile.
5. **Generate**: Content Creator with platform rules in the prompt.
6. **Validate**:
   - the Zod schema;
   - grounding against the verified data (see "Accuracy checks");
   - fact preservation for the promoted item;
   - platform rules (lengths, hashtags, slides, frames, video duration, required sections);
   - output language;
   - leak checks.
7. **Save**: the generation (output, pipeline `steps`, `quality` report), plus one `AIUsage` row per provider call (initial call, provider retries, repairs).
8. **Settle** the quota reservation (below).

**In-process retries.**
- Within one attempt, transient provider errors are retried with backoff (`AI_MAX_PROVIDER_RETRIES`).
- An invalid answer triggers a *repair* call that contains the validation feedback (`AI_MAX_REPAIR_ATTEMPTS`).
- Every call is billed and recorded, including failed ones.

## Usage limits: atomic reservations
Monthly limits (generations and tokens, per business, per UTC month) are enforced by **reservations**, not by counting rows afterwards, so concurrent requests cannot exceed them.
- **Reserve.** Accepting a job takes a reservation of *units* (one per agent run the job is expected to need: 1 for an analysis, up to 3 for content about an item when no analysis is cached) and the estimated tokens (`AI_TOKENS_RESERVED_PER_GENERATION` per unit). The check and the increment are one conditional SQL `UPDATE` on the business's monthly counter row (`AIUsagePeriod`):
  `reserved + completed + failed + units <= limit` (and the same for tokens). The row lock serialises concurrent requests; the loser gets `429 AI_LIMIT_REACHED` or `AI_TOKEN_LIMIT_REACHED`, and nothing is stored.
- **Top up.** If facts changed and a job needs more steps than estimated, the worker takes the extra units under the same rule; if the limit does not allow it, the job fails and releases.
- **Settle (exactly once).** When a job ends, the units whose agent runs **consumed tokens** become `completed` (SUCCEEDED) or `failed`; everything else is **released**. Measured tokens replace the estimate. A job whose provider calls all errored (rate limit, outage) consumes nothing and is fully released; a job that failed validation after spending tokens is charged as a failed generation.
- **Counters** (`AIUsagePeriod`): `reservedGenerations`, `completedGenerations`, `failedGenerations`, `releasedGenerations` (cumulative), `reservedTokens`, `usedTokens`. Each reservation (`AIReservation`) records its outcome (`RESERVED` → `COMMITTED` / `RELEASED`, consumed units and tokens).
- **Consistency.** `AiUsageService.consistency()` recomputes the reserved counters from open reservations and the settled tokens from the reservations, and the tests assert that they match the measured `AIUsage` rows after mixed successes, failures and retries.
- **Plan limits.** An ACTIVE or TRIALING subscription's plan sets the limits (`limits.aiGenerationsPerMonth`, or the seeded `aiCreditsPerMonth`, and `aiTokensPerMonth`); otherwise the `AI_MONTHLY_*` defaults apply. `/ai/status` shows the source (`plan` / `default`).

## Platform adaptation (`packages/shared/src/ai.ts → FORMAT_RULES`)
| Platform | Formats | Key limits enforced |
|---|---|---|
| Instagram | Caption, Reel script, Story, Carousel | caption ≤ 2,200 chars, ≤ 30 hashtags, carousel 2–10 slides, story 1–10 frames, Reel 7–90 s |
| Facebook | Promotional post, Educational post, Product announcement | ≤ 5,000 chars (practical), ≤ 5 hashtags, announcement title ≤ 120 |
| TikTok | Short video script (hook, scenes, on-screen text, CTA) | 7–60 s, caption ≤ 2,200, ≤ 8 hashtags |
| YouTube | Video title + description, Shorts script | title ≤ 100, description ≤ 5,000, ≤ 15 hashtags, Shorts 7–60 s |
| Any | Product description, Ad copy, Promotional message | no hashtags; short headline/body limits |

Languages: English, French, Turkish, Arabic (output). Arabic content is edited right-to-left in the UI.

## Safety and quality
- **Data isolation**: the context is built from the verified `TenantContext`, and product analysis receives only the analysed item. Tests assert that other tenants' names never appear in prompts.
- **Prompt injection**:
  - System prompts contain only TOUMA-authored text.
  - Business data and user guidance are sent as JSON inside `<business_data>` / `<user_instructions>` blocks, with angle brackets neutralised so data can't close a block.
  - Control and bidi characters are stripped and lengths capped (guidance ≤ 500 chars).
  - Known injection phrasings are flagged on the generation (`injectionFlags`) and audited (`ai.injection_flagged`).
- **No actions**: agents have no tools or function calling. Output is stored, and becomes a **DRAFT** only when a human clicks "Save draft". Nothing is ever published.
- **No fabricated claims**: see "Accuracy checks". Facts must cite a valid source id, and missing facts are reported in `missingInformation`.
- **Human approval before publication**: see "Human approval".
- **Human edits** to drafts are validated against the same schema and platform limits and checked against the verified data. The original AI output is kept.

## Accuracy checks (`packages/ai-engine/src/grounding.ts`)
Every verifiable statement is matched to the verified business data **by type**. Digits that merely appear elsewhere in the data (a SKU, a phone number, a year) no longer make an invented price look real.

| Check | A statement passes only if… |
|---|---|
| Amounts | it is a real price (price, discount price) or money written in the business's own text; lists like "1500, 2000" are read as separate numbers; Arabic-Indic digits are normalised |
| Currency | it is the business's or the item's currency (CFA francs are interchangeable) |
| Percentages | it is written in the data, or is the exact discount between two real prices (1 500 → 1 200 is 20%) |
| Contacts and links | phone, email, social handle, URL and dates exist in the data |
| Specifications | measures ("330 ml", "2 kg") match the data exactly |
| Durations and periods | "24 hours", "7 days a week", "3 hours" exist in the data or derive from a recorded duration (180 minutes = 3 hours) |
| Years and audience figures | "since 2015", "10 000 customers" exist in the data next to the same kind of noun |
| Claims | the data itself mentions the concept: free delivery, guarantee, refund, certification (organic, halal, vegan…), ranking, award, delivery speed, social proof and ratings, popularity, medical or health claims, time-limited offers, comparisons with competitors |
| Scarcity | "only 3 left" matches the tracked stock; "limited stock" needs the data to say so |
| Sources | every cited id exists in the data |

**Fact preservation for the promoted item** (`checkFactPreservation`): another item's price must not be attributed to it, and its recorded availability must not be contradicted ("order now" for an out-of-stock or discontinued item, "available now" for a pre-order). The AI only reads the knowledge base and catalogue; it never writes to them, and the tests assert they are unchanged after every task.

Each generation stores a **quality report** (`passed`, the checks applied, the issues, and the facts that were verified: amounts, percentages, links, contacts, sources). Failing text is rejected (after one repair call) and never becomes a result.

These checks are rule-based. They catch the common, checkable kinds of invention; they cannot prove that every sentence is true, so a person still approves everything before publication.

## Human approval
AI-written content cannot be published until a person with `content.approve` (ADMIN, OWNER) has approved the exact text.

```
saved draft (DRAFT) ──submit-review──► IN_REVIEW ──approve──► APPROVED
                                          └────────reject────► REJECTED (reason)   ──submit-review──► IN_REVIEW
editing the text of any non-DRAFT content ──► back to DRAFT, approval cleared
```
- **Approval is bound to the text.** `Content.approvedVersion` records the version a person approved; any change to the text bumps the version and clears the approval. Saving unchanged text is a no-op.
- **Approval re-checks the facts as they are now.** A draft edited to contain an unsupported price, or one whose facts changed since it was written (the price was updated), is refused with `422 APPROVAL_BLOCKED` and the list of issues. Edits with unsupported facts can still be saved as drafts; they just cannot be approved.
- **The publication gate:** `AiApprovalService.assertPublishable(businessId, contentId)` throws `409 APPROVAL_REQUIRED` for AI-generated or AI-assisted content unless it is APPROVED at its current version. Phase 5/7 scheduling and publishing must call it. No publishing exists yet.
- Every step is audited (`ai.draft_saved`, `ai.content_submitted`, `ai.content_approved`, `ai.content_rejected`, `ai.approval_blocked`).

## Configuration (environment only; no credentials in code)
| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `openai` | provider (`fake` = deterministic test-only provider, refused unless `APP_ENV=test`) |
| `OPENAI_API_KEY` | — | required for real generations; without it every AI endpoint returns `503 AI_NOT_CONFIGURED` |
| `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION` | — | optional (proxy/Azure-compatible gateway, org header) |
| `AI_MODEL` | `gpt-4o-mini` | any model supporting Structured Outputs (`json_schema`, `strict`) |
| `AI_TEMPERATURE` | per agent (0.3 / 0.3 / 0.6 / 0.8) | global override, 0–2 |
| `AI_MAX_OUTPUT_TOKENS` | 4000 | per call |
| `AI_TIMEOUT_MS` | 90000 | per call |
| `AI_MAX_PROVIDER_RETRIES` / `AI_MAX_REPAIR_ATTEMPTS` | 2 / 1 | resilience |
| `AI_MONTHLY_GENERATIONS_PER_BUSINESS` / `AI_MONTHLY_TOKENS_PER_BUSINESS` | 300 / 3,000,000 | default monthly limits per business; an active plan's limits take precedence. Enforced by atomic reservations |
| `AI_TOKENS_RESERVED_PER_GENERATION` | 12000 | tokens held per reserved unit until the real usage is known |
| `AI_JOB_ATTEMPTS` / `AI_JOB_BACKOFF_MS` | 3 / 5000 | queue attempts for transient failures and the base of the exponential backoff |
| `AI_WORKER_CONCURRENCY` | 4 | jobs a worker runs at once |
| `AI_WORKER_INLINE` | `false` | run the worker inside the API process (development, tests). Production: `node dist/ai-worker.js` |
| `AI_WORKER_HEALTH_PORT` | 4002 | health endpoint of the standalone worker |
| `AI_RESERVATION_STALE_MINUTES` | 120 | reservations of jobs that vanished from the queue are released after this |
| `AI_RATE_LIMIT_PER_MINUTE` | 10 | per-client throttle on generation endpoints |
| `AI_MODEL_PRICING` | `{}` | per-model prices, JSON: `{"gpt-4o-mini":{"inputPerMillion":0.15,"outputPerMillion":0.6}}` (USD per 1M tokens). A dated snapshot such as `gpt-4o-mini-2024-07-18` matches its base name. Malformed JSON stops the server at start |
| `AI_INPUT_COST_PER_1M_TOKENS` / `AI_OUTPUT_COST_PER_1M_TOKENS` | 0 | flat fallback prices for models not in `AI_MODEL_PRICING`. Set them from your provider's price list; 0 everywhere shows "price not configured" |

The API key is read from `OPENAI_API_KEY` only. It is never stored, logged, returned by any endpoint or sent to the browser; `/ai/status` reports only whether a provider is configured.

Adding a provider means implementing `TextModelProvider` (`generate()` returning raw JSON text and token counts; errors mapped to `ProviderError` kinds) and registering it in `createTextProvider`.

## Token consumption and cost
- Every provider call is recorded (`AIUsage`) with its **input and output tokens**, the model that served it, latency and a cost computed with that model's price (`AI_MODEL_PRICING`, then the flat fallback). Failed attempts are recorded and billed too.
- Every generation reports its own `usage` (tokens, cost, latency, provider calls), summed over all its attempts and retries.
- `GET /api/v1/ai/usage?days=30`: provider calls, tokens, estimated cost, generations succeeded / failed / in flight, breakdowns by task, agent, model and day, and month-to-date counters.
- `GET /api/v1/ai/usage/monthly?months=6`: per month, the generation counters (reserved, completed, failed, released), measured tokens, estimated cost and the breakdown by model, plus the current month's limits and where they come from.
- Everything is per business and tenant-scoped. Token counts are **measured** values returned by the provider; costs are **estimates**: tokens × the prices you configure.

## Testing status
Real OpenAI generation has **not** been tested: no API key was available. The OpenAI provider is checked against the documented Chat Completions Structured Outputs format with a stubbed `fetch`, and everything else runs against a deterministic test-only provider (`AI_PROVIDER=fake`, refused outside `APP_ENV=test`). Before production, run one generation per agent with a real key and confirm the chosen `AI_MODEL` supports `json_schema` strict mode.

## API
| Endpoint | Permission |
|---|---|
| `GET /ai/status` | `content.read` |
| `POST /ai/business-analysis` · `/ai/product-analysis` · `/ai/marketing-strategy` · `/ai/content` | `ai.use` (EDITOR+). **202** with the queued generation |
| `POST /ai/generations/:id/regenerate` | `ai.use`. **202** |
| `GET /ai/generations/:id/status` | `content.read`: `status`, `retrying`, `final`, `attempt` / `maxAttempts`, `steps`, error |
| `GET /ai/generations` · `/ai/generations/:id` · `/ai/generations/latest/:task` | `content.read` |
| `POST /ai/generations/:id/draft` | `content.write` |
| `POST /ai/generations/:id/submit-review` | `content.write` |
| `POST /ai/generations/:id/approve` · `/reject` | `content.approve` (ADMIN, OWNER) |
| `GET /ai/usage` · `/ai/usage/monthly` | `content.read` |

All require `X-Business-Id` (membership verified); another business's generation is always a 404.

Error codes:
- `AI_NOT_CONFIGURED` 503 · `AI_QUEUE_UNAVAILABLE` 503 (synchronous, nothing charged)
- `AI_LIMIT_REACHED` / `AI_TOKEN_LIMIT_REACHED` 429 (synchronous; the response includes the usage counters)
- `ITEM_NOT_ACTIVE` 400 · `ITEM_NOT_FOUND` 404
- On a failed generation (`status: FAILED`, `errorCode`):
  - `AI_INVALID_OUTPUT`
  - `AI_PROVIDER_AUTH`
  - `AI_PROVIDER_RATE_LIMIT`
  - `AI_PROVIDER_TIMEOUT`
  - `AI_PROVIDER_ERROR`
  - `AI_REFUSED`
  - `AI_OUTPUT_TRUNCATED`
  - `AI_FORBIDDEN`
  - `AI_JOB_STALLED`
  - `AI_JOB_FAILED`
- Review: `APPROVAL_BLOCKED` 422 (with `issues`) · `APPROVAL_REQUIRED` 409 · `INVALID_STATE` 409 · `NO_DRAFT` 400 · `GENERATION_IN_PROGRESS` 409

## Creative Studio
Images, videos, storyboards and the brand kit are documented in [CREATIVE.md](CREATIVE.md). Storyboards run through this pipeline (task `STORYBOARD`, agent `storyboardCreator@1`); content generation now receives the brand kit (`content-creator@2`).
