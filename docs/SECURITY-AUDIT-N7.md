# Security and scalability audit (Phase N7)

Method: code review and targeted greps of auth, tenancy, queues, storage, logging, outbound calls and docs; existing e2e suites re-run. No production system was touched. Items marked **not verified** need staging.

## Fixed in N7
- **High: secrets in server logs.** On any 5xx the exception filter logged `req.originalUrl` with its query string. Query values are secrets here (customer chat token on `GET /public/chat/:slug/messages` and `DELETE …/data`, OAuth `code`/`state`). Now only the path and parameter names are logged (`common/safe-log.ts`). The request id echoed to clients/logs is also validated (the raw header was echoed before). Tests: `log-safety.e2e-spec.ts` (fail on the old code, pass now).

## Risk register (not fixed here)
| Level | Risk | Evidence / note |
| --- | --- | --- |
| High | Backup/restore and migration rollback never exercised | Documented in DEPLOYMENT/RUNBOOK, no restore drill or timing. **not verified** |
| High | Customer chat token travels in the query string (browser history, proxies/CDN logs outside TOUMA) | Move to a header or POST body for poll/erase; needs a web + API change with backward compatibility |
| Medium | No per-tenant cap on queued jobs (creative, runs): AI is bounded by quota reservations, other queues by request throttles only | Add a per-business in-flight limit |
| Medium | Ops sampler runs inside the API; monitoring stops with it | Move to the maintenance worker |
| Medium | Redis `noeviction` + persistence and BullMQ on Render Key Value not verified | **not verified** |
| Medium | Database pool size not configured explicitly (Prisma default); direct connection required for advisory locks | Set `connection_limit` per instance count |
| Medium | Only one operational alert (failed jobs); no worker-silent or backlog-age alert | N6 follow-up |
| Low | Index review not done against real query plans | Needs data volume / `EXPLAIN` in staging |
| Low | Storage/SMTP failure behaviour documented but no failure-injection tests for R2/SMTP | |

## Checked and sound
Tenant guard (404 for non-members, role from DB), by-id writes follow tenant-scoped reads (spot-checked 45 sites), workers receive ids only and re-read tenant from the row, refresh-token rotation with reuse detection and lockout, public endpoints throttled, generic error envelope (no stack/SQL to clients), only one outbound fetch (fixed captcha URL, 5 s timeout: no user-controlled URL, so no SSRF surface), external publishing behind approval, platform admin has no tenant access.
