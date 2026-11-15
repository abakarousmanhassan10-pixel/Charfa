# AI agents + Billing Guardian (N28)

Off by default (`AGENTS_ENABLED=false` → every `/agents` and `/admin/agents` route answers 404). Everything runs on simulated providers: the text model is the
mock/fake provider, publication is **simulated**, no network call leaves the process and no money moves. The real OpenAI provider stays disabled
(`OPENAI_ENABLED=false`); model names are never invented: set `AGENT_MODEL_TIERS` / `AGENT_ALLOWED_MODELS` only after checking the models your account can access.

## Architecture
- **Job engine = the existing run engine** (`apps/api/src/runs`): persistent runs/steps, priorities, retries with backoff, dead letters, idempotency keys,
  timeouts, lease recovery, per-business concurrency cap. Agents plug in as adapters (`agent.research|content|support|analytics|supervisor`, `agent.publish-simulated`).
- **Task states**: CREATED → QUEUED → RUNNING → WAITING_APPROVAL → COMPLETED, plus FAILED, CANCELED, BLOCKED (`taskStateOf`).
- **Agents** (`Agent` rows, per business): role, permissions, allowed tools, model tier, output/cost/day limits from `AGENT_CATALOG`; config validated server-side.
  Agents only write drafts in review; they never publish, send or spend, and cannot approve.
- **ModelRouter**: economy tier for simple agents, advanced for complex ones, from configuration only. **ConversationStore** keeps prompts/answers with retention.
  **ToolRegistry** validates tool arguments (zod), per-agent allow-lists and permissions; read-only tools; untrusted text is delimited and scanned for prompt injection.

## Billing Guardian (`AgentGuardian`)
Checked at admission **and again before every step** (an expiry while a task waits blocks it): stop switches, tenant/subscription state (`resolveEntitlement`: grace policy
as in billing), plan feature `agents`, allowed agent types, max agent instances, calls and budget left, per-agent daily calls, per-run cap, optional daily/monthly caps.
- **Atomic reservation** under a per-tenant advisory lock: `reserve` holds one call + estimated cost; `settle` turns it into a `UsageEvent` with the real tokens;
  `release` frees it when nothing was consumed (provider failure); `reconcileStale` frees reservations of crashed workers. Two simultaneous tasks cannot overrun.
- **Quota periods**: one `TenantEntitlement` row per subscription period (created lazily); a renewal moves the period and starts fresh counters, old rows are kept.
- Clients cannot change limits: they come from the plan (`Plan.limits`: `agents`, `maxAgentInstances`, `agentCallsPerMonth`, `agentBudgetMicrosPerMonth`, `features`).
- **Costs** are integer micro-USD (BigInt in DB), from a versioned `ModelPrice` table. They are **estimates**, never a bill; unpriced models use `AGENT_UNPRICED_MICROS_PER_CALL` and are flagged `priced=false`.

## Human approval
`AgentApproval` is bound to the SHA-256 of the exact content version + channel, single-use, expiring. Editing a draft supersedes the approval and creates a new one;
approving needs the hash of the version read. Publication is the external step `agent.publish-simulated` (always waits for approval; simulated only).

## Emergency stop
`POST /admin/agents/stop|resume` (SUPER_ADMIN) with scope GLOBAL, TENANT or AGENT (+ optional `cancelPending` → BLOCKED). Nothing new starts, no model is called and no
outward step runs while a switch is on; blocked tasks can be retried after the resume. Audited.

## API
Customer (`agents.read|run|manage|approve`): `GET /agents/catalog`, `GET|POST /agents`, `PATCH /agents/:id`, `POST /agents/:id/enable|disable`, `POST /agents/tasks` (`Idempotency-Key`),
`GET /agents/tasks[/:id]`, `POST /agents/tasks/:id/cancel|retry`, `GET /agents/approvals[/:id]`, `POST /agents/approvals/:id/approve|reject|modify`, `GET /agents/usage`, `/usage/report`, `GET|PUT /agents/budget`.
Admin (SUPER_ADMIN/SUPPORT): `GET /admin/agents/overview?businessId&from&to`, `/controls`, `/models` (flagged "not verified"), `/prices`, `POST /admin/agents/prices` (new version).
UI: `/dashboard/agents` (customer) and `/dashboard/operations/agents` (admin).

## Data model
`Agent`, `AgentConversation`, `AgentApproval`, `UsageEvent` (unique run+step+attempt), `UsageReservation` (unique run+step+attempt), `TenantEntitlement` (unique business+period),
`BudgetPolicy`, `ModelPrice` (unique model+version), `AgentControl`; `AgentRun.priority`. Migrations `20261205090000_agents_states`, `20261205090100_agents_guardian` (additive).

## Limits (honest)
No 24/7 guarantee: workers are normal processes, recovery is lease-based. Real provider, real publication and real prices are not verified. The model/price names
must be configured by an operator after verification. Retention purge runs hourly in the API process.
Tests: `apps/api/test/agents.e2e-spec.ts` (17 scenarios incl. the demo), unit tests in `packages/shared`.
