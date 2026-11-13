# Integration status (Phase N8)

Evidence: repository code, migrations and test runs on a local PostgreSQL 16 + Redis 7 (no external service, no real AI, simulated providers).

| Phase / module | Status | Evidence |
| --- | --- | --- |
| N2 Orchestrator (`runs/`) | IMPLEMENTED_AND_TESTED (simulated adapters only) | `runs.e2e-spec` 16/16 |
| N3 Workflow engine (`workflows/`) | IMPLEMENTED_AND_TESTED; the calendar step is a simulation | `workflows.e2e-spec` 22/22 |
| N4 Market intelligence | IMPLEMENTED_AND_TESTED (manual import, no provider); NOT wired to workflows | `market.e2e-spec` 15/15 |
| N5 Sales assistant | IMPLEMENTED_AND_TESTED; the only module wired to workflows (`sales.followup-suggest`) | `sales-assist` 14/14, `sales-agent` 60/60 |
| N6 Control center | PARTIALLY_IMPLEMENTED: queue metrics + one alert + dashboard only | `ops.e2e-spec` 11/11 |
| N6 AI cost budgets, reliability engine, security views, other alerts | NOT_IMPLEMENTED | no code |
| N7 | One fix implemented (secrets in 5xx logs); the rest is an audit | `log-safety` 3/3 |

## Dependency validation
| Link | Result |
| --- | --- |
| Web ↔ API | Routes called by the web exist in controllers (static check); browser tests not run in N8 |
| API ↔ PostgreSQL/Prisma | Validated: all migrations apply, e2e suites pass |
| API ↔ Redis/BullMQ workers | Validated: runs, ai-jobs, calendar-worker, social-publishing suites |
| Orchestrator ↔ Workflows | Validated (`runs`, `workflows`, `integration`) |
| Workflows ↔ Calendar module | NOT integrated: `simulated.calendar-schedule` creates no `CalendarEvent` (asserted in `integration.e2e-spec`) |
| Workflows ↔ Market | NOT integrated: no adapter |
| Workflows ↔ Sales | Validated: `sales.followup-suggest`, same-tenant only |
| Control center ↔ metrics | Validated for the 5 BullMQ queues (incl. `touma.runs`) and the database; workflow-run history is not shown there |
| Auth ↔ RBAC ↔ tenancy | Validated (`auth`, `businesses`, `hardening`, `integration`) |

## End-to-end scenario
`integration.e2e-spec.ts`: login → catalog product → workflow (analysis → draft → human approval → calendar step) → execution status → control center. Passes, with the calendar step proven to be a simulation.
