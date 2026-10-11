# Gangs cutover runbook: Pepe → backend (G1)

The design is `docs/backend-migration-audit.md` (report §2, "G1 gangs on the site"). The code:
- **site** `gangs.js` (+ `views/gangs.ejs`, `views/gang.ejs`), hooks in `pools.js`, `casino/rewards.js`, `lotto/service.js`;
- **bot** `pepe_gangstore.py` (+ hooks in `frida-bot.py`, `pepe_turfseason.py`, `pepe_roomwars.py`, `pepe_casino.py`, `pepe_lotto.py`).

This moves **the gang system** in one cutover:
- the registry (name, tag, boss), members and ranks (owner / officer / member / recruit), invites;
- the per-rank daily withdrawal allowances (`rank_limits`, `withdrawn`);
- upgrades, heat, unpaid days, the war record and every other field Pepe keeps on a gang (`last_claim`, `last_invade`, `turf_rep0`, ...);
- **the treasuries**: one `pools` row per gang, key `gang:<gid>` (the pool views, digests, exports and rollbacks never show them);
- **rep**: `gang_rep_events`, once per key. The casino and the lotto apply a win's rep on the site directly; `casino_rep_queue` and Pepe's lotto rep path retire.

**What stays in Pepe:** the game engines (heists, invasions, claims, the turf map and its daily tick, room turf wars) and every chat announcement. **Turf state (boroughs, room control) does not move.**

**What does not change:** amounts and destinations.
- The withdrawal cut stays 5% to Fort Knox (routing row `gang_withdraw_cut`, 1.99no).
- Upkeep, upgrades and the founding fee follow the PAT Routing table as before (Pepe computes the split; the site books it).
- A gang member with no linked PATV account is mapped to their automatic Camfrog ("CF…") account (Pepe's `find_or_create_user` at the export).

**Every treasury move is keyed and one site transaction.** This fixes the two-file moves the report found:

| Move | Before (two stores) | On the site |
|---|---|---|
| `!gang deposit` | wallet charge, then a JSON add | wallet debit + treasury leg, one transaction |
| `!gang withdraw` | JSON subtract, then the cut legs and a credit (journaled 1.99nk) | treasury leg + Fort Knox leg + wallet credit, one transaction, the allowance checked there |
| `!gang disband` | split journaled in `gangs["disbanded"]`, credits retried | treasury + released stakes split, wallet credits, dust → Reserve, one transaction |
| daily turf tick | `_fund` debits, JSON adds, `_route_pat`, one late gang save | ONE keyed move per gang and day (`turf-tick:<date>:<gid>`): incentives / tills → treasury, upkeep → routed, raid tax → Casino vault. Journaled in `turf_data.json` first; never computed twice |
| invasion seize / buy-ins | JSON add on the raid thread | journaled credit, sent by key (`gc-inv:<id>:seize`) |
| claim stake, fortify | JSON subtract | one synchronous keyed debit; no answer = not taken (reversed under `<key>:undo` if it landed) |
| room wars bonds / slices (1.99of) | `_gang_move_once` marks | the same keyed debit / journaled credit |

**The rule:** Pepe writes local gang state only while the switch is **explicitly** off (or no site is configured). With the switch on and the site down:
- every `!gang` change is refused ("publicaccess.tv isn't answering - nothing changed"); a money command whose answer was lost says "check !gang info";
- treasury debits are refused;
- treasury credits, rep and engine-field patches wait under their keys (supply shows the journaled credits as "on their way");
- `gang_data.json` is never written.

The only ways back are an admin **rollback** (the site answers) or **detach** (the site is gone).

## 0. When

- **After the pools cutover.** The site refuses the gang import while the pools still live in Pepe (`E_POOLS_LOCAL`), and refuses a pools rollback while the gangs are live (`E_GANGS_LIVE`).
- **Not** within 20 minutes of 04:00 UTC (the daily ticks); Pepe's dry run refuses then.
- **Not** within an hour of the Sunday 21:00 ET lotto draw (the draw's rep event would race the freeze).
- No heist, raid, claim, convoy job or season close running (Pepe's dry run refuses).
- The report's plan: the week after the pools cutover (2026-10-27 → 10-29), before London's season 4 ends (~10-31).

## 1. Preconditions

1. Code on prod: site ≥ `1ea6f33` (G1; its commit is labelled 1.99oo, a letter another change also used - the G1 pair is 1.99oq) + 1.99ow (this runbook, the phone layout), bot ≥ 1.99oq (`4bbe8a7`). Deploy the site first, then the bot.
2. The pools are live on prod (`!econ pools backend status` says "live on publicaccess.tv").
3. Both gang switches are OFF:
   - Pepe: `!gang backend status` says "the gangs live on Pepe (local)";
   - site (VPS, read-only): `sqlite3 /home/PATV/myapp.db "SELECT * FROM gangs_meta"` is empty, or `enabled=false`.
4. Nothing still paying: `!gang backend export` (the dry run) answers **ready**. It refuses while:
   - a gang has a withdrawal still being paid (`wd_pending`), or a disband payout is unfinished;
   - a season close is paying out, or a released stake is on its way to a treasury;
   - any member can't be mapped to a PATV account.

## 2. Backups

**Site DB** (VPS). Use `.backup` (WAL), never `cp`:

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-gangs-cutover-$TS.db"
```

The import also takes its own verified backup (`dbbackup.backupDb("pre-gangs-import")`).

**Pepe's files** (prod VM, PowerShell):

```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\gangs-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\gang_data.json, C:\PATV\camfrog-bot\turf_data.json, C:\PATV\camfrog-bot\casino_client.json $d
```

## 3. Record the "before" numbers

1. **Pepe:** write `{"action":"dryrun"}` to `C:\PATV\gangs-cutover.request.json`; read `C:\PATV\gangs-cutover.result.json` about 30 s later (or `!gang backend export`). Write down `gangs`, `members`, `treasury`, `rep` and `digest`.
2. **Supply:** `curl -s https://publicaccess.tv/api/stats/supply | jq '.total, (.rows[] | select(.key=="gangs"))'`.
3. **Site:** no gang rows: `sqlite3 /home/PATV/myapp.db "SELECT COUNT(*), COALESCE(SUM(balance),0) FROM pools WHERE key LIKE 'gang:%'"` → `0|0`.

## 4. Switch the site on

As an Admin, in a signed-in browser console on publicaccess.tv:

```
fetch('/api/admin/gangs-backend', {method:'POST', headers:{'content-type':'application/json','X-Requested-With':'fetch'}, body: JSON.stringify({on:true})}).then(r=>r.json())
```

or on the VPS: `sqlite3 /home/PATV/myapp.db "INSERT INTO gangs_meta (key,value) VALUES ('enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'"`.

**This writes to prod: the user's explicit go is needed.** It only lets Pepe import. Nothing moves yet.

## 5. Cutover

Run one of:
- `!gang backend cutover confirm` (an admin, in any room);
- `{"action":"cutover","actor":"<who>"}` in `C:\PATV\gangs-cutover.request.json`.

Pepe then:
1. **Freezes** gang commands (`🏴 the gangs are moving to publicaccess.tv right now`).
2. **Exports** `gang_data.json` (the Pepe-local journals `wd_pending` / `turf_marks` left out), every member's PATV account (`users`), the disband records, the casino rep keys he already applied (`casino_rep_done`), the treasury total for the supply row and his gang constants (`cfg`: the cut, the rank defaults, the upgrades, the time zone). sha256 + totals (`gangs`, `members`, `treasury`, `rep`). The export is kept as `gangs_export_<key>.json`, and `cutover_pending` is journaled in `gangs_client.json` (a crash re-sends the same export).
3. **POSTs** `/api/gangs/admin/import`. The site checks the switch, that the pools are live, the digest, the totals and that every member's account exists. It takes a verified backup. Then, in **one transaction**, it:
   - refreshes Pepe's "gangs" supply row from the export and reads the supply total;
   - writes the gangs, members (ranks from boss / officers / recruits) and the treasury rows (an `import:gangs:<key>` move);
   - applies the casino's unacked `casino_rep_queue` rows (except the keys Pepe already applied) as rep events and acks every row - the queue retires;
   - re-reads every gang and the totals, and reads the supply total again.

   It must match **to the PAT**, or it throws and rolls back (`ok:false`, nothing kept). The same key again answers the stored result.
4. **Compares** the site's totals with his own (rep may be higher by exactly the casino rep the import applied).
5. **Flips**: anything that moved locally since the snapshot goes up keyed (`cutover-<key>:tre:<gid>`, `cutover-<key>:rep:<gid>`); a changed roster aborts (roll back and retry). `gang_data.json` is kept as `gang_data.pre-site-<key>.json` and replaced by a "moved" marker; `gangs_client.json` `on: true`; the mirror is the site's state; Pepe pushes his gang constants (`/api/gangs/bot/config`).

The answer reads "DONE … totals matched". The result file has `"ok": true, "result": {"match": true}`.

## 6. Verify (read-only)

1. **Site:**
   ```
   sqlite3 /home/PATV/myapp.db "SELECT COUNT(*), SUM(rep) FROM gangs; SELECT COUNT(*) FROM gang_members; SELECT COALESCE(SUM(balance),0) FROM pools WHERE key LIKE 'gang:%'"
   sqlite3 /home/PATV/myapp.db "SELECT value FROM gangs_meta WHERE key IN ('live','imported')"
   ```
   They equal the dry run's totals (+ the delta). `live=true`.
2. **Supply:** `/api/stats/supply` `total` is unchanged; the "gangs" row now comes from the table.
3. **Pepe:** `!gang backend status` says "live on publicaccess.tv" with the same totals; `!gang info` and `!gangtop` show the same numbers; `gang_data.json` is the moved marker.
4. **Pages:** `/gtf/gangs` lists every gang; `/gtf/gangs/FAM` shows the roster, treasury, upgrades and war record.
5. **A live money path** (optional; the admin's own PAT): `!gang deposit 1000` in a gang, then `!gang withdraw 1000` (50 to Fort Knox): two `g:<key>` rows in `pool_moves`, the wallet and treasury rows match.

## 7. Rollback (while the site answers)

Run `!gang backend rollback confirm`, or the request `{"action":"rollback","actor":"<who>"}`. Pepe then:
1. freezes gang commands;
2. sends every journaled treasury move, queued rep and engine patch;
3. calls `/api/gangs/admin/rollback`. In one transaction the site moves every treasury to 0 under `rollback:gangs:<key>`, sets `live=false` and answers the full state (Pepe's `gang_data.json` shape) with its sha256 and totals. It takes a verified backup first;
4. checks the sha256, writes the answer as `gang_data.json` (the mirror object updated in place), and switches the client off.

A retry with the same key gets the same answer. A later cutover needs a **new** key (the import replaces the site's frozen copy). Rep earned on the site meanwhile comes back in the answer. While the gangs are local again, the casino queues rep for Pepe as before (its `casino_rep_queue` path is still there).

## 8. Detach (the site is gone for good)

Run `!gang backend detach confirm`. It is refused while the site answers and owns the gangs. The mirror (refreshed every 20 s and after every op, including the queued rep and the journaled credits) becomes `gang_data.json`; journaled moves with other legs are kept in `turf_data.json` `gang_outbox_detached` for a human. If the site comes back still owning the gangs, Pepe logs a **CONFLICT** and refuses gang commands until an admin decides.

## 9. The website

- `/gtf/gangs`: every gang by rep (level, crew / cap, treasury, war record, heat). Your gang is highlighted.
- `/gtf/gangs/<TAG>`: the roster with ranks, treasury, rep progress, upgrades, war record, the last treasury moves. A member manages it there (POST `/api/gangs/act`, signed in, same-site, keyed):
  - everyone: deposit / withdraw (their rank's allowance, the 5% fee to Fort Knox), leave;
  - officers and the boss: invite (a Camfrog name or PATV username), kick (officers: members only);
  - the boss: promote / demote, the daily allowance per rank;
  - an invitee: join / decline.
- Founding, upgrades, tags, disbanding and handing over the boss stay chat commands. Web moves aren't announced in chat.
- Before the cutover the pages say the gangs still live in Pepe and link his board.

## 10. What the prod cutover needs from the user

- The pools cutover done first (Phase 1).
- An explicit go for steps 4 and 5 (they write to prod), and the time window from §0.
- Whether to keep Pepe's Netlify gang board (`pepe.publicaccess.tv/gangs`) after the cutover: `!gangtop` already links `/gtf/gangs` once the gangs are on the site.

## 11. Staging rehearsal (2026-10-11, done)

On staging.publicaccess.tv (site G1 `1ea6f33`) and PepeBeta (VM 111, bot `4bbe8a7` 1.99oq, which passed probation), with the
staging pools already live (Phase 1 soak). Staging's `gang_data.json` was replaced, Pepe stopped, by a **fresh read-only
copy of prod's** (`scp` from VM 110, nothing written there): 11 gangs, 67 members, 949,407 PAT in treasuries, 18,221,300
rep. Every member was mapped to a PATV account on the staging DB (a prod copy) by `find_or_create_user`.

| Step | Result |
|---|---|
| dry run | ready, no problems; digest `4b81e0ab…a37` (the same digest the local end-to-end run of the real client against the real `gangs.js` computed from the same file) |
| cutover `gc-rehearsal-1` | **match: true** - site 11 / 67 / **949,407** / 18,221,300 = Pepe's; digest equal; supply **1,040,525,782 → 1,040,525,782** inside the import transaction; delta none; casino rep queue: nothing unacked |
| replay (backend, `gangs-replay.request.json`) | `!gang deposit 50k` (officer): treasury 999,407, wallet −50,000 · `!gang withdraw 20000` (boss): 1,000 to Fort Knox (14,999,550 → 15,000,550), 19,000 to the wallet · an officer's `withdraw 10000`: refused, today's 100,000 allowance already used (prod's own `withdrawn` for that day, kept) · `!gang limits recruit 20k` · rep +1,234 (batched) · a journaled credit +5,000 and a debit −2,000 (keyed) · a debit on a 0-PAT treasury: refused. FAM 949,407 → **982,407** = the sum of those moves; site, mirror and `!gang` totals equal; outbox empty |
| rollback `gr-rehearsal-1` | 11 gangs, **982,407** PAT and 18,222,534 rep back in `gang_data.json` exactly; site treasuries 0, `live` false; the pages say "still live in Pepe" |
| cutover again `gc-rehearsal-soak` | match: true; supply 1,040,528,782 → 1,040,528,782. **Staging left ON** for the soak |

Notes:
- The supply moved +3,000 across the replay: the replay's credit (+5,000) and debit (−2,000) stand for turf money Pepe holds (a stake, a claim), so their other side is his turf store.
- Right after the rollback the public supply lacked the "gangs" row until Pepe's next supply push (≤ 5 minutes; the pools runbook notes the same snapshot lag). The re-import refreshes that row itself, so its before / after were equal.
- The daily turf tick didn't run in the replay (turf is off in every staging room). It is covered by `gangstore_test.py` - the same tick local and on the site ends with every treasury, pool, till and the House equal, ONE keyed move per gang, never twice a day - and by the local end-to-end run against the real `gangs.js` with prod's file (cutover, commands, rep, heat patch, tick, claim debit, invasion credit, rollback: all matched).
