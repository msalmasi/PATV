# PATV deploys

Deploying is a `git push`. The VPS checks GitHub every 2 minutes and deploys new commits itself.

| Branch    | Where                          | Runs                                   |
|-----------|--------------------------------|----------------------------------------|
| `main`    | `/home/PATV` (publicaccess.tv) | all pm2 apps                           |
| `staging` | `/home/PATV-staging` (staging.publicaccess.tv) | the website only (`patv-staging`), its own DB copy |

Test on staging, then promote:

```bash
git push origin staging
git fetch origin && git push origin origin/staging:main
```

## What a deploy does

1. **Check** the new commit in a scratch worktree: `node --check` on the server code, valid `package.json`/lockfiles, no merge-conflict markers. If it fails, the commit never touches the live checkout.
2. **Fast-forward** the live checkout. It refuses when tracked files were hand-edited on the server, or when the branch was force-pushed, and posts a notice once.
3. **`npm ci`** only in folders whose lockfile changed.
4. **Restart only the affected pm2 apps.** Apps that are stopped stay stopped.

   | Changed                                            | Restarts                    |
   |----------------------------------------------------|-----------------------------|
   | `discord-bot/`                                     | discord                     |
   | `discord-bot/userUtils.js`                         | discord, blackjack          |
   | `discordself/`                                     | discordbot                  |
   | `twitchbot/`                                       | twitch, server              |
   | `blackjack/`                                       | blackjack                   |
   | `server.js`                                        | server                      |
   | `dbUtils.js`, `user.controller.js`                 | index, twitch, server       |
   | `public/`, `uploads/`, `deploy/`, docs, `*.md`     | nothing                     |
   | anything else                                      | index                       |

5. **Health check.** The website must answer `/healthz` within 60 s. Every restarted app must then stay up for 30 s without pm2 restarting it.
6. **Roll back on failure.** The updater resets to the previous commit, reinstalls dependencies, restarts the same apps, and marks the commit bad for good. To move on, push a fix; a bad commit is never retried.

GitHub Actions (`.github/workflows/ci.yml`) runs the same syntax checks, plus a clean `npm ci` of every lockfile, on each push.

## On the server

| What               | Where                                                        |
|--------------------|--------------------------------------------------------------|
| Deploy log         | `/var/log/patv-deploy-<instance>.log`                        |
| Config             | `/etc/patv-deploy/<instance>.env` (optional `DISCORD_WEBHOOK` for notices) |
| Bad commits        | `/var/lib/patv-deploy/<instance>/bad-commits`                |
| Timer              | `systemctl list-timers 'patv-update@*'`                      |
| Run a check now    | `systemctl start patv-update@prod`                           |
| Pause deploys      | `systemctl stop patv-update@prod.timer`                      |
| Install or refresh | `bash deploy/install.sh prod staging`                        |

The updater script updates itself when `deploy/` changes. Unit-file changes need `install.sh` to be run again.

pm2 is saved and enabled at boot (`pm2-root.service`). After adding or removing an app, run `pm2 save`.

## WebRTC (WHIP / WHEP / TURN)

MediaMTX and coturn for the stages' ultra-low-latency streaming are installed separately, by hand, with
`deploy/webrtc/install.sh` (undo: `rollback.sh`). See `deploy/webrtc/INSTALL.md`. The site side is behind
the stage setting `webrtc_enabled` (off by default).

## Twitch restream relay (1.99fk)

"Also stream to Twitch" (`restream.js`): streamers save a Twitch key on /stage (encrypted with `RESTREAM_SECRET`,
shown only as ••••last4) and switch it per slot; admins run Pepe's main stream's relay on /stage/admin. The worker
`deploy/restream/patv-restream.js` runs as systemd `patv-restream@prod` / `@staging` (user `patv-restream`), polls
`POST /api/restream/worker/sync` on loopback with `RESTREAM_TOKEN`, and runs one `ffmpeg -c copy` per relay from
nginx-rtmp (loopback) to Twitch. Staging's worker only accepts loopback targets (a test sink), prod's only Twitch.

- Install / update (idempotent, backs up first, never prints secrets): `INST=staging bash /home/PATV-staging/deploy/restream/install.sh`,
  then `INST=prod bash /home/PATV/deploy/restream/install.sh`. It adds `RESTREAM_SECRET` + `RESTREAM_TOKEN` to the site's `.env`.
- A key from a file (e.g. Pepe's, read out of OBS): `cd /home/PATV && node deploy/restream/set-key.js --owner @main --file <0600 file with KEY=/SERVER=> --shred`.
- **Emergency stop of every relay:** `systemctl stop patv-restream@prod` (its ffmpegs die with it). Undo the install: `INST=prod UNINSTALL=1 bash .../install.sh`.
- The stream key is in no process's arguments (1.99gn): ffmpeg only gets the loopback source and writes FLV to a pipe
  (`... -f flv pipe:1`, progress on fd 3); the worker publishes it to Twitch with its own small RTMP client, the key
  only in its memory (from the site over loopback, never argv/env). Before 1.99gn the target URL was an ffmpeg argument
  and `/proc/<pid>/cmdline` showed it to every local account (no hidepid). It never reaches a log either way.
  `RELAY_MODE=argv` in `/etc/patv-restream/<inst>.env` brings the old ffmpeg-pushes-itself mode back (key in argv) as
  an emergency fallback; install.sh warns when any relay ffmpeg still has a target in its arguments.
- Both instances run the ONE installed file `/usr/local/lib/patv-restream/patv-restream.js`: an install restarts only
  its own instance, but the other one picks the new file up on its next restart.

## Refreshing staging's data

Staging, and staging Pepe (which writes to it), drift from prod over time. On the VPS,
`bash /home/PATV/deploy/refresh-staging-db.sh` replaces staging's database with a fresh copy of
prod's. It keeps the old copy as `myapp.db.previous`.

## The database is in WAL mode (1.99fb)

Every connection sets `journal_mode=WAL`, `busy_timeout=5000` and `synchronous=NORMAL` (`sqlitecfg.js`).
WAL mode is stored in the file, so the first start of 1.99fb switches the database for good. Recent commits
sit in `myapp.db-wal` until a checkpoint. The site checkpoints every hour, and `backup-db.js` checkpoints after
the nightly backup.

- **Never copy `myapp.db` by itself** (`cp`, `scp`, `fs.copyFile`): the copy can miss data. Back up through
  SQLite instead: `node backup-db.js --db=... --dir=...` (online backup API, verified), or
  `sqlite3 myapp.db "VACUUM INTO '/path/copy.db'"`, or `sqlite3 myapp.db ".backup '/path/copy.db'"`.
- Don't delete `myapp.db-wal` / `myapp.db-shm` while anything has the database open.
- Read-only inspection is fine: `sqlite3 -readonly myapp.db`.
- Roll back to the old journal: stop the site (`pm2 stop index`, the only app with the database open), revert the WAL line in
  `sqlitecfg.js`, run `sqlite3 /home/PATV/myapp.db "PRAGMA journal_mode=DELETE;"` (it must print `delete`),
  then start the site.

## Database backups (daily, 14-day retention)

Root's crontab runs `/usr/bin/node /home/PATV/backup-db.js` at 03:00 (log: `/home/PATV/backups/backup.log`).
Each run takes a verified copy (online backup API + `integrity_check`), gzips it to `*.gz.part` and renames it into place:

| File | Written | Kept |
|---|---|---|
| `backups/daily/database_backup_daily_YYYY-MM-DD.db.gz` | every night | 14 days; `backup-db.js` prunes older ones **after a successful backup only**, and always keeps the 14 newest |
| `backups/database_backup_YYYY-MM.db.gz` | the month's **first** good backup; never overwritten (re-made if missing or 0 bytes) | 365 days (`/etc/cron.d/patv-backup-prune`) |

- The cron prune uses `find ... -maxdepth 1`, so it never touches `daily/`; the 14-day rule never touches the monthly
  files or anything else in `backups/` (`myapp-pre-*.db` snapshots, `*-keep-*` files).
- It refuses to run (nothing written, nothing pruned, exit 1) with under 2 GB free in the backup folder.
- One log line per run: daily file + size, monthly `created` / `kept` / `replaced 0-byte file`, `pruned=N`, free space.
- Disk use: about 14 x 52 MB dailies + one ~52 MB file per month.
- Options: `--db=PATH` / `--db=staging` (= `/home/PATV-staging/myapp.db`, default `--dir=/root/staging-backups`),
  `--dir=DIR`, `--date=YYYY-MM-DD` (test hook: pretend it's that day), `--name=x.db` (one-off `DIR/x.db.gz` only).
  Try it without touching prod's folder: `/usr/bin/node /home/PATV/backup-db.js --db=staging --dir=/tmp/bk-test`.

### Restoring

1. Pick the file and unpack it somewhere else first:
   `gunzip -c /home/PATV/backups/daily/database_backup_daily_2026-10-08.db.gz > /root/restore.db`
2. Check it: `sqlite3 -readonly /root/restore.db "PRAGMA integrity_check;"` must print `ok`.
3. Keep the current database: `sqlite3 /home/PATV/myapp.db "VACUUM INTO '/home/PATV/backups/myapp-pre-restore-$(date +%Y%m%d-%H%M%S).db'"`.
4. Stop the site: `pm2 stop index` (the only app with the database open).
5. Either
   - copy it into place: `cp /root/restore.db /home/PATV/myapp.db && rm -f /home/PATV/myapp.db-wal /home/PATV/myapp.db-shm`
     (only with the site stopped - a leftover `-wal` from the old database must not be kept), or
   - let SQLite do it: `sqlite3 /home/PATV/myapp.db ".restore '/root/restore.db'"`.
6. `pm2 start index`, check the site, then delete `/root/restore.db`.

## DNS

`python deploy/cfdns.py list | set A name ip [--proxied] | delete name` manages publicaccess.tv records. The token is read from `~/.config/cloudflare/publicaccess.token`; never commit it.
