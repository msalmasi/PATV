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

## Refreshing staging's data

Staging, and staging Pepe (which writes to it), drift from prod over time. On the VPS,
`bash /home/PATV/deploy/refresh-staging-db.sh` replaces staging's database with a fresh copy of
prod's. It keeps the old copy as `myapp.db.previous`.

## DNS

`python deploy/cfdns.py list | set A name ip [--proxied] | delete name` manages publicaccess.tv records. The token is read from `~/.config/cloudflare/publicaccess.token`; never commit it.
