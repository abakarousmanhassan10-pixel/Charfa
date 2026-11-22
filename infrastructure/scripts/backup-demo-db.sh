#!/usr/bin/env bash
# Backs up the TOUMA demo database (Render Postgres) to a single compressed file.
#
#   DATABASE_URL_EXTERNAL='postgresql://user:password@host/dbname' ./backup-demo-db.sh [output-dir]
#
# - The URL is the "External Database URL" of the database in the Render dashboard (Connect). It is read from the environment, never from an argument,
#   so it does not end up in your shell history or the process list. It is never printed.
# - The backup contains user accounts and password hashes: it is written with mode 600 and REFUSED inside a git repository. Never commit or share it.
set -euo pipefail

: "${DATABASE_URL_EXTERNAL:?Set DATABASE_URL_EXTERNAL to the External Database URL (Render dashboard > database > Connect)}"
out_dir="${1:-$HOME/touma-backups}"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
if git -C "$out_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Refusing to write a database backup inside a git repository ($out_dir). Choose a folder outside any repository." >&2
  exit 1
fi
command -v pg_dump >/dev/null || { echo "pg_dump is not installed (install the PostgreSQL 16 client tools)." >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out_dir/touma-demo-$stamp.dump"
umask 077
# Custom format: compressed, restorable selectively with pg_restore. No owners or grants: the new database has its own user.
pg_dump --format=custom --no-owner --no-acl --file="$file" "$DATABASE_URL_EXTERNAL"
chmod 600 "$file"

# A backup that cannot be read back is not a backup: list its contents.
tables="$(pg_restore --list "$file" | grep -c ' TABLE DATA ' || true)"
echo "Backup written: $file ($(du -h "$file" | cut -f1), $tables tables with data)"
echo "Keep it private. Restore it with restore-demo-db.sh."
