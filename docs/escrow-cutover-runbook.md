# Escrow cutover runbook: Pepe → backend (Phase 2)

The design is `docs/backend-migration-audit.md` §5.8 and §6 Phase 2. The code:
- **site** `escrow/ledger.js` (the escrow ledger), `escrow/games.js` (the game-engine host and its transport to Pepe),
  `escrow/wagers.js`, `escrow/bounties.js`, `escrow/pools.js`, `escrow/loans.js` (the engines), `tools/escrow-backend.js`;
- **bot** `pepe_escrowstore.py` (the ledger client), `pepe_escrowgames.py` (the game client), and the remote branches in
  `pepe_wager.py`, `pepe_bounty.py`, `pepe_market.py` (pool model), `pepe_loan.py` (P2P loans).

It moves in two layers, each behind its own explicit switch:

1. **The escrow ledger.** Every escrowed stake in Pepe's `escrow.json` - wager stakes, bounty pots, pool bets, loan principal and
   repayments, donations, mic-challenge head-to-head stakes, bingo cards, duel / brawl stakes, lotto buys, DJ shout-outs,
   cosmetic listings, room-vault deposits - becomes a row in `escrow_holds`. A hold, refund, settle or grant is then ONE keyed
   site transaction: the wallet row, the hold row(s), the fee legs into the site's pools / the House, and the move row. The games
   that stay in Pepe (bingo, duels / brawls, mic challenges, donations, shout-outs, cosmetics, room-vault deposits, a local lotto)
   keep their engines; only their money moves.
2. **The game engines**, one switch each, on top of the ledger: **wagers**, **bounties** (Pepe stays the evidence verifier),
   **parimutuel pools** (`!pool`; LMSR markets stay in Pepe until Phase 3), **P2P loans** (Federal Reserve loans stay in Pepe
   until Phase 3). The site then owns the records, the stakes and the deadlines, and runs the website's forms itself. Pepe parses
   the chat verbs, makes one keyed call per verb, and announces from the site's events in the same words as before.

**What does not change:** amounts and destinations. The engines use Pepe's exact arithmetic; every fee is split by the PAT
Routing table's shares, which Pepe publishes to the site (`/api/escrow/bot/fee-plans`, re-sent when they change).

**The rule:** local storage only while a switch is **explicitly** off (or no site is configured). With a switch on and the site
down, Pepe never writes diverging local escrow state:
- a hold is refused ("the escrow bank isn't answering - try again, nothing moved"); a hold whose answer was lost is looked up
  by its key and refunded if it landed;
- a refund / settle / grant of PAT already in escrow is queued in the outbox (`escrow_client.json`) and sent in order under its
  key - the mirror shows it as done (the local path's "recorded, payout pending");
- a site game's verb says "<game> live on publicaccess.tv, which isn't answering - try again (nothing moved)";
- nothing auto-falls-back. The only ways back are an admin **rollback** (the site answers) or **detach** (the site is gone).

**Retired while the site owns them** (the code stays for the local / plugin path and comes back with a rollback):
- the `bounty_actions` queue (`/bounties/:id/:kind` runs on the bounty engine; `/api/bounties/actions/claim` hands out nothing);
- `market_orders` for **pool** bets (LMSR orders keep the queue until Phase 3);
- the `/act` action-queue kinds `cmd=wager`, `cmd=bounty`, `cmd=pool`, `cmd=loan` (P2P verbs): `actions.js` hands them to
  `escrow/games.fromForm`, nothing is queued for Pepe;
- the mirrors pushed by Pepe: `/api/wagers/sync`, `/api/bounties/sync`, the pool rows of `/api/markets/sync`, the P2P loans of
  `/api/wallet/loans` - the engines write those display rows themselves.

## 0. Order and when

- **Phase 1 first.** The ledger cutover refuses until the pools live on the site (`pools_meta.live`): a settle's fee legs and a
  grant's pool debit are booked into the site's pools in the same transaction. Pepe's dry run says so too.
- Then the **ledger**, then the games one at a time in this order: **wagers → bounties → pools → loans**. Each game can wait;
  a game left local keeps working on top of the site's ledger.
- **Never** within 20 minutes of 04:00 UTC (the monetary tick / Monday epoch) or during the Sunday 21:00 ET lotto draw.
- A quiet hour: the freeze is seconds, but a game in the middle of a step (a wager being accepted / settled, a bounty paying, a
  pool settling, a loan repayment) makes the export refuse - just run it again.
- Deploy order: site first, then bot. Both must be ≥ 1.99ou.

## 1. Preconditions

1. Code on prod: site ≥ 1.99ou (`curl -s https://publicaccess.tv/healthz`), bot ≥ 1.99ou (`!version`).
2. Pools live: `!econ pools backend status` says "live on publicaccess.tv".
3. Switches still off:
   - Pepe: `!escrow backend status` says "the escrow lives on Pepe (local)" and "all games local".
   - Site (read-only): `cd /home/PATV && node tools/escrow-backend.js` shows `enabled=false live=false` for the ledger and every
     game.
4. Nothing stuck: `!escrow backend export` (the dry run) answers **ready**. It refuses on: a hold mid-charge, a hold with no PATV
   account recorded, a record mid-step, the pools still local, no site configured.

## 2. Backups

**Site DB** (on the VPS). Use SQLite, never `cp`:

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-escrow-cutover-$TS.db"
```

The import also takes its own verified backup (`dbbackup.backupDb("pre-escrow-import")`), and so does a rollback.

**Pepe's files** (prod VM, PowerShell):

```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\escrow-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\escrow.json, C:\PATV\camfrog-bot\wagers.json, C:\PATV\camfrog-bot\bounties.json, C:\PATV\camfrog-bot\loans.json, C:\PATV\camfrog-bot\markets.json $d
```

## 3. Record the "before" numbers

1. **Pepe:** `{"action":"dryrun"}` in `C:\PATV\escrow-cutover.request.json`; read `C:\PATV\escrow-cutover.result.json` ~30 s
   later. Write down `holds`, `sum` and `per_kind`. (Or `!escrow backend export`.)
2. **Supply:** `curl -s https://publicaccess.tv/api/stats/supply | jq '.total, (.pools[] | select(.key|startswith("escrow")))'`.
   Since 1.99ou Pepe pushes two escrow rows: `escrow:holds` (the held stakes) and `escrow` (his payout queue).
3. **Site:** `node tools/escrow-backend.js` - `held 0 hold(s)`.

## 4. Switch the site on (the ledger)

```
cd /home/PATV && node tools/escrow-backend.js --actor=<who> on
```

**This writes to prod: the user's explicit go is needed.** It only lets Pepe import; nothing moves yet.

## 5. The ledger cutover

Run `!escrow backend cutover confirm` (an admin, in any room) or `{"action":"cutover","actor":"<who>"}` in
`C:\PATV\escrow-cutover.request.json`. Pepe then:

1. **Closes the escrow gate**: no hold / refund / settle / grant starts; one in flight finishes first (30 s max). The games say
   "the escrow is being moved right now - try again in a minute".
2. **Exports** every held hold (id, ref, PATV account, Camfrog name, amount) and his sequence, with his fresh supply rows,
   sha256 and totals (`sum`, `count`, `per_kind`: W / BT / M / L / B / X / DN / ...). Kept as `escrow_export_<key>.json`;
   `cutover_pending` is journaled in `escrow_client.json` (a crash re-sends the same export under the same key).
3. **POSTs** `/api/escrow/admin/import`. The site checks the switch, the pools (live), the digest, the totals per kind, that every
   account exists, that the table holds nothing, and Pepe's `escrow:holds` supply row against the export. It takes a verified
   backup. Then in **one transaction**: Pepe's supply rows become the snapshot, the supply total is read, the holds are written,
   re-read and compared (sum, count, per kind), `live` goes on, and the supply total is read again - it must match **to the PAT**
   or the whole import rolls back (`ok:false`, nothing kept). The same key again answers the stored result.
4. **Flips**: the exported holds become site holds in his mirror (`escrow.json` "holds" is the mirror from now on),
   `escrow_client.json` `on: true`, the gate reopens, his fee plans are pushed.

The answer reads "DONE ... totals matched"; the result file has `"ok": true, "result": {"match": true}`.

Pending payouts in Pepe's queue (a market win, a refund already decided) are not holds: they stay in his queue, keyed, and keep
paying as before. They stay in his `escrow` supply row.

## 6. Verify the ledger (read-only)

1. **Site:** `node tools/escrow-backend.js` → `live=true`, `held` = the dry run's `count` / `sum` / `per_kind`, the same sha256 as
   the import answer.
2. **Supply:** `/api/stats/supply` `total` unchanged (wallet activity in between moves it by exactly that activity); the
   `escrow:holds` row now comes from the table.
3. **Pepe:** `!escrow backend status` says "lives on publicaccess.tv" with the same count and sum; `!bounties`, `!wagers`,
   `!loans` read as before.
4. **One live money path** (optional, costs the admin's own PAT): `!donate casino 100` → an `escrow_moves` row `hold:h<n>` and
   one `settle:h<n>` a moment later, the Casino vault +100 in `pools`, no `escrow_holds` row left held.

## 7. The game cutovers (one at a time: wagers → bounties → pools → loans)

For each game `<g>`:

1. Site: `node tools/escrow-backend.js --actor=<who> on <g>` (**prod write - the user's go**).
2. Pepe: `!escrow backend <g> export` (dry run: live records, PAT in stakes, problems), then `!escrow backend <g> cutover confirm`
   (or `{"action":"cutover","part":"<g>","actor":"<who>"}` in the request file).
3. Pepe freezes that game's verbs, exports its live records (sha256 + `sum` of the stakes they hold + `count`), and the site's
   `/api/escrow/admin/game-import` checks the digest, the totals, and that **every stake a live record names is a held ledger
   hold with the same amount and ref**, then writes the records in one transaction, re-reads the totals and goes live. Pepe
   compares, switches the game on, and from then on reads it from the site (events + a mirror every minute).
4. Verify: `node tools/escrow-backend.js` shows `<g> live=true` with the right record counts; the game's page
   (`/wagers`, `/bounties`, `/wagers` pools section, `/wallet` loans) shows the same records; `!<g> list` in a room matches.

Per game:

| Game | Exports | Totals | Precondition | Retires while live |
|---|---|---|---|---|
| wagers | `offered` + `active` wagers (stakes: creator / both) | Σ stakes, # live wagers | none mid-step (`accepting` / `settling`) | `/act cmd=wager`, `/api/wagers/sync` |
| bounties | every `open` bounty with its pot entries (hid, nick, amount, account), claims, spec, users; `seq` | Σ every open pot, # open bounties | none `paying`; every pot hold held as recorded; **the site import refuses (`E_BUSY`) while any `bounty_actions` row is pending / claimed** | the `bounty_actions` queue, `/api/bounties/sync`, Pepe's bounty sweep / recovery / BT1 repair |
| pools | every live non-LMSR market (`open` / `closed`) with its bets (each stake checked against the escrow mirror); `seq` (the shared M sequence) | Σ every bet stake in live pools, # live pools | none `settling` | pool `market_orders` (bets + judge calls), pool rows of `/api/markets/sync`, Pepe owning the M sequence |
| loans | every live P2P loan (`offered` / `active`) with its holds, payments and accounts; `seq` (the shared L sequence) | Σ principal of the **offered** loans (the only P2P PAT held on the ledger), # live P2P loans | no loan `accepting`, no repayment hold still held, every offer's principal held as recorded | `/act cmd=loan` P2P verbs, Pepe's P2P sweep / collection / recovery, the P2P rows of his `/api/wallet/loans` push |

**Bounties notes.** Pepe stays the evidence verifier: on the site's `created` / `claim` events he reads the task into a spec
and checks claims against his logs, writes the results back (`spec_put`, `check_put`), and auto-awards as Pepe (`resolve` with
`auto`, accepted only when the stored check for that claim says verified). The site settles: every pot hold in one transaction,
hunters split pot - 5% evenly (the remainder to the first hunter), the fee split by the `bounty_fee` routing row. Achievements and
cosmetic drops stay Pepe's, counted once per bounty from the events.

**Pools notes.** LMSR markets stay in Pepe (Phase 3) and share the M sequence: while pools are live Pepe takes an LMSR market's
id from the site (`reserve_id`) and refuses to create one when the site doesn't answer. The payout maths is checked against
Pepe's `_market_pay` with 12 vectors (`test/fixtures/pool-payout-vectors.json`, generated by the bot's `escrow_pool_test.py`).
Re-settling a pool (`pepe_mktresettle`) is refused while pools run on the site. A pool can take at most 2,000 bets.

**Loans notes.** Only P2P loans move. Federal Reserve loans (`!loan reserve / request / approve / grant`, LR requests, their
collection, CreditMixin limits) stay in Pepe until Phase 3; they share `loans.json` and the L sequence, so while loans are live
Pepe takes a Reserve loan's id from the site (`reserve_id`, keyed) and refuses to issue one when the site doesn't answer.
`loans.json` keeps the P2P mirror next to his Reserve loans, so `!loan check`, late marks and credit limits read without the
network. The site collects due loans every 10 minutes after the due date (Pepe's `_loan_collect`: the daily 2% penalty capped at
50% of the principal, "up to what the borrower has" read inside the transaction, the LATE mark). `/wallet` reads P2P loans from
the engine and Reserve loans from Pepe's snapshot.

## 8. Rollback (while the site answers)

**A game:** `!escrow backend <g> rollback confirm` (or the request file with `"part":"<g>"`). The site hands every record back
(the live ones and 60 days of history) under one key, keyed (a retry answers the same records), and switches the game off; the
stakes stay on the ledger and Pepe moves them through it. His mirror file becomes the local file again.

**The ledger:** only after every game is rolled back (the site refuses with `E_GAMES_LIVE` otherwise).
`!escrow backend rollback confirm` → Pepe closes the gate, sends his queued moves first, and calls `/api/escrow/admin/rollback`:
in one transaction (after a verified backup) every held hold goes to state `returned`, `live` goes off, and the answer lists
them (with a sha256). Pepe writes them back into `escrow.json` as local held holds and switches off. A retry with the same key
gets the same answer. A later cutover needs a new key; ids that come back are re-used.

## 9. Detach (the site is gone for good)

`!escrow backend detach confirm` - refused while the site answers and owns the escrow. Every game's mirror is already its local
file; the escrow mirror's held holds become local holds; queued refunds / settles / grants become local pending payouts (paid by
the local path); the switches go off. If the site comes back still owning the escrow, Pepe logs a **CONFLICT** and refuses new
local escrow until an admin decides.

## 10. What the prod cutover needs from the user

- Phase 1 (pools) live on prod first.
- An explicit go for each prod write: §4 (ledger switch), §5 (the ledger cutover), and §7 step 1-2 for every game.
- The time window from §0.

## 11. Staging rehearsal (2026-10-11, done)

Ran on staging.publicaccess.tv (site a016f0a, 1.99ou) and PepeBeta (VM 111, bot e0d7e3f; running d931064 and later, each
passed probation) with the pools already live on staging (Phase 1 soak).

**Prod data, read-only.** Prod Pepe's `escrow.json`, `wagers.json`, `bounties.json` and `loans.json` were read over ssh
(nothing written on prod) and copied into `C:\PATV\escrow-seed\` on the staging VM; the staging-only seed hook copied them over
staging Pepe's files at the next start (the old ones kept as `*.pre-seed-<ts>`). Prod held **3 stakes, 21,000 PAT** (the pots of
the 3 open bounties BT3 / BT7 / BT8), 0 open wagers, 0 open pools, 6 active P2P loans (+3 active Fed loans), 0 pending payouts.
The staging DB is a recent prod copy: every hold's account exists. Because prod had no open wagers / pools / loan offers, the
staging-only inject hook (`C:\PATV\escrow-inject.jsonl`, one-off, PepeBeta.Room) added on the **local** path: W5 (offered, 5k),
W6 (active, 3k + 3k), pool M2 (yes 2k / no 1.5k), the P2P offer L48 (10k) and a 500 chip-in on BT7.

| Step | Pepe (export / mirror) | Site | Match |
|---|---|---|---|
| ledger dry run | 10 holds, 46,000 (BT 21,500 · W 11,000 · L 10,000 · M 3,500) | - | ready |
| ledger cutover `ec-rehearsal-1` | 10 / 46,000 | 10 / 46,000, sha256 2fbee13c…, **supply 1,040,549,782 before = after** (same transaction) | yes |
| wagers `gc-wagers-rehearsal-1` | 2 live, 11,000 in stakes | 2 live | yes |
| bounties | 3 open, 21,500 | 3 open | yes |
| pools | 2 live (M1 empty, M2), 3,500 | 2 live | yes |
| loans | 7 live (6 active + L48 offered), 10,000 | 7 live | yes |

**On the site, through Pepe's chat verbs** (inject): the judge settled W6 (ginger_snapped won 5,700, 300 fee by the wager_fee
row), tricon accepted L48 (10,000 paid to him, owes 10,500 in 7d), the judge settled M2 "yes" (tricon +3,425, 75 fee),
ginger_snapped chipped 500 into BT8, tricon offered W7 (2k) and ginger_snapped accepted it. Every announcement was the local
wording, once. Held after: **8 holds, 31,000** (BT 22,000 · W 9,000) - exactly the expected 5,000 + 4,000 + 22,000.

**Rollback** (loans → pools → bounties → wagers → ledger, keys `rb-*-rehearsal-1`): every game's records came home
(loans 7 / pools 2 records / bounties 3 / wagers 3 records); the ledger handed back **8 holds, 31,000, sha256 6f1c54b9…** -
Pepe's local escrow afterwards: 8 held, 31,000 (BT 22,000 · W 9,000). The site's table: 0 held, live off.

**Cutover again for the soak** (`soak-*-1`): ledger 8 / 31,000, sha256 6f1c54b9… (the same), supply 1,040,549,782 before =
after; wagers 2 / 9,000, bounties 3 / 22,000, pools 1 / 0, loans 7 / 0 - all matched. Staging was left ON.

**A site deadline with Pepe as a client:** W5's offer ran out ~10 min later; the site tick refunded the 5,000 (Pepe's original
hold h4331, imported) and Pepe announced "tricon never took wager W5 ..." from the event.

A Pepe restart for another deploy (1.99oy) happened between the bounty and pool cutovers; nothing was lost (the switches,
the mirror and the cursor are on disk).

Note: run `tools/escrow-backend.js` with the service's environment (`STAGING=1` on staging) - without it the `enabled=` column
shows the prod default (off); `live` and the totals are read from the database either way.
