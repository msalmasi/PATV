# GTF backend: Grand Theft Frogger's records on the site (1.99nq)

Site `gtfstore.js` + bot `pepe_gtfstore.py`. Same model as the casino and the stashes: a switch on each side, a verified
hand-over, Pepe as a client with a local mirror, and a way back. Modules stay redistributable: with the backend off (the
default on prod) Pepe runs exactly as before on his own files.

## What moves, what stays

| Moves to the site (`gtf_records`)                         | Pepe's file          | kind    |
|-----------------------------------------------------------|----------------------|---------|
| Heist sheets: stats, class, heists / busts / loot / cracks / deepest, loadout (items + gear), avatar seed, heat, rings, brawl + arena W/L | `heist_data.json` | `sheet` |
| Duel records (wins / losses / net)                        | `duel_records.json`  | `pvp`   |
| Recent vault cracks                                       | `heist_lore.json`    | `lore` (id `cracks`) |

Stays in Pepe: the heist and invasion **engines** (every roll and outcome), per-job cooldowns, the live heist, the
minimap's last-hit file. Not touched at all: gangs, turf, gang treasuries, money pools.

## Switching on

1. Site: `node tools/gtf-backend.js --actor=<you> on` (staging is on by default via `STAGING`). `node tools/gtf-backend.js`
   prints the state, record counts and totals.
2. Camfrog, as an admin: `!gtf backend on`.
3. Pepe (heartbeat, on a worker): checks `/api/gtf/bot/status`; freezes GTF write commands (`!heist !join !bail !buy
   !allot !reroll !ring !sheet !avatar !duel !brawl !arena !accept !fight !invade !defend`) and waits until no heist,
   arena, raid or fight is running; exports the three files as one canonical JSON payload with a sha256 and totals
   (`sheets, pvp, lore, loot, heists, duel_wins, duel_losses`), stores it in `gtf_client.json` (`migrating`) and posts it
   to `/api/gtf/bot/import`.
4. The site: refuses unless enabled; checks the digest and totals; takes a verified SQLite backup
   (`backups/myapp-pre-gtf-import-*.db`); writes everything in one transaction; re-counts the totals from the tables;
   answers `{ok, totals, backup}`. The same export again answers `already`; a different one is refused (`E_ALREADY`).
5. Pepe switches to `remote` only when the site's totals equal his. A lost answer = stay frozen and re-send the same
   export. A refusal = unfreeze and stay local.

## Client mode

* The files are a **mirror** the engines keep reading (no network on any game or packet path).
* Every save wakes the `gtf-sync` worker: it diffs each record against the hash the site last acknowledged and sends
  only the changes as keyed batches (`/api/gtf/bot/put`, idempotent by key; a lost answer is retried with the same key).
  Crash-safe: what wasn't acknowledged is still different from its hash and goes up after the restart.
* Pulls (`/api/gtf/bot/state`, since a rev) at start and every 5 minutes: a record with no local change pending takes the
  site's copy, applied in place; never while a heist / arena / raid / fight runs.
* The site keeps `cosmetic_avatar_seeds` in step with the sheets (the website's GTF avatars).
* `!gtf backend status` shows where the data lives and how many changes wait to sync.

## The way back to local

* `!gtf backend off` (admin): freeze, wait for the games, flush every pending change, `POST /api/gtf/bot/release`. The site
  marks its copy released (no more writes, the website stops reading it) and answers the full export + sha256 + totals;
  Pepe verifies both, keeps his mirror as `*.pre-local`, writes the export into his three files and is local again.
  The site's rows stay as an archive; the next import replaces them (after a fresh backup).
* `!gtf backend off force`: only when the site lost the data (e.g. a staging DB refresh - Pepe alerts "the site no longer
  owns GTF data" and stops sending). Pepe's mirror becomes the truth again without asking the site.
* Site-side `tools/gtf-backend.js off` only stops new imports; it never takes data away from a live site.

## Endpoints (bot token)

`/api/gtf/bot/status`, `/import`, `/put`, `/state`, `/release`, `/shop-history` (heist-shop spend per login for the
shop achievements' quiet backfill), `/board` (the minimap feed). Public: `GET /api/gtf/board`.

## Heist minimap (/gtf)

Pepe posts the live board about once a minute, and every few seconds while a heist runs (`/api/gtf/bot/board`): for
each job its cooldown end, vault (or the convoy's cargo), minimum vault, heat, buy-in, door DC, prerequisite, last hit
(outcome, amount, crew) and the heist running now. The site cleans it, keeps the latest in `gtf_board`, and `/gtf` draws
it (polls every 15 s, counts down locally, marks it stale after 5 minutes without a report). Display only.
