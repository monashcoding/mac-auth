#!/bin/sh
# Nightly Postgres backup with rotation, using the postgres:16 image's own pg_dump.
# Runs as a long-lived container (no host cron): dumps once on boot, then once a day.
#
# Env (from docker-compose):
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE  - connection
#   BACKUP_KEEP_DAYS                        - how many daily dumps to keep (default 14)
set -eu

BACKUP_DIR=/backups
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

do_backup() {
  ts="$(date +%Y%m%d-%H%M%S)"
  out="$BACKUP_DIR/${PGDATABASE}-${ts}.sql.gz"
  echo "[backup] dumping $PGDATABASE -> $out"
  # -Fp plain SQL piped through gzip so restore is a simple `gunzip | psql`.
  if pg_dump --no-owner --no-privileges | gzip > "$out"; then
    echo "[backup] wrote $out"
  else
    echo "[backup] ERROR: dump failed" >&2
    rm -f "$out"
    return 1
  fi

  # Rotation: delete dumps older than KEEP_DAYS.
  find "$BACKUP_DIR" -name "${PGDATABASE}-*.sql.gz" -type f -mtime "+${KEEP_DAYS}" -print -delete
}

# One dump immediately on boot (satisfies "writes a *.sql.gz on boot"), then daily.
do_backup || true
while true; do
  sleep 86400
  do_backup || true
done
