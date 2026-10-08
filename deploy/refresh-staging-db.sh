#!/usr/bin/env bash
# Replace the staging site's database with a fresh copy of prod's.
#
# Staging (and staging Pepe, which writes to it) drifts from prod over time: balances, new users,
# renames. Run this to start clean. Everything staging did is discarded; the copy it replaces is
# kept as myapp.db.previous (one generation) in case you need something back.
#
#   bash /home/PATV/deploy/refresh-staging-db.sh
set -euo pipefail
export HOME=/root NVM_DIR=/root/.nvm
set +u; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use --silent 20 >/dev/null; set -u

S=/home/PATV-staging
[ -f "$S/myapp.db" ] || { echo "no staging checkout at $S"; exit 1; }

# Take the copy first, while staging still runs. 1.99fb: prod's DB is in WAL mode (recent commits sit in myapp.db-wal),
# so copy it through SQLite - VACUUM INTO is one consistent read (a busy prod can't restart it the way it can restart a
# page-by-page .backup), waits up to 30 s for a lock, and writes a single self-contained file. Never copy the file itself.
rm -f "$S/myapp.db.new" "$S/myapp.db.new-wal" "$S/myapp.db.new-shm"
sqlite3 -cmd ".timeout 30000" /home/PATV/myapp.db "VACUUM INTO '$S/myapp.db.new';"
[ "$(sqlite3 "$S/myapp.db.new" 'PRAGMA integrity_check;')" = "ok" ] || { echo "the copy failed integrity_check - staging untouched"; rm -f "$S/myapp.db.new"; exit 1; }
echo "prod copied: $(du -h "$S/myapp.db.new" | cut -f1), $(sqlite3 "$S/myapp.db.new" 'select count(*) from users') users"

pm2 stop patv-staging >/dev/null
# fold staging's own WAL into its file before it's kept as .previous (its -wal / -shm are deleted below)
sqlite3 -cmd ".timeout 10000" "$S/myapp.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
mv -f "$S/myapp.db" "$S/myapp.db.previous"
rm -f "$S/myapp.db-wal" "$S/myapp.db-shm" "$S/myapp.db.previous-wal" "$S/myapp.db.previous-shm"
mv "$S/myapp.db.new" "$S/myapp.db"
pm2 start patv-staging >/dev/null

for i in $(seq 1 20); do
  if curl -fsS -m 3 http://127.0.0.1:3100/healthz | grep -q '"ok":true'; then
    echo "staging is back up on the fresh copy"; exit 0
  fi
  sleep 1
done
echo "staging didn't come back healthy - the old DB is $S/myapp.db.previous"; exit 1
