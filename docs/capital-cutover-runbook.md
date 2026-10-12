# Capital cutover runbook: Pepe → backend (Phase 3)

The design is `docs/backend-migration-audit.md` §5.9 (LMSR markets + Market maker), §5.10 (Reserve loans + Bank) and §5.11
(staking capital vaults), §6 Phase 3. The code:
- **site** `capital/` - `core.js` (the store), `lmsr.js` + `fdmath.js` (the maths), `markets.js`, `reserve.js`, `vaults.js`,
  `service.js` (routes, the tick, the cutover); hooks in `pools.js`, `supply.js`, `markets.js`, `wallet.js`, `staking.js`,
  `actions.js`, `loginrekey.js`, `oracle.js` (the "market" resolver);
- **bot** `pepe_capitalstore.py` (+ remote branches in `pepe_market.py`, `pepe_amm.py`, `pepe_loan.py`, `pepe_credit.py`,
  `pepe_vaults.py`, and the protocol bookings in `pepe_layers.py`, `pepe_monetary.py`, `pepe_treasury.py`), `pepe_fdmath.py`.

## Why ONE cutover for three features

The audit asked for one cutover per feature, or one combined cutover if the NAV coupling demands it. It does:
- **NAV(Bank) = Bank cash + the principal still out on Bank-funded Reserve loans.** If the loans moved without the vaults
  (or the other way round), every share price, every stake and unstake at the 04:00 cut-off and every protocol booking
  would read one half from the site and the other from Pepe's files, minutes apart.
- **NAV(Market maker) = mm cash + the open markets it seeded, marked to market.** Same problem with the markets.
- A split would need a mixed mode in BOTH directions (Pepe's epoch reading site loans / markets, or the site's epoch reading
  Pepe's), each with its own staleness rule, rollback order and detach story. One cutover has two states only: everything
  local, or everything on the site. The share book, the Bank's book and the Market maker's book are always read in one place.

So there is **one switch** (`capital_meta.enabled` on the site, `capital_client.json` `on` in Pepe) and **one cutover**,
with three sub-totals (markets, loans, vaults) checked separately inside it. `!market backend …`, `!loan backend …` and
`!staking backend …` are the same command as `!capital backend …`.

## What moves

| | Before (Pepe) | On the site |
|---|---|---|
| LMSR markets | `markets.json` (model `lmsr`), the pot a number in the record, held by Pepe outside every store | `capital_records` kind `market` + a pools row `market:<id>` per pot (kept out of every pool view; supply row "markets") |
| a buy | wallet charge, then the record, then the fee to the vault (journaled `amm_journal`) | wallet debit + pot + fee legs + record, ONE transaction |
| a sell / resolve / void / cancel | escrow payout queue + vault adjust | pot debit + wallet credits + the funder's leftover, ONE transaction |
| the deadlines | Pepe's 30 s heartbeat | the site's 15 s tick (the 7-day grace, the AI judge's hold) |
| re-settle (`!market resettle`) | a journaled multi-step | one transaction (claw back, the funder's first leftover back, resolve again) |
| Reserve loans | `loans.json` (`reserve: true`), requests `LR<n>`, the escrow ledger for the PAT | `capital_records` kinds `loan` / `request`; the Bank / Reserve pools and the wallet move in one transaction |
| collection, penalties, late marks, Bank defaults | Pepe's heartbeat | the site's tick |
| the credit score | Pepe's `pepe_credit.py` over his file | a site read model over the site's Reserve loans + the escrow P2P loans + the archive (per ACCOUNT) |
| staking: the share book | `vaults.json` | `capital_docs` "vaults" (Pepe's `vaults.json` shape for the keys the site owns) |
| stake / unstake | stash → vaultfloat (keyed), queued | the same, one transaction |
| the 04:00 UTC cut-off | `_vault_epoch` | `capital/vaults.js` `epoch`: ONE transaction, each step in its own savepoint |

**What stays in Pepe:** the chat verbs (one keyed call each, on the cmdnet worker), every announcement (from the call's
answer or the event stream), the AI judge (Phase 5 split it: its proposal goes to the site's oracle when that switch is on;
otherwise Pepe settles as the judge through the same keyed call), and the policy engines that are Phase 4: the Fed (mint,
flash liquidity, Fed loans), the treasury waterfall, the Casino-vault feed. When those add or take protocol capital in a
vault they book its shares on the site (`op protocol`, keyed: `mint-<key>`, `fedloan-<id>`, `grant-<key>`, `flrepay-<key>`,
`wf-<epoch>-<vault>`, `econ-seed-<id>`, `lotto-reseed-<key>`).

**What does not change:** amounts, rates, caps and destinations. The site uses Pepe's constants (pushed at the cutover and
every 5 minutes: `/api/capital/bot/config`), Pepe's routing for the market fee (the escrow fee plans), Pepe's targets / flash
room / layers flag for the policy-dependent steps. A policy step that needs Pepe's numbers waits when they're over 2 hours
old (the v2 Bank default cover, the v1 dividend) - nothing is guessed.

**The old stakers pool (`pepe_stake.py`) is not migrated - there is nothing left in it.** The 1.92 vault launch moved every
1.90 stake into the Auto fund and paid the fee-share pool out once (`migrated_stakes` is set on prod; the "stakers" pool is
0 on prod and every stash's `staked` is 0). Since 1.99nf the module only answers "staking runs through the vaults now" while
the stashes live on the site. Moving it would mean porting a dead path; keeping it inert is safer (nothing reads or writes it).

### The precision (prices and costs EXACTLY)

`capital/lmsr.js` is `pepe_amm.py` expression for expression, and `test/capital-lmsr.test.js` replays
`test/fixtures/capital-lmsr-vectors.json.gz` (camfrog-bot `tools/gen_lmsr_vectors.py`, the REAL Python code, ~5,900 trades on
300 markets, every resolution, the Market maker's book) with `===` on every float. Two things were needed for that:
- `exp` / `log`: Pepe's Python used the Windows C library, which differs from V8's in the last bit about once in 200 calls.
  Both sides now run the FreeBSD msun (fdlibm) algorithms (`pepe_fdmath.py`, `capital/fdmath.js`, the same code; within 1 ulp
  of the C library). **The bot change switches Pepe's own AMM to them**: from that deploy his local prices can differ from
  before by at most an ulp (no stored number depends on it).
- the order of every float sum: q in options order, holders and each holder's cost / shares in the order Python inserted them
  (`_ord` on the site's record; JSON from JavaScript puts integer-like keys first), the Market maker's book in market-id order
  (Pepe's `_vault_mm_markets` now sorts the same way).

The cutover compares the NAVs to the bit, not only to the PAT (see §5).

## The rule (switch on, site down)

Pepe writes no local market, Reserve-loan or vault state while the switch is on. With the site down:
- `!market buy|sell|settle|cancel|new`, `!loan reserve|request|approve|deny|grant|repay|forgive`, `!stash stake|unstake`
  say publicaccess.tv isn't answering (a command that moves PAT: "it either went through completely or not at all - check in a
  minute"); the lost answer is looked up later by its key (`op-status`);
- a protocol booking from a policy engine waits (its journal keeps the step) and is retried under the same key;
- the files are mirrors; nothing in them moves PAT.
The only ways back are an admin **rollback** (the site answers) or **detach** (the site is gone).

## 0. When

- **After the pools, stashes and escrow cutovers** (live on prod). The site refuses the import while the pools or stashes
  still live in Pepe (`E_POOLS_LOCAL`, `E_STASHES_LOCAL`), and refuses a pools rollback while the capital cluster is live
  (`E_CAPITAL_LIVE`).
- **Not** within 20 minutes of 04:00 UTC (the cut-off and the monetary tick); Pepe's dry run refuses then.
- Not during a Monday treasury epoch run.
- Nothing mid-step (Pepe's dry run refuses): a market settling, a market journal entry or re-settle unfinished, a Reserve
  loan being funded or a request being approved, a repayment hold not yet paid to the lender, a vault request / dividend /
  rebalance / v2 default mid-move, a stake not yet held, pool moves still queued for the site.

## 1. Preconditions

1. Code on prod: site ≥ 1.99tw (`b070016`), bot ≥ 1.99tw (`79a7c6d`). Deploy the site first, then the bot.
2. `!econ pools backend status`, `!stash backend status` and `!escrow backend status` say "live on publicaccess.tv".
3. Both capital switches are OFF:
   - Pepe: `!capital backend status` says "on Pepe (local)";
   - site (VPS, read-only): `sqlite3 /home/PATV/myapp.db "SELECT * FROM capital_meta"` is empty, or `enabled=false`.
4. `!capital backend export` (the dry run) answers **ready**.

## 2. Backups

**Site DB** (VPS). Use `.backup` (WAL), never `cp`:

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-capital-cutover-$TS.db"
```

The import also takes its own verified backup (`dbbackup.backupDb("pre-capital-import")`).

**Pepe's files** (prod VM, PowerShell):

```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\capital-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\markets.json, C:\PATV\camfrog-bot\loans.json, C:\PATV\camfrog-bot\vaults.json, C:\PATV\camfrog-bot\escrow_client.json, C:\PATV\camfrog-bot\pools_client.json $d
```

## 3. Record the "before" numbers

1. **Pepe:** write `{"action":"dryrun"}` to `C:\PATV\capital-cutover.request.json`; read `C:\PATV\capital-cutover.result.json`
   about 30 s later (or `!capital backend export`). Write down `markets`, `pots`, `loans`, `loans_open`, `loans_out`,
   `owed_left`, `requests_pending`, `queue_held`, `queue`, `digest`, and the `nav` / `prices` per vault.
2. **Supply:** `curl -s https://publicaccess.tv/api/stats/supply | jq '.total, (.rows[] | select(.key=="markets"))'`.
3. **Site:** no pots yet: `sqlite3 /home/PATV/myapp.db "SELECT COUNT(*), COALESCE(SUM(balance),0) FROM pools WHERE key LIKE 'market:%'"` → `0|0`.
4. **vaultfloat covers the queue:** `sqlite3 /home/PATV/myapp.db "SELECT balance FROM pools WHERE key='vaultfloat'"` ≥ `queue_held`.

## 4. Switch the site on

As an Admin, in a signed-in browser console on publicaccess.tv:

```
fetch('/api/admin/capital-backend', {method:'POST', headers:{'content-type':'application/json','X-Requested-With':'fetch'}, body: JSON.stringify({on:true})}).then(r=>r.json())
```

or on the VPS: `sqlite3 /home/PATV/myapp.db "INSERT INTO capital_meta (key,value) VALUES ('enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'"`.

**This writes to prod: the user's explicit go is needed.** It only lets Pepe import. Nothing moves yet.

## 5. Cutover

Run one of:
- `!capital backend cutover confirm` (an admin, in any room);
- `{"action":"cutover","actor":"<who>"}` in `C:\PATV\capital-cutover.request.json`.

Pepe then:
1. **Freezes** the market, Reserve-loan and stake commands (`🏦 … moving to publicaccess.tv right now`).
2. **Exports**: every LMSR market that's live or ended in the last 60 days (each with its holders' dict order and, for a
   settled one, its first resolution's payouts - the site's re-settle needs them), every Federal Reserve loan, every LR
   request, the credit archive, the vault book (`v`, `auto`, `queue`, `epochs`, `seq`, `apr_base`, `next_epoch`, `dividends`,
   `rebalances`, `insured`, `v2_defaults`, `inited`), his NAV numbers right now (cash read fresh, the Bank's loans out, the
   Market maker's book, the prices) and his constants. sha256 of the payload, the totals and the record digest (the same
   facts the site hashes). The export is kept as `capital_export_<key>.json`; `cutover_pending` is journaled in
   `capital_client.json` (a crash re-sends the same export under the same key).
3. **POSTs** `/api/capital/admin/import`. The site checks the switch, the pools and stashes live, the digest, the totals,
   the record digest, that every holder / borrower / requester has an account, that no market id is one of its betting
   pools, and that vaultfloat covers the queued stakes. It takes a verified backup. Then, in **one transaction**, it:
   - refreshes Pepe's "markets" supply row from the export and reads the supply total;
   - writes the markets (with a pools row per pot, an `import:capital:<key>` move), the loans, the requests, the credit
     archive (per account), the vault book, the sequences (the M and L numbers continue above both Pepe's and the
     escrow games');
   - re-reads everything: the totals, the record digest, the pots, and **the NAVs**: the Bank's loans out and the Market
     maker's book must equal Pepe's exactly, the cash he read must equal the site's (else `E_NAV_CASH`: something moved a
     vault's cash during the cutover - run it again), each vault's NAV and price must equal his to the bit;
   - reads the supply total again (it must not move by one PAT).

   Any mismatch throws and rolls back (`ok:false`, nothing kept). The same key again answers the stored result.
4. **Compares** the site's totals, digest and NAVs with his own.
5. **Flips**: the three files are kept as `markets.pre-site-<key>.json` etc.; `capital_client.json` `on: true`; the files are
   mirrors from now on; Pepe pushes his constants and policy state.

The answer reads "DONE … totals, NAVs and shares matched". The result file has `"ok": true, "result": {"match": true}`.

## 6. Verify (read-only)

1. **Site:**
   ```
   sqlite3 /home/PATV/myapp.db "SELECT kind, COUNT(*) FROM capital_records GROUP BY kind; SELECT COALESCE(SUM(balance),0) FROM pools WHERE key LIKE 'market:%'"
   sqlite3 /home/PATV/myapp.db "SELECT value FROM capital_meta WHERE key IN ('live','imported')"
   ```
   They equal the dry run's totals. `live=true`.
2. **Supply:** `/api/stats/supply` `total` is unchanged; the "markets" row now comes from the pools table.
3. **Pepe:** `!capital backend status` says "live on publicaccess.tv" with the same totals; `!market list`, `!loan reserve`
   and `!stash yield` show the same numbers.
4. **Pages:** `/markets` and `/markets/<id>` (prices, positions), `/wallet` (Reserve loans, limit, credit), `/staking`
   (prices, NAVs, the queue) - the site writes them from its own records now.
5. **A live path** (optional; the admin's own PAT): `!market buy M<id> yes 1k`, then `!market sell M<id> yes all` - one
   `cap:buy:` and one `cap:sell:` row in `pool_moves`, the pot row equals the market's pool.

## 7. Rollback (while the site answers)

Run `!capital backend rollback confirm`, or the request `{"action":"rollback","actor":"<who>"}`. Pepe freezes the commands
and calls `/api/capital/admin/rollback`. In one transaction the site moves every pot to 0 under `rollback:capital:<key>`,
writes Pepe's "markets" supply row back (the total doesn't move), sets `live=false` and answers the full state (Pepe's
shapes, with the dict order) with its sha256 and totals. It takes a verified backup first. Pepe checks the digest, writes
the markets (in Python's order; a settled market's resolution as a journal entry, so `!market resettle` works locally),
the Reserve loans, the requests, the credit archive (back in his login keys) and the vault book, and switches off.

A retry with the same key gets the same answer. A later cutover needs a **new** key. Refused while a market is settling or a
vault request is mid-move (try again in a moment).

## 8. Detach (the site is gone for good)

Run `!capital backend detach confirm`. It is refused while the site answers and owns the cluster. The mirrors (refreshed every
20 s and after every answer) become the local files and the switch goes off. The pots' PAT stays in the site's pools table
(the site is gone): Pepe's markets carry their pools again. If the site comes back still owning the cluster, Pepe logs a
**CONFLICT** and refuses the commands until an admin decides.

## 9. The website

- `/markets/:id` buy / sell / resolve run on the site at once (no "Sent to Pepe"; the `market_orders` queue retires for the
  LMSR markets - an order queued before the cutover is done on the site by Pepe under its order id).
- `/wallet`: the Reserve card (instant borrow, a request, repay) runs on the site; a loan that would need the Fed's flash
  liquidity says to ask in a Camfrog room (Pepe still runs the Fed - Phase 4).
- `/staking`: stake / unstake run on the site (queued for the cut-off).

## 10. What the prod cutover needs from the user

- An explicit go for §4 and §5 (they write to prod) and a time window from §0 (not 03:40-04:20 UTC, not during the Monday epoch).
- The bot deploy changes Pepe's local AMM exp / log to fdlibm (ulp-level; see "The precision"). It ships before the cutover
  and is live even while the switch is off. Fine to deploy any time.
- Whether the web Reserve borrow may draw on the Fed's flash liquidity once Phase 4 moves the Fed (today it refuses a loan
  bigger than the Bank's cash on the web; chat works as before).
- The oracle switch (Phase 5) is independent: with it on, an AI-judged market's proposal is settled by the site when the
  window ends (the "market" resolver is registered).

## 11. Staging rehearsal (2026-10-12, done)

On staging.publicaccess.tv (site 1.99tw `b070016`) and PepeBeta (VM 111, bot 1.99tw `79a7c6d`, passed probation), with the
staging pools, stashes and escrow already live there. Prod's `markets.json`, `loans.json` and `vaults.json` were copied
**read-only** from VM 110 (`scp`, nothing written there) and loaded on staging with the staging-only replay
(`capital-replay.request.json` `load_prod_copy`, staging's own kept in `C:\PATV\p3-staging-backup-1791838820`). Two
staging-only adjustments, both keyed moves on staging, never amounts in a record: prod's market and Reserve-loan ids +1000
(staging's own betting pools and P2P loans already use M3 / L23-48, and the M / L numbers are shared), and staging's
vaultfloat topped up 0 → 850,000 from staging's Reserve (prod's 4 queued stakes had already left prod's stashes into prod's
float). The staging DB is a prod copy: every holder, borrower and requester (13 accounts) existed; nothing else was
refreshed. Cash (Bank / Market maker / House) is staging's, so the NAVs below differ from prod's - both sides read the same
cash, which is the point of the check.

| Step | Result |
|---|---|
| dry run | ready, no problems: 8 live markets (**805,675** PAT in pots), 25 Reserve loans (3 open, **66,500** out from the Bank, 68,720 owed), 3 pending requests, 4 queued stakes (**850,000**); digest `58203f1a…f211` |
| cutover `cc-rehearsal-1` | **match: true** - site totals and record digest = Pepe's; NAV Bank **2,264,440** / House **24,900,300** / Market maker **1,614,781.7642701822** equal **to the bit**, prices equal to the bit (Bank 0.9960969331659068, House 2.523662110656601, MM 1.5977868469336414, Auto 1.2225251453279664); components loans out / mm book / cash all equal; supply **1,303,320,798 → 1,303,320,798** inside the import transaction |
| replay: markets | `!market buy M1015 Raise 5k` → 6,160 shares (avg 0.81, Raise 81%) · `sell … all` → 7,344 shares for 5,711 PAT (+211) · the judge settles M1043 yes (nobody held yes: the pot back to the Market maker) · an admin voids M1069 → 28,420 back to its holder (29,000 in, fees kept) · `!market new …` → M1076 seeded 34,659 by the Market maker · `buy M1076 yes 10k` → 17,990 shares, the judge settles yes → +17,990 |
| replay: Reserve loans | `!loan reserve` → limit 57,500, credit 689 Good · instant L1049 (5,000, owes 5,150) · `!loan request 300k 14d` → LR5, 3 admins told · `deny LR1` · `approve LR4 20k 7d` → L1050 · `repay L1049 1000` then the rest → paid off · L1023 two days overdue (test clock) → the site's tick added 2 days of penalties and collected **34,291** → paid off |
| replay: a default | L1052 40,000 granted to an empty wallet, moved to a stash, 32 days overdue → nothing to collect, LATE (61,200 owed) → **economy v2 cover**: the Bank's protocol surplus (163,652 above its 2,000,000 target) covered **40,000** (40,111.43 protocol shares burnt at 0.9972219841738177), Fed loan 0; the Bank's share price unchanged |
| replay: staking | `!stash stake tricon 50k bank` → stash 3 −50,000, vaultfloat +50,000 · cut-off 1 (test clock): prod's 4 queued stakes + this one ran (vaultfloat 900,000 → 0); the APR ceiling moved 209,013 House and 37,814 Market-maker staker shares to the protocol (staging's jackpot is far above prod's, so the House price had jumped); the Auto rebalance moved 2,283 + 38,799 · `!stash unstake tricon 20k bank` · cut-off 2 (under 12 h later: no ceiling step): 20,000 back in stash 3, rebalance 5,387 + 130,125 · the owners' notices sent from the event |
| rollback `cr-rehearsal-1` | the site's digest before (`000b116f…2464`) = Pepe's local files after = the re-import's; 6 live markets / 677,610 PAT in pots / 28 Reserve loans / the vault book back; supply unchanged |
| cutover again `cc-rehearsal-soak` | match: true; NAVs and prices equal to the bit; supply 1,303,320,798 → 1,303,320,798. **Staging left ON** for the soak |

The mirror's digest equalled the site's after every step (`ae6f9d97…`, `000b116f…`, `b8ae9ff2…`, `09dd1c35…`), and the staging
supply was **1,303,320,798** before the first cutover and after the last step.

Also run locally before staging: the REAL client (`pepe_capitalstore` + the market / loan / vault mixins) against the REAL
site modules on a temp DB seeded with prod's pools, House and stashes and the same prod files: dry run → cutover (match;
NAV Bank 2,310,258 / House 15,741,175 / MM 1,082,847.7642701822 equal to the bit; supply 256,362,420 unchanged) → buy, sell,
a new market settled, an instant loan repaid, a request, two cut-offs (stake, unstake), a protocol booking (once per key)
→ rollback: every record untouched by the replay came back **exactly** as it left (values and Python's dict order) → cutover
again (match).

Notes:
- The test clock (`POST /api/capital/admin/test-clock`) exists only on staging (`STAGING` env): it runs the cut-off now and
  moves a loan's due date; it never moves PAT itself.
- The staging site logs `PayloadTooLargeError` for some bot POST before and after this deploy (the stack trace's column moved
  by the 44 characters this deploy added to the skip list in `index.js`, so it is the same pre-existing route) - not a
  capital route (they parse their own body or are small).

## 12. Known limits

- The Casino-vault feed (15% of House profit) runs at Pepe's own 04:00 tick, after the site's cut-off (it ran inside the
  cut-off before). Under economy v2 (prod: treasury live) the feed is 0, so the House NAV at the cut-off is the same; under
  v1 the queue would see the House before the feed instead of after.
- A v2 Bank default: the site burns the protocol's cover shares and marks the loan insured; the Fed liquidity loan for the
  rest is opened by Pepe from the `bank_default` event (`_fl_open`, keyed `def-L<id>`) and acked (`default_ack`).
- The flash repayment from a Bank-funded repayment: the site emits `bank_repaid`; Pepe repays the Bank's Fed flash loans
  from it (`_mo_flash_repay`, keyed `rp-<key>`) and books the shares with `nav_delta` (the price before the PAT left).
