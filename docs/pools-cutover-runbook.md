# Pools cutover runbook: Pepe → backend (Phase 1)

The design is `docs/backend-migration-audit.md` §5.3–5.7 and §6 Phase 1. The code:
- **site** `pools.js`, `econstore.js`, `polls.js` (1.99ns);
- **bot** `pepe_poolstore.py`, `pepe_pollclient.py`, `pepe_economy.py` (1.99ns).

This moves **every protocol pool** in one cutover. That is everything in Pepe's `turf_data.json` `vaults`: the Federal Reserve (`reserve`), Fort Knox, the incentive budget, the Casino vault (`heist`), Bank and MM cash, `stakers`, `vaultfloat`, `bingo`, `burn` and every `room:<id>`. It also moves:
- the economy journals: `econ_layers`, `econ_monetary`, `econ_treasury`, `econ_launchpad`, `econ_rooms`, `vault_marks`, `route_keys` and `stake_drained`;
- the PAT Routing overrides;
- `econ_cfg` and its log.

The House stays where it is (`jackpot_rakes`), and so do the stashes. The lotto pot stays in the lotto service when that is live. Otherwise it moves as the `lotto` pool.

**What does not change:** amounts and destinations. Pepe still computes every split and still runs every policy tick (epoch, monetary, flash, Fed loans, room vaults, launchpad). The site books the moves. Phase 4 moves the engines.

**The rule:** local storage applies only while a switch is **explicitly** off. With the switch on and the site down, Pepe never writes local pool or poll state:
- credits are queued (outbox, keyed);
- debits are refused;
- poll commands are refused.

The only ways back to local are an admin **rollback** (while the site answers) or **detach** (when the site is gone).

**Turf routing (2026-10-11, the user):** every `turf:*` destination moves to the room vault of the room where the money was spent, or to Fort Knox when there is no room. The turf agent is changing Pepe's defaults (`pepe_routes.py`) and migrating the saved overrides. Nothing here needs to change for that:
- the site keeps no defaults of its own. It stores the overrides Pepe pushes and his catalog, which is re-pushed hourly and on every change;
- `room:<id>` legs are ordinary pools, so they are booked in the `/api/pat/charge` transaction.

`turf_inbox` stays as the generic place for any leg the site can't book. Today that is a lotto pot held by the lotto service. After the turf change no default route should reach it; its total is a supply row ("waiting for Pepe's turf businesses").

## 0. When

- **Never** within 20 minutes of 04:00 UTC: the daily monetary tick and the Monday epoch. Pepe's dry run refuses then.
- **Not before** the Monday 2026-10-12 04:00 UTC epoch has settled and been read. The coordinator's gate is 06:00 UTC:
  - `!econ treasury` shows the epoch `done`;
  - the `[TREASURY] scheduled epoch` and `[MONETARY] scheduled` lines are in `C:\PATV\pepe-console.log`.
- The best windows are mid-week, 12:00–22:00 UTC, away from the Sunday 21:00 ET lotto draw.

## S. Scheduled run: the exact sequence (first prod run planned 2026-10-12, from 06:30 UTC)

Each step has a **pass** condition. Stop at the first failed one; nothing after it runs.
- A failure **before S6** leaves everything as it was: local, nothing imported, or an import the site rolled back itself.
- A failure **in S6** is rolled back automatically (see below).
- A failure **in S7** is rolled back by S8.

The commands are for the VPS (`ssh patv-vps`) and the prod VM (`ssh pepe-prod`, PowerShell).

**S0. Gate.** Everything below must be true:
1. The lotto cutover of 02:30 UTC is finished and verified (`docs/lotto-cutover-runbook.md` §4).
2. The 04:00 UTC weekly settlement and monetary day ran on the old path:
   ```
   Select-String C:\PATV\pepe-console.log -Pattern 'scheduled epoch W2026-10-12|MONETARY\] scheduled D2026-10-12'
   ```
   Both lines must be present.
3. The 06:00 UTC read-only epoch check is clean.
4. Prod runs the shas listed in the agent report:
   - `curl -s https://publicaccess.tv/healthz` is ok;
   - `Get-Content C:\PATV\camfrog-bot\VERSION` is ≥ 1.99nz.
5. It is not within 04:00 ± 20 min UTC.

**S1. Backups** (§2). Pass: both files exist and are non-empty.

**S2. Dry run.**
```
Set-Content -Encoding UTF8 C:\PATV\pools-cutover.request.json '{"action":"dryrun"}'
```
Wait about 30 s, then read `C:\PATV\pools-cutover.result.json`.
- **Pass:** `"ok": true` and `problems` is `[]`.
- Record `result.sum` and `result.per_pool`.
- The lotto pot must **not** be in `per_pool`. After the lotto cutover it lives in the lotto service.

**S3. Supply before.** Run `curl -s https://publicaccess.tv/api/stats/supply | jq '{total, updated}'` and record it.

**S4. Site switch ON (prod write).**
```
sqlite3 /home/PATV/myapp.db "INSERT INTO pools_meta (key,value) VALUES ('enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'"
```
**Pass:** `sqlite3 /home/PATV/myapp.db "SELECT value FROM pools_meta WHERE key='enabled'"` is `true`. Nothing moves yet.

**S5. Dry run again.** Same as S2. **Pass:** `ok: true`. Pepe now also checks that the site answers, its switch is on, and it doesn't own pools yet.

**S6. Cutover.**
```
Set-Content -Encoding UTF8 C:\PATV\pools-cutover.request.json '{"action":"cutover","actor":"scheduled","key":"pc-20261012"}'
```
Wait until `C:\PATV\pools-cutover.result.json` appears; allow up to 3 minutes. Everything in §5 runs, then Pepe **verifies under his closed gate**: the site's pools must equal exactly what left him, and the site does no claim settling for 2 minutes after an import. On a mismatch he **rolls back automatically** (`auto-rb-pc-20261012`). The result then has:
- `ok: false`;
- `verified: false`;
- `error: "post-flip verification failed - rolled back automatically"`.

**Pass:** `ok: true`, `result.match: true`, `result.verified: true`, `result.site.supply_before == result.site.supply_after`, and `result.sum` = S2's sum.
- `result.delta` lists anything that moved locally between the export and the flip. Usually `[]`.
- **Not ok and no automatic rollback:** follow §5's "if it fails" notes in §7. In short:
  - if the site never imported, nothing changed;
  - if it did, run the rollback (S8).

**S7. Verify (read-only), within 10 minutes.**
1. Run:
   ```
   sqlite3 /home/PATV/myapp.db "SELECT key, balance FROM pools WHERE balance != 0 ORDER BY key"
   ```
   It must equal S2's `per_pool` (non-zero) plus `result.delta`, minus or plus any claims settled since (the `pool_moves` rows with kind `settle` / `move` after the import).
2. Run:
   ```
   sqlite3 /home/PATV/myapp.db "SELECT COALESCE(SUM(net),0) FROM pool_moves WHERE ts > (SELECT json_extract(value,'$.at') FROM pools_meta WHERE key='imported') AND kind != 'import'"
   ```
   It must equal (sum now) − (S2 sum + delta).
3. Pepe: `{"action":"status"}` in the request file shows:
   - `on: true`;
   - `outbox: []`;
   - `uncertain: []`;
   - no `conflict`;
   - `local` all 0.
4. Supply: `/api/stats/supply` `total` = S3's total ± the wallet activity since. No step may change it by itself.

**S8. Rollback** (any failed S7 check, or the user's call): `{"action":"rollback","actor":"scheduled","key":"pr-20261012"}`. **Pass:** `ok: true` and `result.sum` equals the site's pool sum just before. Then:
- the site's `pools` all 0 and `live` false;
- Pepe `status` shows `on: false` and `local` holding the same sum.

## 1. Preconditions

1. Code on prod: site ≥ 1.99ns, bot ≥ 1.99ns. Deploy the site first, then the bot.
   - `curl -s https://publicaccess.tv/healthz`.
   - `!version` in a room shows 1.99ns or later.
2. Both switches are still OFF.
   - Pepe: `!econ pools backend status` says "the pools live on Pepe (local)".
   - Site (on the VPS, read-only): `sqlite3 /home/PATV/myapp.db "SELECT * FROM pools_meta"` is empty, or `enabled=false`.
3. The lotto. If the lotto cutover has run, `!lotto backend status` says "runs on publicaccess.tv" and `vaults.lotto` is 0 locally. The pools cutover then leaves the lotto pot alone. If it has not run, the `lotto` pool moves with the others.
4. Nothing in flight:
   - `!econ pools backend export` (the dry run) answers **ready**;
   - it lists no unfinished route intents;
   - no old `casino` pool is left;
   - there are no negative pools.

## 2. Backups

**Site DB** (on the VPS). Use `.backup` (WAL), never `cp`:

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-pools-cutover-$TS.db"
```

The import also takes its own verified backup (`dbbackup.backupDb("pre-pools-import")`).

**Pepe's files** (prod VM, PowerShell):

```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\pools-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\turf_data.json, C:\PATV\camfrog-bot\vaults.json, C:\PATV\camfrog-bot\loans.json, C:\PATV\camfrog-bot\escrow.json $d
```

## 3. Record the "before" numbers

1. **Pepe:** write `{"action":"dryrun"}` to `C:\PATV\pools-cutover.request.json`. Read `C:\PATV\pools-cutover.result.json` about 30 s later. Write down `sum`, `pools` and `per_pool`. Or use `!econ pools backend export`.
2. **Supply:** run `curl -s https://publicaccess.tv/api/stats/supply | jq .total`. The pools' part of it is every `vault:*` row plus every `room:*` row.
3. **Site:** the pools table must be empty, or all zero:

   ```
   sqlite3 /home/PATV/myapp.db "SELECT COUNT(*), COALESCE(SUM(balance),0) FROM pools"
   ```

## 4. Switch the site on

On `/admin/economy#pools`, click **"Switch the pools backend ON"** (Admin class). Or:

```
sqlite3 /home/PATV/myapp.db "INSERT INTO pools_meta (key,value) VALUES ('enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'"
```

**This writes to prod: the user's explicit go is needed.** It only lets Pepe import. Nothing moves yet.

## 5. Cutover

Run one of:
- `!econ pools backend cutover confirm` (an admin, in any room);
- `{"action":"cutover","actor":"<who>"}` in `C:\PATV\pools-cutover.request.json`.

Pepe then does the following:

1. **Pauses local claim settling** (`_funding_tick`) for the window, so a website claim is never settled both locally and on the site.
2. **Exports** under the store lock:
   - every pool, as an integer;
   - the journals;
   - routing and `econ_cfg` (with its log);
   - the routing catalog;
   - his supply rows.

   It computes the sha256 and the totals (`sum`, `count`, `per_pool`). The export is kept as `pools_export_<key>.json`, and `cutover_pending` is journaled in `pools_client.json`.
3. **POSTs** `/api/pools/admin/import`. The site checks the digest, the totals, Pepe's supply rows against the export, and that no pool already holds PAT. It takes a verified backup. Then, in **one transaction**, it:
   - writes Pepe's fresh supply rows as the snapshot;
   - reads the supply total;
   - writes the pools and the docs, routing and `econ_cfg`;
   - re-reads every pool and the sum;
   - reads the supply total again.

   It must match **to the PAT**, or it throws and rolls back (`ok:false`, nothing kept). The same key again answers the stored result.
4. **Compares** the site's `per_pool` and total with his own.
5. **Flips** under the store lock:
   - Anything that moved locally since the snapshot goes up as **one** keyed move, `cutover-<key>:delta`.
   - The local pools are set to 0, with a mark per pool (`pools-cutover-<key>:<pool>:out` in `vault_marks`) in the same save.
   - `vaults_moved_to_site` records the amounts.
   - `pools_client.json` `on: true`.
6. Pushes the journals and settings again (forced). Claim settling resumes. From now on the site settles plain Reserve / Fort Knox claims itself, keyed `claim:<id>`, the same key Pepe uses.

The answer reads "DONE … totals matched". The result file has `"ok": true, "result": {"match": true, "delta": [...]}`.

## 6. Verify (read-only)

1. **Site:**
   ```
   sqlite3 /home/PATV/myapp.db "SELECT key, balance FROM pools ORDER BY key"
   ```
   It equals the dry run's `per_pool` plus the `delta`. Also check:
   ```
   sqlite3 /home/PATV/myapp.db "SELECT value FROM pools_meta WHERE key IN ('live','imported')"
   ```
   It shows `live=true` and the key.
2. **Supply:** `/api/stats/supply` `total` is unchanged. Wallet activity in between moves it by exactly that activity. The pool rows now come from the table.
3. **Pepe:**
   - `!econ pools backend status` says "live on publicaccess.tv", with the same sum.
   - `!vault` and `!econ` show the same balances.
   - `turf_data.json` `vaults` are all 0, and `vaults_moved_to_site` is set.
4. **Page:** `/admin/economy#pools` shows the pools, the import move, the Fed journal and the incentive groups.
5. **A live money path** (optional; costs the admin's own PAT): run one paid command (e.g. `!roast` as a non-admin test account). Then check:
   - a `charge:<key>` row in `pool_moves`;
   - the wallet debit;
   - the Reserve and room-owner hold credits;
   - for a turf share, a `turf_inbox` row with `applied_at` set within seconds.

## 7. Rollback (while the site answers)

Run `!econ pools backend rollback confirm`, or the request `{"action":"rollback","actor":"<who>"}`. Pepe then:
1. closes his store gate, so no new moves start;
2. sends any queued moves;
3. calls `/api/pools/admin/rollback`. In one transaction the site moves every pool to 0 under `rollback:<key>`, sets `live=false` and answers the balances it took, with a sha256. It takes a verified backup first;
4. credits them to the local pools with a mark per pool (`pools-rollback-<key>:<pool>:in`), in one save;
5. switches the client off.

A retry with the same key gets the same answer, and the marks stop a double credit. A later cutover needs a **new** key; the import refuses while any pool holds PAT.

## 8. Detach (the site is gone for good)

Run `!econ pools backend detach confirm`. It is refused while the site answers and owns the pools.

The last mirror (the site's balances, refreshed every 15 s and after every move) plus the queued credits become the local pools, and the switch goes off. The journals are already local (`turf_data.json` keeps every doc as its cache).

If the site comes back still owning the pools, Pepe logs a **CONFLICT** and pauses local claim settling until an admin decides.

## 9. Polls (same pattern, independent)

- **Site switch:** `polls_meta.enabled`. Default ON on staging, OFF on prod. Use `POST /api/admin/polls-backend {on}`.
- **Pepe:** `!poll backend on`. His running poll, if any, moves to the site, which then owns the poll and its votes. Web votes no longer go through the action queue.
- **Way back:**
  - `!poll backend off` (the running poll comes back to Pepe);
  - `!poll backend detach confirm` (the site is gone).

## 10. What the prod cutover needs from the user

- An explicit go for steps 4 and 5. They write to prod.
- The time window from §0.
- Whether to also switch polls on prod (§9). That is independent and can wait.

## 11. Staging rehearsal (2026-10-11, done)

This ran on staging.publicaccess.tv and PepeBeta (VM 111), against a **fresh copy of prod**:
- the site DB through `sqlite3 .backup` of `/home/PATV/myapp.db`, read-only: 1,277 users, wallets 780,348,597, House 26,670,210;
- prod Pepe's `turf_data.json`, `vaults.json` and `loans.json`, read with `scp`;
- prod's economy settings only: routing, `econ_cfg`, layers / treasury / room vaults ON, read by a script that prints nothing else.

The lotto pot was set to 0 locally, as the lotto cutover will leave it.

The same 19 money operations (`pools-replay.request.json`) ran twice from the same restored start (`s0`: DB + files):
- once on the **old local path**;
- once after the **cutover**, on the backend.

The operations:
- four routed charges (command with room owner and room vault, heist gear, shoutout, cosmetics);
- a refused charge (balance too low);
- two faucets;
- a 1M Fed grant;
- a 500k Fed loan to the MM;
- a 2M House-profit transfer;
- flash cover;
- a 4k room vault credit;
- a 5k boost through the site (its Fort Knox / room claims);
- the funding tick;
- a **forced weekly epoch** (W2026-10-12), the daily release and a monetary day (D2026-10-12);
- a refund reversal;
- the funding tick again.

| | local path | backend |
|---|---|---|
| pools before | 122,790,352 | 122,790,352 |
| pools after | **131,670,424** | **131,670,424** (each of 12 pools equal) |
| House after | 15,000,000 | 15,000,000 |
| 3 test wallets after | 18,304,880 / 13,431,300 / 853,823 | identical |
| every step's answer | the same splits, the same epoch / release / monetary figures | identical |

The cutover itself:
- dry run ready;
- import `pc-rehearsal-backend`: 12 pools, 122,790,352 PAT, **match: true**, delta `[]`;
- the site's supply total in the import transaction was 1,208,834,754 before and 1,208,834,754 after;
- 8 econ docs, 2 routing overrides, 6 `econ_cfg` keys and 2 Fed journal rows came along;
- the local pools were drained to 0 with marks.

**Rollback** `pr-rehearsal-1`: 10 pools, 131,670,424 PAT back to Pepe exactly. The site pools went to 0 and `live` to false.

**Cutover again** `pc-rehearsal-soak`: matched, supply 1,208,837,754 → 1,208,837,754. Staging was left ON for the soak.

The only difference between the runs is a wording one. The epoch's own check said "pools moved by other activity meanwhile" on the backend run. It means the 30 s funding tick settled queued website grants from the prod copy while the epoch ran, which the local run happened to do before it. The amounts are identical.
