# Disaster recovery and business continuity (Phase N11)

Scope: what was verified locally (disposable PostgreSQL 16 + Redis 7 containers, no remote system, no real backup touched) and what still has to be verified on the managed services. Items marked **[not verified]** depend on the provider.

## 1. Objectives (proposals, to be confirmed with the business)
| | Proposal | Basis |
| --- | --- | --- |
| RPO database | ≤ 5 min (managed PITR) / 24 h worst case (daily snapshot) | Needs PITR enabled on a paid PostgreSQL plan **[not verified]** |
| RTO database | ≤ 1 h | Local restore of a 0.3 MB dump took 0.9 s; real duration scales with size and provider: measure on staging |
| RPO objects (R2) | Unbounded today | No versioning or backup is configured; see section 4 |
| RTO application | ≤ 30 min | Redeploy previous image + forward-fix migration |
| Redis | RPO 0 not required | Queues are rebuilt from PostgreSQL by the reconcilers (below) |

## 2. PostgreSQL backup and restore
- **Backups (managed, to configure):** PITR 7 days minimum + one daily logical dump (`pg_dump -Fc`) kept 30 days in a different account/region, encrypted, access limited to two people. Take an extra logical dump before every migration. **[not configured: none exists in this repository]**
- **Drill (verified):** `infrastructure/scripts/restore-drill.sh` dumps a source database (read-only), restores it into a NEW local database named `restore_drill_*`, compares the exact row count of all 57 tables, checks constraints, indexes, migrations and a calendar → content reference, then drops the database. It refuses any non-local server, never overwrites an existing database and never writes to the source.
- **Result (local, N11):** rows identical in 57 tables; unvalidated constraints 0; invalid indexes 0; migrations 22/22 finished; orphans 0; `prisma migrate status` on the restored copy: up to date; dump 0.2 s, restore 0.9 s (307 811 bytes). Data loss observed: none for the snapshot (RPO equals the age of the dump).
- **Production restore (manual, never scripted):**
  1. Freeze writes: scale API and workers to 0 (or maintenance page).
  2. Restore into a NEW database/instance (provider PITR "restore to new"), never over the live one.
  3. Verify as the drill does (row counts of the key tables vs. the last known figures, `prisma migrate status`).
  4. Switch `DATABASE_URL` to the new instance, start API then workers, check `/api/v1/health/ready`.
  5. Keep the old instance read-only for 7 days. Reconcile objects (section 4) and queues (section 3).

## 3. Worker recovery (BullMQ)
Redis holds no source of truth: jobs carry ids only and every state lives in PostgreSQL; reconcilers rewake work after a loss.
Verified by existing e2e suites (re-run in N11, results in section 8):
- keeps queued work while a worker is down and finishes it without duplicates after it returns (`ai-jobs`);
- recovers a generation whose job was never enqueued (crash after commit) and fails and releases a job that vanished (`ai-jobs`);
- recovers claims whose job or worker disappeared and re-sends with the same key (`social-publishing`);
- never re-runs an outward workflow step after a crash: the outcome is `OUTCOME_UNKNOWN` and a person resolves it; a timeout of an outward step is never retried automatically (`runs`, `workflows`);
- a restart after a creating request was sent, or a platform answering "duplicate", is an unknown outcome and never repeated (`social-publishing`);
- cancel never lets a late approval run anything and is refused while an outward step is running (`runs`);
- calendar step: replays and concurrent attempts create one entry (`calendar-workflow`).
Procedure after a worker crash: restart it; open the Operations page (failed jobs, worker heartbeat); for runs in `OUTCOME_UNKNOWN`, check the external system by hand, then resolve; retry only failed non-outward work.

## 4. Object storage (Cloudflare R2)
- **State:** objects are uploaded after a malware scan; metadata (`MediaAsset`, outputs) lives in PostgreSQL; deletions go through a durable queue (`StorageDeletion`) retried with backoff, so an outage leaves pending deletions, not orphans.
- **Versioning:** `docs/SECURITY.md` lists "versioning + lifecycle rules"; **Cloudflare R2 support for object versioning could not be confirmed (N11)**: do not assume it. Treat objects as non-recoverable once deleted unless a second copy exists.
- **Consistency after a database restore to time T:** objects uploaded after T have no row (orphans, harmless: list keys not referenced by `MediaAsset`/outputs and delete after review); rows referencing objects deleted after T point at nothing (dangling): detect with `pnpm storage:check`-style head requests on restored `storageKey`s and mark those assets unavailable.
- **Recommendation:** a periodic copy of the bucket to a second bucket/provider (rclone, run by hand or by CI), and delay physical deletion by 24 h so an accidental delete can be undone.

## 5. Migrations
- Prisma applies each migration in one transaction: a failing migration leaves **no partial change** and is recorded as failed. Verified locally: a migration with two statements, the second failing, left no table and blocked later migrations (`P3018`); `prisma migrate resolve --rolled-back <name>`, fixing the file and `migrate deploy` applied it cleanly.
- Forward-only (no down migrations). Recovery order: stop deploy → dump → `migrate resolve` → fix forward → redeploy; if data is damaged, restore (section 2).
- **Risky patterns found in the 23 migrations:** `DROP COLUMN`/`DROP CONSTRAINT` in 3 early migrations (data loss by design, pre-launch only); 11 `ALTER TYPE … ADD VALUE` (irreversible, and the new value cannot be used in the same transaction: keep it in its own migration, as `sales_agent_enums` does). Rule for new migrations: expand, then contract in a later release; never drop in the same release that stops using the column.

## 6. Runbook
| Incident | Detect | Do |
| --- | --- | --- |
| Database outage | `/health/ready` 503 (`database: down`), 5xx | Do not restart in a loop. Check provider status; if the instance is lost restore to a new instance (section 2). API recovers by itself once reachable; workers reconnect. |
| Redis outage | readiness `redis: down`, Operations page "unavailable" | Jobs are not accepted (clean 503 `*_QUEUE_UNAVAILABLE`, nothing charged). Restore Redis (`noeviction`); reconcilers rewake runs, AI, calendar and social work from PostgreSQL within minutes. |
| Worker crash | worker heartbeat stale, backlog grows | Restart the worker; outward steps in `OUTCOME_UNKNOWN` need a person (section 3). |
| Object storage failure | storage `failing` in readiness, upload errors | Uploads fail closed; deletions queue and retry. After recovery run the consistency check (section 4). |
| Failed deployment | readiness fails, error rate | Redeploy the previous image. If a migration ran: forward-fix (section 5); restore only if data is damaged. |
| Accidental deletion | user report, audit log | Restore into a NEW database (section 2), copy the missing rows back with SQL, never replace the live database. Objects: see section 4 (no versioning assumed). |
| Restoration verification | after any restore | Run the checks of `restore-drill.sh` against the restored database; compare key counts with the last known figures; `prisma migrate status`; log in, open a conversation, a calendar entry and a media file. |

## 7. Limitations
Local volumes only (0.3 MB): durations are not representative. No provider PITR, snapshot or R2 behaviour was exercised. Secrets and TLS settings are not part of the backup: keep them in the secret manager with their own recovery.

## 8. Test record (N11, local)
Environment: Docker, `postgres:16` and `redis:7` containers (disposable), Node test runner `jest --runInBand`, no external call.
- Restore drill: `SOURCE_DATABASE_URL=… ADMIN_DATABASE_URL=… infrastructure/scripts/restore-drill.sh` → `DRILL OK` (57 tables identical, 22/22 migrations, 0 invalid constraints/indexes, 0 orphans, dump 0.2 s, restore 0.9 s); a non-local source is refused (exit 2); no `restore_drill_*` database is left behind.
- Migration failure and forward recovery on a disposable database: failure `P3018`, no partial table, `migrate resolve --rolled-back`, fixed file, `migrate deploy` applied.
- Worker and idempotency suites (`jest --config test/jest-e2e.config.js --runInBand test/<name>.e2e-spec.ts`): runs 16/16, workflows 22/22, ai-jobs 28/28, calendar-worker 13/13, social-publishing 54/54, creative-video 29/29, calendar-workflow 6/6, tenant-security 7/7 (152 s in total).
- Not tested: a real worker process kill (the suites simulate interruption through leases, claims and restarts of the services), Redis restart with persisted jobs, R2, provider PITR.
