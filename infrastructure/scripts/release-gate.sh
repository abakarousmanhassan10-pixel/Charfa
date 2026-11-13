#!/usr/bin/env bash
# Release gate: reproducible local checks that decide whether a build may go to staging.
# BLOCKER = the gate fails (exit 1). WARN = reported, never fails. SKIP = could not run (reported as not verified).
# Usage:  infrastructure/scripts/release-gate.sh [--with-build] [--with-tests]
# Optional environment:
#   BASE_REF            git ref to diff new migrations against (e.g. origin/main); without it the migration rule is skipped
#   ADMIN_DATABASE_URL  local PostgreSQL server (any database) used for the migration check and the restore drill (never a remote server)
#   SOURCE_DATABASE_URL local database to dump for the restore drill (default: the migration check database)
#   API_URL / WORKER_HEALTH_URL  running API and worker to probe (/api/v1/health, /api/v1/health/ready, /health)
# Writes .release-gate/report.md. No secret is printed: scans report file names and rule names only.
set -uo pipefail
cd "$(dirname "$0")/../.."
WITH_BUILD=0; WITH_TESTS=0
for a in "$@"; do case "$a" in --with-build) WITH_BUILD=1;; --with-tests) WITH_TESTS=1;; esac; done
mkdir -p .release-gate; REPORT=.release-gate/report.md
{ echo "# Release gate report"; echo; echo "Commit: $(git rev-parse --short HEAD) | $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo; echo "| Result | Level | Check | Detail |"; echo "| --- | --- | --- | --- |"; } > "$REPORT"
FAILS=0
row() { echo "| $1 | $2 | $3 | $4 |" >> "$REPORT"; echo "[$1] ($2) $3 - $4"; [ "$1" = FAIL ] && [ "$2" = BLOCKER ] && FAILS=$((FAILS+1)); return 0; }
check() { # check <BLOCKER|WARN> <name> <command...>
  local level=$1 name=$2; shift 2
  if out=$("$@" 2>&1); then row PASS "$level" "$name" "ok"; else row FAIL "$level" "$name" "$(echo "$out" | tail -2 | tr '\n|' '  ' | cut -c1-160)"; fi
}

# 1. Types and lint
check BLOCKER "typecheck api" bash -c 'cd apps/api && npx tsc --noEmit'
check BLOCKER "typecheck web" bash -c 'cd apps/web && npx tsc --noEmit'
check BLOCKER "lint (0 warnings)" npx eslint . --max-warnings=0

# 2. Secrets in tracked files (rule names only; tests, docs and *.example files are scanned for real key shapes too)
secret_scan() {
  local hits=0 f
  for rule in 'AKIA[0-9A-Z]{16}' '-----BEGIN [A-Z ]*PRIVATE KEY-----' 'sk-[A-Za-z0-9]{32,}' 'xox[baprs]-[A-Za-z0-9-]{10,}' 'gh[pousr]_[A-Za-z0-9]{30,}' 'AIza[0-9A-Za-z_-]{35}'; do
    f=$(git ls-files -z | xargs -0 grep -lE -- "$rule" 2>/dev/null | head -3 | tr '\n' ' ')
    [ -n "$f" ] && { echo "pattern '$rule' in: $f"; hits=1; }
  done
  f=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.example$' | tr '\n' ' ')
  [ -n "$f" ] && { echo "tracked env file: $f"; hits=1; }
  return $hits
}
check BLOCKER "no secrets in tracked files" secret_scan

# 3. Chat token exposure and public endpoints
chat_token() {
  ! grep -nE "messages\?token=|data\?token=|[?&]token=\\$\{" apps/web/app/chat 2>/dev/null &&
  ! grep -nE "@Query\(\)? ?[a-z]*: ?PublicPollDto|@Query\('token'\)" apps/api/src/sales/*.ts
}
check BLOCKER "chat token never in a URL" chat_token
public_endpoints() { diff <(grep -rl "@Public()" apps/api/src --include=*.ts | sort) infrastructure/scripts/public-endpoints.allowlist; }
check BLOCKER "no new public endpoint outside the reviewed list" public_endpoints
check WARN "no console.log in API source" bash -c '! grep -rn "console\.log" apps/api/src --include=*.ts | grep -v spec | grep -v "ai-worker.ts\|main.ts\|storage-check\|live-verify"'

# 4. Dependency vulnerabilities (high and critical block; needs the registry)
audit() { local j; j=$(timeout 90 pnpm audit --prod --json 2>/dev/null) || true; [ -z "$j" ] && { echo "registry unreachable"; return 99; }
  echo "$j" | python3 -c "import json,sys; d=json.load(sys.stdin)['metadata']['vulnerabilities']; print('high',d['high'],'critical',d['critical'],'moderate',d['moderate']); sys.exit(1 if d['high']+d['critical'] else 0)"; }
out=$(audit 2>&1); rc=$?
if [ $rc = 0 ]; then row PASS BLOCKER "dependency audit (prod, high/critical)" "$out"; elif [ $rc = 99 ]; then row SKIP BLOCKER "dependency audit" "not verified: $out"; else row FAIL BLOCKER "dependency audit (prod, high/critical)" "$out"; fi

# 5. Migration safety on a disposable local database
if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  host=$(echo "$ADMIN_DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#')
  case "$host" in localhost|127.0.0.1)
    DB="gate_mig_$(date +%s)"; U=$(echo "$ADMIN_DATABASE_URL" | sed -E "s#/[^/?]*(\?|$)#/$DB\1#"); PU="$U"; case "$PU" in *schema=*) ;; *\?*) PU="$PU&schema=public";; *) PU="$PU?schema=public";; esac
    SU=$(echo "$ADMIN_DATABASE_URL" | sed -E "s#/[^/?]*(\?|$)#/${DB}_shadow\1#")  # the shadow database must be another database: prisma wipes it
    psql "$ADMIN_DATABASE_URL" -qc "CREATE DATABASE \"$DB\"" -c "CREATE DATABASE \"${DB}_shadow\"" >/dev/null 2>&1
    check BLOCKER "migrations apply on an empty database" bash -c "cd packages/database && DATABASE_URL='$PU' npx prisma migrate deploy"
    check BLOCKER "migrations match the schema (no drift)" bash -c "cd packages/database && DATABASE_URL='$PU' npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url '$SU' --exit-code"
    if [ -n "${SOURCE_DATABASE_URL:-$U}" ]; then SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-$U}" check BLOCKER "backup and restore drill" infrastructure/scripts/restore-drill.sh; fi
    psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS \"$DB\"" -c "DROP DATABASE IF EXISTS \"${DB}_shadow\"" >/dev/null 2>&1 ;;
  *) row SKIP BLOCKER "migration check" "refused: ADMIN_DATABASE_URL must be local ($host)";; esac
else row SKIP BLOCKER "migration check and restore drill" "not verified: set ADMIN_DATABASE_URL (local PostgreSQL)"; fi
if [ -n "${BASE_REF:-}" ]; then
  risky() { git diff --name-only "$BASE_REF"...HEAD -- 'packages/database/prisma/migrations/*/migration.sql' | while read -r f; do [ -f "$f" ] && grep -nHiE "DROP (TABLE|COLUMN)|ALTER TYPE .* RENAME|TRUNCATE|DELETE FROM" "$f" | grep -v "release-gate: allow"; done | grep . && return 1 || return 0; }
  check BLOCKER "new migrations have no destructive statement (or are marked allow)" risky
else row SKIP BLOCKER "destructive migration rule" "not verified: set BASE_REF"; fi

# 6. Health of a running stack
if [ -n "${API_URL:-}" ]; then
  check BLOCKER "API liveness" curl -fsS "$API_URL/api/v1/health"
  check BLOCKER "API readiness (database, Redis)" curl -fsS "$API_URL/api/v1/health/ready"
  [ -n "${WORKER_HEALTH_URL:-}" ] && check BLOCKER "AI worker health" curl -fsS "$WORKER_HEALTH_URL/health"
else row SKIP BLOCKER "API and worker health" "not verified: set API_URL (and WORKER_HEALTH_URL)"; fi

# 7. Optional heavy gates
[ $WITH_BUILD = 1 ] && check BLOCKER "build (API_URL baked for the web)" bash -c 'API_URL=${API_URL:-http://localhost:4100} pnpm build'
if [ $WITH_TESTS = 1 ]; then
  check BLOCKER "API unit tests" bash -c 'cd apps/api && npx jest'
  for s in auth hardening tenant-security log-safety runs workflows calendar-workflow sales-assist ops integration; do
    check BLOCKER "e2e $s" bash -c "cd apps/api && npx jest --config test/jest-e2e.config.js --runInBand test/$s.e2e-spec.ts"
  done
else row SKIP BLOCKER "security and integration tests" "not run (use --with-tests with a local database)"; fi

echo >> "$REPORT"; if [ $FAILS = 0 ]; then echo "**GATE: PASS** (SKIP rows are not verified)" >> "$REPORT"; else echo "**GATE: FAIL** ($FAILS blocker(s))" >> "$REPORT"; fi
tail -1 "$REPORT"; [ $FAILS = 0 ]
