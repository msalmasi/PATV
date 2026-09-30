# PATV backend (publicaccess.tv)

Node/Express (`index.js`) with SQLite, run by pm2 on a VPS alongside the Discord, Twitch and
blackjack bots.

- **Deploying:** read `deploy/README.md`. Deploy is `git push`: `staging` goes to
  staging.publicaccess.tv, then promote with `git fetch origin && git push origin origin/staging:main`.
  The server deploys itself, with a health check and automatic rollback. Never edit files on the
  server.
- **This repo is public.** Don't commit secrets, `.env`, database files or internal addresses.
- **Machine setup, credentials and working rules:** `camfrog-bot/docs/REMOTE-DEV.md`, in the
  private Pepe repo nested in this folder. If `camfrog-bot/` is missing, clone
  `msalmasi/camfrog-bot` into it.
- **Bot-only routes** check `isBotToken()`. Ship bot-side changes to prod before the backend starts
  requiring them.
