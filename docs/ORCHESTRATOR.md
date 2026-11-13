# AI Orchestrator MVP (Phase N2)

Status: implemented and tested locally; **off by default** (`ORCHESTRATOR_ENABLED=false`, the endpoints answer 404). Every adapter is a **simulation**: no AI model is called, no key is used, and nothing leaves TOUMA. It does not replace the existing generation pipeline (`apps/api/src/ai/orchestrator.service.ts`); it is a general, persistent run engine that later phases will plug real agents into.

## Model
A **run** (`AgentRun`) is created from a predefined **template** (callers pick a template and give a strictly validated input; they never submit steps). It holds **steps** (`AgentRunStep`) with `dependsOn`, `requiresApproval`, `attempts`, `output`, `errorCode`, and an append-only **history** (`AgentRunEvent`: codes and counters only, never the business input).

Statuses (run and step): `PENDING`, `RUNNING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`. A rejected approval fails the step and the run (`APPROVAL_REJECTED`).

Shipped template `simulated-content-launch` (v1): `analyze` → `draft` → `publish` (simulated outward action, requires approval).

## API (`/api/v1/runs`, needs `X-Business-Id`)
| Route | Permission | Notes |
|---|---|---|
| `POST /runs` | `ai.use` | Header `Idempotency-Key` (8–64 chars `[A-Za-z0-9_-]`) required. 201 new, 200 replay of the same key and request, 409 same key with another request, 429 at the limit of runs in progress |
| `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events` | `ai.use` | Scoped to the business; other businesses get 404 |
| `POST /runs/:id/steps/:key/approve` / `reject` | `content.approve` | Only a step in `WAITING_APPROVAL`; a second decision is 409 |

## Execution (BullMQ queue `touma.runs`, run by `node dist/ai-worker.js` or inline when `AI_WORKER_INLINE`)
- A job only carries the run id. PostgreSQL is the source of truth; waking a run is idempotent.
- A step is **claimed** with one conditional `UPDATE` (PENDING→RUNNING): two workers or replayed jobs cannot run it twice.
- Transient failures retry with exponential backoff up to `ORCHESTRATOR_STEP_MAX_ATTEMPTS`; permanent errors fail at once; a step has a timeout.
- A step whose adapter acts outside TOUMA: never runs without a recorded approval (checked at creation and again when claimed), is never retried automatically, and after a crash or a timeout is failed with `OUTCOME_UNKNOWN` for a person to check.
- Recovery (`reconcile`, on a timer): steps RUNNING past `ORCHESTRATOR_STEP_LEASE_SECONDS` go back to PENDING (internal steps) or fail (outward steps); runs nobody advanced are woken.
- Each step re-checks that the requesting user is still an active member with `ai.use`.

## Limits and environment
`ORCHESTRATOR_ENABLED`, `ORCHESTRATOR_WORKER_CONCURRENCY` (2), `ORCHESTRATOR_MAX_ACTIVE_RUNS_PER_BUSINESS` (5, soft limit: two simultaneous creations may briefly exceed it), `ORCHESTRATOR_STEP_MAX_ATTEMPTS` (3), `ORCHESTRATOR_STEP_BACKOFF_MS`, `ORCHESTRATOR_STEP_TIMEOUT_MS`, `ORCHESTRATOR_STEP_LEASE_SECONDS`, `ORCHESTRATOR_TICK_MS`, `ORCHESTRATOR_RATE_LIMIT_PER_MINUTE` (20 creations/min per client). No secret is involved. Not added to `render.yaml` (it stays off in staging until you decide).

## Not in the MVP (by design)
No real model or external adapter, no token/cost budget per run (arrives with the first real agent step), no dead-letter table (failed runs stay queryable), no workflow versioning or triggers, no frontend, no readiness-endpoint heartbeat for the runs worker, no four-eyes rule (the creator may approve if they hold `content.approve`).

## Tests
`apps/api/src/runs/run-templates.spec.ts` (plan validation, input validation, feature flag) and `apps/api/test/runs.e2e-spec.ts` (16 tests with real PostgreSQL, Redis and BullMQ: permissions, tenant isolation, approval, idempotency, retries, recovery).
