# OpenAI + billing readiness (N23.2)

Audit date: 2026-11-15, from the repository at the start of N23.2. Classification: VERIFIED (works and is tested locally), PARTIAL, MOCK (works only against a simulator), BLOCKED (needs an outside decision/account), MISSING.

| Module | Status | Notes |
|---|---|---|
| OpenAI provider (official SDK, Responses API, strict JSON schema, per-task models, safe errors) | **VERIFIED against the built-in mock of the OpenAI HTTP API** | The real OpenAI API has never been called. `OPENAI_ENABLED=false` by default. Live use: **BLOCKED** (key, spending limit, explicit go). |
| Product analysis | VERIFIED (mock) | Endpoint → orchestrator → mock OpenAI → validated output; UI + browser test. Draft products are refused with an explanation. |
| Product description (CONTENT agent) | VERIFIED (mock) | Grounded in catalog data; fabrication check; human approval. |
| Creative Studio – text/storyboards | VERIFIED (mock) | |
| Creative Studio – images/video | MOCK | Test providers only; real needs `IMAGE_PROVIDER`/`VIDEO_PROVIDER`, never exercised. |
| Market Intelligence | PARTIAL by design | Deterministic profitability from figures a person enters with sources; **no AI, no data provider**. |
| AI Sales Agent | VERIFIED (mock) | AUTO/MANUAL/PAUSED, handoff, rate limits, tenant isolation. **No outbound channel exists**: no real customer message can be sent. |
| Publication approval | VERIFIED | Individual approval gate (N18); real publishing flags off. |
| Billing engine | MOCK | Provider-independent; simulated provider; verified-webhook architecture. Real provider **BLOCKED** (Payoneer unverified). |
| Merchant billing screens | MISSING | Not built yet. |
| Founder lifetime access | VERIFIED | Verified owner e-mail on `FOUNDER_EMAILS`; never chargeable; exempt from enforcement. |
| Server-side subscription authorization | VERIFIED (new in N23.2), **off by default** | `BILLING_ENFORCEMENT_ENABLED` (needs `BILLING_ENABLED`). |

## Changes in N23.2
- **Subscription authorization on paid actions** (`BillingService.assertAccess`), decided from the database only: text generation (all agents through the orchestrator), image and video generation, and the sales agent's model call (the conversation then falls back to a human). 402 `SUBSCRIPTION_REQUIRED`. Reading history/status is never blocked. Trial, active, past-due grace, and the paid period of a canceled subscription grant access; expired trial, unpaid and no subscription do not; the founder always has access.
- **Labelling bug fixed**: results produced by the mock OpenAI provider were stored as provider `openai`. They are now stored as `mock-openai`, and every result view shows a "Simulated result" tag (plus the page banner).
- **Audit trail** without secrets: `ai.generation_submitted` (task, model, provider), `billing.trial_started`, `billing.cancel_requested`, `billing.resume_requested`, `billing.event_applied` (event type and id only; no prompt, key or card data).
- New env flag `BILLING_ENFORCEMENT_ENABLED` (false).

## Cost ceilings and flags (existing, verified)
Per business and month: `AI_MONTHLY_GENERATIONS_PER_BUSINESS` (300), `AI_MONTHLY_TOKENS_PER_BUSINESS` (3,000,000), `AI_MAX_INFLIGHT_PER_BUSINESS`, `AI_MAX_OUTPUT_TOKENS`, timeouts and bounded retries. Feature flags default to off: OPENAI_ENABLED, BILLING_ENABLED, BILLING_ENFORCEMENT_ENABLED, SOCIAL_PUBLISHING_ENABLED, SOCIAL_COMMENT_REPLIES_ENABLED, CAMPAIGNS_ENABLED, INTELLIGENCE_ENABLED, AUTOPILOT_ENABLED.
