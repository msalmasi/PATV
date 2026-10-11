# Lotto cutover runbook: Pepe → backend

The design is in `docs/lotto-backend.md`. Run this **between draws only**: after a Sunday 21:00 ET draw has finished and every one of its payouts has settled, and at least 10 minutes before the next draw's sales close. Pepe refuses otherwise.

The first prod run is planned for **after the Sun 2026-10-11 draw**: draw #2 at ~7,675 tickets with a ~21M jackpot. That draw runs on Pepe as usual. The code ships dark: the site's `lotto_backend` is OFF and no Pepe has `lotto_client.json`.

## 0. Preconditions

1. The code is on prod: site ≥ 1.99ml and bot ≥ 1.99mm.
   - On the site, `curl -s https://publicaccess.tv/api/lotto/state` returns `{"ok":true,"enabled":false,...}`.
   - On the bot, `!version` shows 1.99mm or later.
2. **The last draw is finished.**
   - Pepe's console (`C:\PATV\pepe-console.log`) shows the `[LOTTO]` draw line and no `will retry` after it.
   - `!lotto results` shows the new draw.
   - `!lotto backend export` reports *ready*: no draw paying, no held tickets, no escrow holds in flight, and the route is 100% House.
3. **The reseed is done**, if there was a jackpot hit. The console shows `[LOTTO] v2 reseed draw #N: ...` (or the v1 Reserve reseed), and `!vault` shows the lotto pot back at about 1M.
4. Nobody is mid-purchase. Pick a quiet moment: the freeze only takes a few seconds, but a `!lotto` sent during it gets "moving to publicaccess.tv".

## 1. Backups

**Site DB** (on the VPS). A plain copy is not a backup with WAL, so use `.backup`:

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-lotto-cutover-$TS.db"
```

**Pepe's files** (on the prod VM, PowerShell):

```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\lotto-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\lotto.json, C:\PATV\camfrog-bot\turf_data.json, C:\PATV\camfrog-bot\escrow.json, C:\PATV\camfrog-bot\vaults.json $d
```

## 2. Record the "before" numbers

**Pepe:** run `!lotto backend export`, or write `{"action":"dryrun"}` to `C:\PATV\lotto-cutover.request.json` and read `C:\PATV\lotto-cutover.result.json` about 30 s later. Write down:
- the draw number;
- `next_at` (it must be next Sunday 21:00 ET);
- tickets;
- players;
- pot;
- history count.

**Site:** run `cd /home/PATV && node tools/lotto-admin.js`. It must show no draws, `pot = 0` and `lotto_backend = false`. If it shows anything else (a leftover from a test), stop.

## 3. Cutover

This step is one command. Use either:
- `!lotto backend cutover confirm` (an admin, in any room), or
- the request file `{"action":"cutover","actor":"<who>"}` in `C:\PATV\lotto-cutover.request.json`.

Pepe then does the following:
1. **Freezes** his lotto. No local sales or draws from here.
2. **Exports it again** under the freeze: tickets with their PATV usernames, the pot, the draw, `next_at`, the history (≤ 60 draws), price and pot share. A copy is kept as `lotto_export_<key>.json`.
3. **Journals** `cutover_pending {key, pot}` in `lotto_client.json`.
4. **POSTs `/api/lotto/admin/import`** with `enable: true`.
   - The site refuses unless the lotto is empty. It maps every username to an account and writes the draw (with a fresh commitment), the tickets, the pot (`import:<key>`) and the history.
   - It recomputes the totals and compares them with the export's own. On a mismatch it deletes everything it wrote and answers `ok:false`.
   - Only when the totals match does it turn `lotto_backend` on.
5. **Compares** the site's totals with his own: tickets, players, per player, pot, history, draw and `next_at`.
6. **Drains his local pot** with one keyed leg (`lotto-cutover-<key>:out`).
7. **Switches his client on**: `lotto_client.json` `on: true`.

The answer reads "DONE … totals matched". The request-file result has `"ok": true, "result": {"match": true, ...}`.

## 4. Verify (read-only first)

1. **Site:** `node tools/lotto-admin.js`.
   - `lotto_backend = true`.
   - `draw #N selling`, with `next_at` = next Sunday 01:00 UTC (EDT) or 02:00 UTC (EST).
   - `sold` = the ticket count, and `pot` = the pot from step 2.
   - `history rows` = the history count.
2. **Per player:** `node tools/lotto-admin.js totals > /tmp/site-totals.json`. Compare it with the export's `totals.per_user` (`lotto_export_<key>.json` on the VM). Every username and count must be equal.
3. **Pepe:**
   - `!lotto backend status` says "runs on publicaccess.tv", with the same draw, tickets and pot, and the site switch ON.
   - `!vault` shows the lotto pot = the site's pot.
   - `turf_data.json` `vaults.lotto` = 0.
4. **Page:** <https://publicaccess.tv/lotto> shows the same jackpot, the draw number, your tickets and a "Provably fair" commitment line. `/lotto/fair/<N>` shows the commitment, with the seed still secret.
5. **Supply:** `/api/stats/supply` total is unchanged within the 5-minute snapshot lag, and the `vault:lotto` row equals the site's pot.
6. **Optional live check** (the user or the main session decides; it costs PAT 1,000 of the admin's own money):
   - `!lotto quick 1` from an admin account in a room;
   - one web quick pick on `/lotto`.
   
   Each must reply with "you hold N ticket(s)", and the pot must grow by 400 each time.

## 5. Rollback (any time between draws)

Use either `!lotto backend rollback confirm`, or the request file `{"action":"rollback","actor":"<who>"}`. Pepe then:
1. switches the site's `lotto_backend` OFF, so web sales stop;
2. exports the backend state; this is refused while a draw is paying or a purchase is in flight;
3. moves the pot back with keyed legs (`rollback-<key>` on the site, `lotto-rollback-<key>:in` locally). The amount is journaled, so a retry with the same key is exact;
4. restores `lotto.json` (draw, `next_at`, tickets, history) and switches his client off.

After a rollback, the site still holds the imported rows (switch off, pot 0). A later re-import is refused until the backend lotto is reset. That needs a hand-written DELETE on prod: `tools/lotto-admin.js reset` is staging-only by design. **Ask before doing it.**

**If the cutover fails half-way:**
- **"NOT matched" and nothing changed** (the site answered `ok:false`): nothing to do. Pepe is unfrozen and still runs the lotto.
- **The site didn't answer:** Pepe stays FROZEN with `cutover_pending`. Run the cutover again; it reuses the same key, so the site replays its stored result.
- **The site imported but the totals differ:** Pepe stays frozen.
  1. Switch the site off: `node tools/lotto-admin.js --actor=<who> lotto_backend=0`.
  2. Restore the site DB from step 1's backup (or delete the `lotto_*` rows), then unfreeze Pepe by hand: remove `frozen` from `lotto.json`, remove `cutover_pending` from `lotto_client.json`, and restart Pepe.
  3. Report it.
- **The pot was imported but the local pot couldn't be drained** (a logged error): move it by hand with `!econ` / an admin vault adjust from `lotto` to 0. There is no double payout risk: no draw runs locally after the cutover.

## 6. Staging rehearsal

This was done on 2026-10-11; results are in the agent report.
- PepeBeta (VM 111) and staging.publicaccess.tv.
- The same steps, with the practice lotto in PepeLab.
- Then a forced draw (`!lotto draw` as an admin, or `{"nick":..,"room":"PepeBeta.Room","text":"!lotto draw"}` in `C:\PATV\lotto-inject.jsonl` on staging) to check the whole path: sales, close, digest, numbers, payouts, the announcement and the overlay event, plus the reseed after a jackpot.
