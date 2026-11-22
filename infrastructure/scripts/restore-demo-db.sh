#!/usr/bin/env bash
# Restores a backup made by backup-demo-db.sh into a NEW, EMPTY database.
#
#   TARGET_DATABASE_URL='postgresql://user:password@host/dbname' ./restore-demo-db.sh path/to/touma-demo-<stamp>.dump
#
# Use the External Database URL of the new database. Refuses to run on a database that already has TOUMA tables unless FORCE=1 (it would be overwritten).
set -euo pipefail

: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the External Database URL of the NEW database}"
file="${1:?Give the path of the .dump file}"
[ -r "$file" ] || { echo "Cannot read $file" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is not installed (install the PostgreSQL 16 client tools)." >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is not installed." >&2; exit 1; }

existing="$(psql "$TARGET_DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name in ('User','Business')")"
if [ "$existing" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "The target database already contains TOUMA tables. Use an empty database, or set FORCE=1 to overwrite it." >&2
  exit 1
fi
pg_restore --no-owner --no-acl --clean --if-exists --exit-on-error --dbname="$TARGET_DATABASE_URL" "$file"
users="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from "User"')"
migs="$(psql "$TARGET_DATABASE_URL" -Atc 'select count(*) from _prisma_migrations')"
echo "Restored: $users user(s), $migs migrations recorded. Now point touma-api at the new database (DATABASE_URL) and redeploy."
