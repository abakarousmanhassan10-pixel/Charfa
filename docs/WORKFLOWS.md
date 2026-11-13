# Workflow engine (Phase N3)

Status: implemented and tested locally; **off by default** (`WORKFLOWS_ENABLED=false`, and it also needs `ORCHESTRATOR_ENABLED=true`; otherwise the endpoints answer 404). **Every adapter is a simulation**: no AI model is called, nothing is published, no calendar entry is written, no payment or external transaction exists. It extends the N2 orchestrator ([ORCHESTRATOR.md](ORCHESTRATOR.md)); it does not replace it and reuses its engine, queue, approval gate, audit and tests.

## Model
- `WorkflowDefinition` (name, `currentVersion`, `isActive`, `nextRunAt`) and immutable `WorkflowVersion` rows (the validated JSON document). Saving a definition adds a version; executions already started keep the version they started from.
- An **execution** is an `AgentRun` with `workflowId`, `workflowVersion`, `triggerType` (`manual`, `schedule`, `event`) and `triggerData`; its steps are a snapshot of the version. New run statuses `PAUSED`, `CANCELLED`; new step statuses `SKIPPED`, `CANCELLED`. A failed run gets `deadLetteredAt` (the dead-letter list) until it is retried.

## Definition format (JSON data, never code)
```json
{ "triggers": [ {"type":"manual"}, {"type":"schedule","everyMinutes":60}, {"type":"event","event":"product.created","condition":{"field":"trigger.price","op":"gte","value":100}} ],
  "input": { "topic": {"type":"string","required":true,"maxLength":200} },
  "defaultInput": {},
  "steps": [ {"key":"analysis","adapter":"simulated.product-analysis"},
             {"key":"draft","adapter":"simulated.content-draft","dependsOn":["analysis"],"condition":{"field":"steps.analysis.output.score","op":"gt","value":50},"retry":{"maxAttempts":2,"backoffMs":1000}},
             {"key":"schedule","adapter":"simulated.calendar-schedule","dependsOn":["draft"],"requiresApproval":true} ] }
```
Strict validation: unknown keys are refused; adapters come from a fixed registry; at most 10 steps and 3 triggers; no cycles; a step whose adapter acts outside TOUMA **must** require approval (checked when saving, when creating an execution and when the step is claimed). Schedules cannot be shorter than `WORKFLOWS_MIN_SCHEDULE_MINUTES` (15). Event types are a fixed list (`product.created`, `product.updated`, `workflow.execution.completed`, `workflow.execution.failed`).

**Conditions** (`all` / `any` / `not` and comparisons `eq neq gt gte lt lte in contains exists`) read only `input.*`, `trigger.*` and `steps.<key>.output.*`, with scalar values. No expressions, regular expressions or functions; depth ≤ 3, ≤ 10 comparisons; prototype keys are refused. A false condition marks the step `SKIPPED`, which counts as satisfied for the steps that depend on it.

## Triggers
- **Manual:** `POST /workflows/:id/executions` with an `Idempotency-Key` header.
- **Scheduled:** the worker's tick claims a due schedule with one conditional `UPDATE` of `nextRunAt` (so several workers start a slot once), starts the run with the key `sched:<workflow>:<slot>` and runs it **as the person who activated the workflow** (if they lose `ai.use` the run fails with `REQUESTER_NOT_ALLOWED`). Missed slots are not replayed.
- **Internal event:** `WorkflowsService.emit(businessId, type, eventId, payload)`, called by TOUMA's own code only (no public endpoint). The payload is reduced to ≤ 10 short scalars; the same `eventId` never starts the same workflow twice (key `evt:<workflow>:<eventId>`). Loop guards: a workflow never reacts to its own completion, and an event chain stops after 3 hops. **Today the only emitters are the engine's own completion/failure events**: no existing TOUMA module emits `product.created` yet (planned for N4).

## Controls
`PUT /workflows/:id` (new version), `POST /workflows/:id/activate|deactivate`, `GET /workflows`, `GET /workflows/:id`, `GET /workflows/:id/versions/:n`, `GET /workflows/:id/executions`; on executions (`/runs`): `GET /runs?workflowId=&deadLettered=true`, `POST /runs/:id/pause|resume|cancel|retry`, `POST /runs/:id/steps/:key/approve|reject|resolve`.

| Action | Permission |
|---|---|
| Create, update, activate, deactivate a workflow | `business.update` (admins, owners) |
| Read workflows, start an execution, read runs | `ai.use` |
| Approve, reject, pause, resume, cancel, retry, resolve an unknown outcome | `content.approve` (admins, owners) |

- **Pause:** no new step starts; a running step finishes; approvals given while paused apply on resume.
- **Cancel:** unfinished steps are cancelled; refused (`STEP_IN_FLIGHT`) while an outward step is running, because its result cannot be taken back. A cancel that commits at the same instant a step is claimed is resolved by the claim itself (it only succeeds while the run is active).
- **Retry** (dead-letter recovery): failed steps start over; an outward step needs a **new approval**; a step with an unknown outcome blocks the retry until a person **resolves** it (`EXECUTED`: marked done by hand and never run by the system; `NOT_EXECUTED`: runs again after a new approval).
- **Unknown outcomes:** an outward step interrupted by a worker crash or a timeout becomes `OUTCOME_UNKNOWN`; it is never retried automatically.
- Retries use each step's `retry` policy (attempts ≤ 5, exponential backoff) or the environment default; outward steps are never retried automatically.

## Limits and environment
`WORKFLOWS_ENABLED`, `WORKFLOWS_MAX_PER_BUSINESS` (20), `WORKFLOWS_MAX_VERSIONS` (50), `WORKFLOWS_MIN_SCHEDULE_MINUTES` (15), `WORKFLOWS_TICK_MS` (30000), plus the orchestrator limits (runs in progress per business, including paused ones: 5; creation rate limit; worker concurrency). No secret is involved and nothing was added to `render.yaml`.

## Not in this phase
No real adapter (AI, calendar, social), no emitter in existing modules, no cron expressions (interval only), no per-run token/cost budget, no dead-letter notifications, no workflow editor UI (the page lists, activates, starts, follows steps, approves, pauses, cancels, retries and resolves; definitions are created through the API or the demo button), no browser test of the page, no four-eyes rule on approvals.

## Tests
`workflow-conditions.spec.ts`, `workflow-definition.spec.ts` (unit) and `apps/api/test/workflows.e2e-spec.ts` (22 tests with real PostgreSQL, Redis and BullMQ): versioning, RBAC, tenant isolation, unsafe definitions, the demonstration workflow, idempotency, conditions, retry policy, schedule and event triggers (duplicates, chains, tenant scoping), pause/resume/cancel, dead letters, unknown outcomes, requester revoked, worker restart.

## Calendar step (Phase N9)
Adapter `calendar.create-entry` (inputs `title`, `platform`, `scheduled_at` ISO instant, optional `caption`) creates a real `CalendarEvent` (status PLANNED, draft content) in the run's business after a person approves the step (declared external, so the approval cannot be skipped). It never authorizes or publishes: authorizing the exact content stays a separate human act in the calendar. Idempotent without a schema change: content id derived from the step key + the unique placement key, re-checked under the scheduling lock. Conflicts (including a time in the past) fail the step with `CALENDAR_CONFLICT`; other failures roll back and report `CALENDAR_FAILED`; a retry asks for a new approval and reuses the same entry if it already exists.
