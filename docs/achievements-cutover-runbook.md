# Achievements cutover runbook: Pepe's counters → backend (Phase 5, 5.14)

The design is `docs/backend-migration-audit.md` §5.14 / Phase 5. The code:
- **site** `achprogress.js` (+ `achievements.awardLogin`, the `/api/g/achievement` hook, `loginrekey.js`);
- **bot** `pepe_achstore.py` (+ hooks in `pepe_achievements.py`, `pepe_loginrekey.py`, `pepe_backends.py`).

**What moves:** Pepe's `achievements_progress.json`: every login's counters (`m`), unlocks (`got`) and the other fields he keeps
on a record (`cmds`, `day`, `streak`, `shop`, `kit`, `stk`, `store`, ...), plus the top-level backfill flags (`_backfilled`,
`_bounty_backfill`, `_kit_backfill_v1`, `_store_backfill_v1`, `_shop_backfill_v2`). Records are keyed by the Camfrog login
(lower case) or `u:<userId>`, exactly as in the file; the site's login re-key (`loginrekey.js`) moves them like every other
login-keyed record.

**Who decides after it:** the SITE. Pepe keeps observing Camfrog (chat, mic, cams, commands, games - every `_ach_bump` /
`_ach_chat` / `_ach_command` / `_ach_reason` hook is unchanged) and sends **keyed metric events** in batches from his 30 s
tick. The site applies each event once, evaluates the thresholds of the metrics the event says were bumped (`check`) and
awards: the badge once per account (`user_badges`), the XP, and the PAT through `funding.fundPayout("achievements")` - the
incentive budget's **achievements group** (uncapped since 2026-10-12; queued in `reserve_claims` when the budget is short,
exactly as before). Pepe announces the loud awards in the room where the bump happened.

**What stays in Pepe:** everything that observes Camfrog; the quiet backfills (heist sheets, bounties, shop, store, kit) -
they still give their badges silently through `/api/g/achievement` and set counters directly, which the site stores but never
evaluates (a direct write has no `check`, so nothing is announced); `!achievements` (reads Pepe's mirror); the website feed
of web-side awards (`achievement_feed`, unchanged).

**Not changed:** the catalog (`achievements.json`), web-side achievements (`checkWeb`), the casino backend's counts
(`casino_ach_counts` → `awardCount`), any amount or threshold.

## The event

```
{key: "ach:<inst>:<seq>", login, m: {metric: ["<from>", "<to>"]}, set: {field: value | null}, got: [ids], check: [metrics]}
{key, login, del: true}            a record Pepe dropped
{key, rekey: {old, new}}           a login re-key (a no-op when the site already re-keyed it)
{key, flag, value}                 a top-level backfill flag
```

- A counter still at `from` becomes `to`; one at `to` stays; anything else gets `to - from` added (logged as "diverged").
  Values are exact decimal strings (staging's sandbox numbers pass 2^53).
- `held` (per batch) = the ids still waiting for a quiet backfill (`_ach_held_ids`) - never awarded loudly.
- The answer per key: `{awards: [...loud ones...], got: [ids now held], failed: [ids with no PATV account behind the login]}`.
  A replayed key answers the stored result (Pepe announces once: he drops the event from his outbox on the first answer).
- No account behind the login: nothing is given; the next bump of that metric tries again (as before).

**The rule:** Pepe never decides or writes local state while the switch is on. With the site down the events wait in
`achievements_client.json` (one per login, merged while unsent), nothing is awarded, `achievements_progress.json` is never
written (it is the cutover's "moved" marker). The only ways back are a **rollback** (the site answers) or a **detach**
(the site is gone).

## 0. When

- Any time outside a deploy; there is no money in the counters. Avoid the minute of a Monday epoch only because the
  incentive queue is busy then (`fundPayout` queues anyway).
- Not while another cutover runs (one hand-over at a time).

## 1. Preconditions

1. Code on prod: site ≥ 1.99to (`achprogress.js`), bot ≥ 1.99to (`pepe_achstore.py`). Deploy the site first, then the bot.
2. Both switches OFF:
   - Pepe: `!achievements backend status` says "live on Pepe (local)" (or the request file `{"action":"status"}` → `on: false`);
   - site (VPS, read-only): `sqlite3 /home/PATV/myapp.db "SELECT * FROM ach_progress_meta"` is empty or `enabled=false`.
3. The dry run is ready: request `{"action":"dryrun"}` (or `!achievements backend export`) → `ok: true`, `problems: []`.
   It refuses a record key that isn't a clean lower-case login, or a counter that isn't a number.

## 2. Backups

**Site DB** (VPS). Use `.backup` (WAL), never `cp`:

```
TS=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 /home/PATV/myapp.db ".backup /home/PATV-backups/myapp-pre-achievements-cutover-$TS.db"
```

The import also takes its own verified backup (`dbbackup.backupDb("pre-achievements-import")`).

**Pepe's file** (prod VM, PowerShell):

```
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $d = "C:\PATV\backups\achievements-cutover-$ts"; New-Item -ItemType Directory $d
Copy-Item C:\PATV\camfrog-bot\achievements_progress.json $d
```

## 3. Record the "before" numbers

1. **Pepe:** write `{"action":"dryrun"}` to `C:\PATV\achievements-cutover.request.json` (write the JSON locally and `scp` it -
   the prod VM blocks `.ps1` execution; use forward slashes in any path); read `C:\PATV\achievements-cutover.result.json`
   ~30 s later. Write down `users`, `got`, `metrics`, `value_sum`, `flags`, `digest`.
2. **Site:** `sqlite3 /home/PATV/myapp.db "SELECT COUNT(*) FROM ach_progress"` → `0` (or no such table).

## 4. Switch the site on

As an Admin in a signed-in browser console on publicaccess.tv:

```
fetch('/api/admin/achievements-backend', {method:'POST', headers:{'content-type':'application/json','X-Requested-With':'fetch'}, body: JSON.stringify({on:true})}).then(r=>r.json())
```

or on the VPS: `sqlite3 /home/PATV/myapp.db "INSERT INTO ach_progress_meta (key,value) VALUES ('enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'"`.

**This writes to prod: the user's explicit go is needed.** It only lets Pepe import. Nothing moves yet.

## 5. Cutover

Run one of:
- `!achievements backend on confirm` (an admin, in any room);
- `{"action":"cutover","key":"ac-<date>","actor":"<who>"}` in the request file.

Pepe then:
1. **Pauses awards** (bumps keep counting; the metrics they touch are remembered as checks).
2. **Exports** a snapshot of the store (sha256 + totals: people, unlocks, counter rows, the exact counter sum, flags), keeps
   it as `ach_export_<key>.json`, journals `pending_cutover` (a crash re-sends the SAME export with the same key).
3. **POSTs** `/api/achievements/admin/import`. The site checks the switch, that nothing is live, the digest and the totals,
   takes a verified backup, then in **one transaction** writes every record and counter and the flags, re-reads them and
   compares the totals. Any mismatch throws and rolls back (`ok:false`, nothing kept). The same key again answers the
   stored result.
4. **Compares every login** with the site's copy (`/api/achievements/bot/state`). A difference rolls the site back
   (`auto-<key>`) and the cutover fails - nothing changed on Pepe.
5. **Flips**: `achievements_client.json` `on: true`, the mirror = the live store; what moved since the snapshot (and the
   paused checks) goes up as the first events. `achievements_progress.json` is kept as
   `achievements_progress.pre-site-<key>.json` and replaced by the `_moved_to_site` marker.

The result file has `"ok": true, "result": {"match": true, ...}`.

## 6. Verify (read-only)

1. **Site:**
   ```
   sqlite3 /home/PATV/myapp.db "SELECT COUNT(*) FROM ach_progress; SELECT COUNT(*) FROM ach_metrics; SELECT value FROM ach_progress_meta WHERE key IN ('live','imported')"
   ```
   = the dry run's `users` / `metrics`; `live=true`.
2. **Pepe:** `!achievements backend status` says "live on publicaccess.tv" with the same totals; `!achievements` works.
3. **A live unlock** (optional): someone close to a threshold chats; one `ach_events` row has the award, `user_badges` gets it
   once, Pepe announces it once in that room.
4. `/admin/cosmetics` → "Achievement counters" says they live on the site.

## 7. Rollback (while the site answers)

`!achievements backend off confirm`, or the request `{"action":"rollback","key":"ar-<date>","actor":"<who>"}`. Pepe sends
every queued event first (refuses if any can't be sent), then `/api/achievements/admin/rollback`: in one transaction (after a
verified backup) the site hands the exact store back (text + sha256 + totals), empties its tables and sets `live=false`.
Pepe checks the sha256 and the totals, writes it as `achievements_progress.json` (the in-memory store updated in place) and
switches off. A retry with the same key gets the same answer. A later cutover needs a new key.

## 8. Detach (the site is gone for good)

`!achievements backend detach confirm`. Refused while the site answers and owns the counters. The mirror (with every bump
since) becomes `achievements_progress.json`; the unsent events are kept in `achievements_client.json` `detached_outbox`.
Awards Pepe never got an answer for are re-checked on the next bump of their metric, locally.

## 9. What the prod cutover needs from the user

- An explicit go for steps 4 and 5 (they write to prod).
- Nothing else: no money moves, no time window. The site pays the PAT exactly as before (the achievements group).

## 10. Staging rehearsal (2026-10-12, done)

On staging.publicaccess.tv (site 1.99to `691d6c5`, the staging DB a prod copy) and PepeBeta (VM 111, bot 1.99to `643254a`,
passed probation 16:29 ET). Staging's own `achievements_progress.json` was kept aside (`C:\PATV\backups\ach-staging-before-p5.json`)
and replaced by a **fresh read-only copy of prod's** (`scp` from VM 110 at 16:33 ET, sha256 `4d40f955…ed4a69`, nothing written
there) with the staging-only request action `stage_load` (in place, no restart).

| Step | Result |
|---|---|
| stage_load | 230 → **422** people, 1,727 unlocks, 3,879 counters, sum 606,174,469, 5 flags |
| dry run | ready, no problems; digest `cb1b8ff9…6fc98b` |
| cutover `ac-rehearsal-1` | **match: true** - site 422 / 1,727 / 3,879 / 606,174,469 / 5 = Pepe's, every login compared equal; delta events 0; site tables 422 records / 3,879 counter rows, `live=true` |
| live events (`C:\PATV\ach-inject.jsonl`, the real `_ach_chat` path) | fawn_bizkit 98 → 100 chat lines: ONE event, the site awarded **cf_chat_100 "Yapper" once** (+1,000 XP; the 10,000 PAT queued in the achievements group, `reserve_claims` incentives:achievements), Pepe announced it once in PepeLab; 3 more lines → 103, the next event `awards: []`, still one badge |
| rollback `ar-rehearsal-1` | 422 / **1,728** / 3,879 / **606,174,474** back on Pepe, sha256 checked, `same_as_mirror: true`; the file differs from the prod copy ONLY in fawn_bizkit (chat 103, + cf_chat_100, day); site tables emptied, `live=false` |
| cutover again `ac-rehearsal-soak` | match: true (422 / 1,728 / 3,879 / 606,174,474). **Staging left ON** for the soak |

Covered by tests rather than the rehearsal: the site down with the switch on (`achstore_test.py`: events wait, merge, land
once; the progress file never written), a login re-key while on, detach, a paused bump during the cutover, held ids, a
backfill's direct write staying quiet, exact decimals past 2^53 (`test/achprogress.test.js`).
