#!/usr/bin/env bash
# Starts a local clamd (127.0.0.1:3310) loaded with the EICAR test signatures only. For tests/CI.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="${TMPDIR:-/tmp}/touma-clamd"
mkdir -p "$RUN/db"
cp "$DIR"/test-signatures/* "$RUN/db/"
cat > "$RUN/clamd.conf" <<CONF
DatabaseDirectory $RUN/db
TCPSocket 3310
TCPAddr 127.0.0.1
Foreground no
LogFile $RUN/clamd.log
PidFile $RUN/clamd.pid
StreamMaxLength 300M
MaxFileSize 300M
MaxScanSize 300M
User $(id -un)
CONF
clamd --config-file="$RUN/clamd.conf"
for i in $(seq 1 30); do
  if printf 'zPING\0' | timeout 2 nc -q1 127.0.0.1 3310 2>/dev/null | tr -d '\0' | grep -q PONG; then echo "clamd ready"; exit 0; fi
  sleep 1
done
echo "clamd did not start" >&2; exit 1
