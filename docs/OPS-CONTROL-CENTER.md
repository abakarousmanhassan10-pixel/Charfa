# Operations control center (Phase N6, first vertical slice)

Platform administrators only (`SUPER_ADMIN`, `SUPPORT`; the role is re-read from the database on every request). Platform-level telemetry: queues are identified by name, no tenant data, job payloads or secrets are read or returned. Nothing is simulated: each value is `measured` now or `unavailable` (never shown as zero).

## What exists
| Piece | Behaviour |
| --- | --- |
| Collection | Real BullMQ job counts (waiting, active, delayed, failed, completed) of the 5 queues (ai, social, creative, calendar, runs), each read time-boxed to 3 s. Sampled by the API every `OPS_SAMPLER_INTERVAL_SECONDS` (0 = off) behind a short Redis lock so several instances sample once, or on demand (`POST /admin/ops/collect`). |
| Storage | `OpsQueueSample` (5 queues × samples), pruned after `OPS_RETENTION_DAYS` (default 7). Resolved alerts are pruned the same way. |
| Worker health | Existing Redis heartbeats: up (< 90 s), stale, unknown (no signal), unavailable (Redis unreadable). |
| Alert | Rule "failed jobs ≥ threshold" (default `OPS_DEFAULT_FAILED_THRESHOLD`=10, global, overridable per queue, can be disabled). One alert per (rule, queue) while the condition lasts (occurrence counter, no duplicates, race-safe); clears itself on recovery; unknown telemetry never clears it. Notified once per administrator through the existing in-app notifications. States: OPEN → ACKNOWLEDGED → RESOLVED. |
| Safety | Monitoring never throws into callers: a failed read or write returns a summary and logs a warning. |

## Endpoints (`/api/v1/admin/ops`)
`GET overview` · `GET queues/history?queue&hours&page&pageSize` · `GET alert-rules` · `GET alerts?status&page&pageSize` (SUPPORT or SUPER_ADMIN) · `POST collect` · `PUT alert-rules` · `POST alerts/:id/acknowledge|resolve` (SUPER_ADMIN, audited).

Dashboard: `/dashboard/operations` (navigation item shown to platform administrators only).

## Not in this slice
AI cost budgets and quotas (existing per-tenant usage tracking is reused later), dead-letter inspection and recovery actions, circuit breakers, authentication-failure and rate-limit event views, storage/SMTP indicators here (still available at `/health/ready`), alert channels beyond in-app notifications.
