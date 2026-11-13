#!/usr/bin/env bash
# Restore drill: dump a SOURCE database, restore it into a NEW disposable database on a LOCAL server, verify it, drop it.
#
# SAFETY: both servers must be local (localhost / 127.0.0.1). The target is always a new database named restore_drill_*;
# the script refuses to touch an existing database, never writes to the source (read-only dump) and drops only the
# database it created. Never point it at production: run production restores by hand, from the runbook.
#
# Usage: SOURCE_DATABASE_URL=postgresql://u:p@localhost:5432/touma_test ADMIN_DATABASE_URL=postgresql://u:p@localhost:5432/postgres \
#        infrastructure/scripts/restore-drill.sh [--keep]
set -euo pipefail

SRC="${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL}"
ADMIN="${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (a local server, any database)}"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1

host_of() { echo "$1" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#'; }
for u in "$SRC" "$ADMIN"; do
  case "$(host_of "$u")" in localhost|127.0.0.1) ;; *) echo "REFUSED: only local servers are allowed (got $(host_of "$u"))" >&2; exit 2 ;; esac
done

NAME="restore_drill_$(date -u +%Y%m%d%H%M%S)"
TARGET="$(echo "$ADMIN" | sed -E "s#/[^/?]*(\?|$)#/${NAME}\1#")"
case "$NAME" in restore_drill_*) ;; *) echo "REFUSED: bad target name" >&2; exit 2 ;; esac
DUMP="$(mktemp)"; chmod 600 "$DUMP"
cleanup() { rm -f "$DUMP" 2>/dev/null || : > "$DUMP"; if [ "$KEEP" = 0 ]; then psql "$ADMIN" -qc "DROP DATABASE IF EXISTS \"$NAME\"" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

now() { date +%s.%N; }
counts() { # exact row count of every table in the public schema, sorted
  local q; q=$(psql "$1" -At -c "select string_agg(format('select %L as t, count(*) as n from %I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname='public'")
  psql "$1" -At -F'|' -c "select t, n from ($q) x order by t"
}

t0=$(now)
pg_dump "$SRC" -Fc --no-owner --no-privileges -f "$DUMP"
t1=$(now)
psql "$ADMIN" -qc "CREATE DATABASE \"$NAME\"" >/dev/null
pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET" "$DUMP"
t2=$(now)

counts "$SRC" > "$DUMP.src"; counts "$TARGET" > "$DUMP.dst"
status=0
if diff -q "$DUMP.src" "$DUMP.dst" >/dev/null; then echo "rows: identical in $(wc -l < "$DUMP.src") tables"; else echo "rows: DIFFERENT"; diff "$DUMP.src" "$DUMP.dst" || true; status=1; fi
bad=$(psql "$TARGET" -At -c "select count(*) from pg_constraint where not convalidated")
mig=$(psql "$TARGET" -At -c "select count(*) filter (where finished_at is not null and rolled_back_at is null) || '/' || count(*) from _prisma_migrations")
invalid=$(psql "$TARGET" -At -c "select count(*) from pg_index where not indisvalid")
orphans=$(psql "$TARGET" -At -c "select count(*) from \"CalendarEvent\" e where e.\"contentId\" is not null and not exists (select 1 from \"Content\" c where c.id = e.\"contentId\")")
echo "unvalidated constraints: $bad | migrations finished: $mig | invalid indexes: $invalid | calendar events without content: $orphans"
[ "$bad" = 0 ] && [ "$invalid" = 0 ] && [ "$orphans" = 0 ] || status=1
rm -f "$DUMP.src" "$DUMP.dst"
printf 'dump %.1fs | restore %.1fs | dump size %s bytes\n' "$(echo "$t1 - $t0" | bc)" "$(echo "$t2 - $t1" | bc)" "$(stat -c %s "$DUMP")"
[ "$KEEP" = 1 ] && echo "kept database: $NAME"
[ "$status" = 0 ] && echo "DRILL OK" || echo "DRILL FAILED"
exit "$status"
