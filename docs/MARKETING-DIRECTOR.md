# AI Marketing Director (phase N20)

Local, mock-only, drafts-only. Flag `CAMPAIGNS_ENABLED` (default **false**). No deployment, no paid API, no real publication, no ad spend.

## 1. Repository audit (evidence, not phase labels)

The repository has no commit or document named N15, N16 or N17, so those phases cannot be checked by name. Each capability was checked in code and tests instead.

| Capability | Status | Evidence |
|---|---|---|
| Individual publication approval (N18) | VERIFIED | `publication-gate.ts`, `approval-snapshot.ts`; suite `publication-approval.e2e-spec.ts` (12); browser `n18-approval.e2e.ts` |
| Social connectors, comments, replies (N19) | VERIFIED (simulator) / MOCK for real platforms | `social-interactions.e2e-spec.ts` (8); real platforms never contacted |
| Customer-service modes AUTO / MANUAL / PAUSED | VERIFIED | `SalesAgentConfig` (`enabled`, `replyMode`, `autoReplyAuthorizedAt`), `sales-agent.e2e-spec.ts`, N19 `replyMode()` |
| AI Orchestrator (generation jobs, grounding) | VERIFIED | `ai/orchestrator.service.ts`, `@touma/ai-engine` (`assessGrounding`, `checkFactPreservation`) |
| Run/workflow engine (steps, approvals, dead letters) | VERIFIED | `runs/`, `workflows/`; not reused by N20 (see 3) |
| Product catalog + verified knowledge | VERIFIED | `KnowledgeService.buildAgentContext` |
| Creative Studio | PARTIAL | images/video are fake providers by default; no real generation was enabled |
| Market Intelligence | PARTIAL | module exists; the Director reads no market figures (reports "unavailable") |
| Calendar + BullMQ workers | VERIFIED | `calendar/`, `CalendarWorkerService` |
| Analytics | PARTIAL | `AnalyticsSnapshot`; real metrics need platform permissions (not granted on real accounts) |
| Control center | VERIFIED | `docs/OPS-CONTROL-CENTER.md` |
| Real social publishing, real AI, real customer replies | BLOCKED | need credentials and platform approval; refused by design here |
| Campaign domain model | MISSING before N20 | only `Content.campaignId` (a parent link); added in N20 |

N18 was verified before any publishing-related work: the new tests prove a campaign cannot approve, authorize or publish.

## 2. Architecture

```
POST /campaigns            create draft (verified ACTIVE products only, idempotent)
POST /campaigns/:id/plan   PRODUCT_INTELLIGENCE → MARKET_RESEARCH → AUDIENCE_STRATEGY → CREATIVE_STRATEGY → CAMPAIGN_PLANNING
POST /campaigns/:id/content   fact-check each idea, create DRAFT calendar entries (N18 entries)
POST /campaigns/:id/submit    send drafts to individual approval (a person approves and authorizes each post)
POST /campaigns/:id/metrics   PERFORMANCE_ANALYSIS over authorized metrics
POST /campaigns/:id/follow-ups   new DRAFTS recommended by the evaluation
POST /campaigns/:id/pause|resume|cancel   kill switches (ADMIN)
POST /campaigns/triage/comments/:id   CUSTOMER_SERVICE decision (sends nothing)
```

The Director calls agents in a **fixed order**. Agents cannot call each other (`agents.invoke` is a forbidden tool), so there is no recursion.

### Agent contracts (`@touma/shared/campaign.ts`)
Seven agents, each with a responsibility, allowed read-only tools, data scope, max executions per campaign, max attempts per key, timeout (5 s) and cost (0 USD). `assertAgentContracts` rejects any contract holding `social.publish`, `social.schedule`, `messages.send`, `ads.spend`, `billing.write`, `network.fetch` or `agents.invoke`. Only the customer-service agent touches customers, and it only returns a decision.

### Per-execution guarantees (`CampaignsService.exec`)
Tenant-scoped load; refused when paused/cancelled; idempotent replay (same key returns the stored result, no second run, no cost); retry cap (`RETRY_LIMIT`); per-agent cap; atomic execution reservation before any work (`EXECUTION_LIMIT`), cost check (`COST_LIMIT`, limit 0 by default); timeout; output size cap; every outcome stored in `AgentExecution` (failures stay listed: the dead-letter view) and audited.

### Domain model (additive migration `20261123090000_campaign_engine`)
| Requested | Implementation |
|---|---|
| Campaign, CampaignGoal | `Campaign` (`goal` JSON: type + text), status DRAFT → PLANNED → CONTENT_READY → AWAITING_APPROVAL → ACTIVE → COMPLETED (+ CANCELLED) |
| CampaignProduct | `CampaignProduct` |
| CampaignContent | `CampaignContent` (link to the calendar entry, which holds the content) |
| AudienceRecommendation | inside `Campaign.plan.audiences` |
| PublicationApproval, ScheduledPublication | **reused**: N18 `CalendarEvent` + approval snapshot. The campaign stores no approval state, and its own status is *derived* from its posts |
| CampaignMetric | **reused**: `AnalyticsSnapshot` through the publication; origin shown as REAL / SIMULATED / UNAVAILABLE |
| AgentExecution, ExecutionBudget | `AgentExecution`; budget columns on `Campaign` |

## 3. Why the run/workflow engine was not extended
Its templates are fixed in code and its adapters are generic. The campaign needs typed outputs, per-agent budgets and a domain model, so a thin purpose-built executor was cleaner than bending run templates. It reuses everything else (catalog context, grounding checks, calendar, N18, analytics, audit). Folding the Director into the run engine later is possible and listed as an open question.

## 4. Safety rules
- Publication: only through N18. The Director can create drafts and submit them; approving, authorizing and dispatching stay human and per post. Editing after approval returns the post to review (tested).
- Facts: copy is built from verified product fields and re-checked with `assessGrounding` and `checkFactPreservation`; an unverified price or claim is rejected, not repaired.
- Market data: never invented (`UNAVAILABLE`). Audiences: non-sensitive only (religion, health, politics, etc. are excluded).
- Prompt injection: untrusted product text is sanitized and dropped from outputs when it looks like an instruction.
- Performance: simulated data never outranks real data; unavailable is not zero; no causal sales claim; no ad spend is ever planned or changed.
- Customer service: PAUSED and MANUAL never send; AUTO only for a grounded, non-sensitive question with no earlier reply, and the N19 service checks the mode again at send time. Sensitive topics, unknown questions and instruction-like messages escalate to a person.

## 5. Estimated costs
- Development and tests: 0 USD (local Docker PostgreSQL and Redis, mock agents).
- Per campaign today: 7 agent executions (5 plan, 1 content, 1 evaluation), all deterministic: 0 USD, no network.
- If an agent is later backed by a real model, cost = calls × tokens × the provider's current rate. Rates were not verified here; configure `AI_MODEL_PRICING` and keep `costLimitMicros` at the budget you accept. It is 0 until you raise it.
- Hosting: the free demo (PostgreSQL free plan expires after 30 days; services sleep when idle). Production sizing is in `docs/DEPLOYMENT.md`.

## 6. Limitations
Mock creative only (no images); two languages (en, fr); one campaign status sync happens on read; follow-ups reuse the first channel; the market agent has no data source; comment triage uses keyword matching against verified knowledge, which is a deliberately conservative placeholder for a real model; no Playwright coverage of the approval of individual posts beyond N18's own test.

## 7. Next milestone
Run the Director against a real model for the Creative Strategy agent only, behind `costLimitMicros`, with the evaluation suite as the gate (needs your explicit authorization and a provider key).
